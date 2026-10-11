use std::process::Stdio;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

use crate::island::WINDOW_LABEL;
use crate::settings::VpsConfig;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const STAT_PREFIX: &str = "__COUCOU_STAT__";
const STAT_CMD: &str = "G=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' '); [ -z \"$G\" ] && [ -r /sys/class/drm/card0/device/gpu_busy_percent ] && G=$(cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null); echo __COUCOU_STAT__ $(head -n 1 /proc/stat) $(grep -E '^(MemTotal|MemAvailable):' /proc/meminfo) GPU:${G:-NONE} $(df -P -k / | tail -n 1)\n";

#[derive(Default)]
pub struct VpsState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    session_seq: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    prev_cpu: Option<(u64, u64)>,
    status: VpsStatus,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VpsStatus {
    pub connected: bool,
    pub connecting: bool,
    pub host: String,
    pub last_line: String,
    pub error: Option<String>,
    pub cpu_percent: Option<f32>,
    pub gpu_percent: Option<f32>,
    pub gpu_used_mb: Option<u64>,
    pub gpu_total_mb: Option<u64>,
    pub ram_used_mb: Option<u64>,
    pub ram_total_mb: Option<u64>,
    pub ram_percent: Option<f32>,
    pub disk_used_gb: Option<f32>,
    pub disk_total_gb: Option<f32>,
    pub disk_percent: Option<f32>,
}

impl Default for VpsStatus {
    fn default() -> Self {
        Self {
            connected: false,
            connecting: false,
            host: String::new(),
            last_line: String::new(),
            error: None,
            cpu_percent: None,
            gpu_percent: None,
            gpu_used_mb: None,
            gpu_total_mb: None,
            ram_used_mb: None,
            ram_total_mb: None,
            ram_percent: None,
            disk_used_gb: None,
            disk_total_gb: None,
            disk_percent: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VpsOutput {
    chunk: String,
}

fn lock(state: &VpsState) -> std::sync::MutexGuard<'_, Inner> {
    state.inner.lock().unwrap_or_else(PoisonError::into_inner)
}

fn emit_status(app: &AppHandle, status: &VpsStatus) {
    let _ = app.emit_to(WINDOW_LABEL, "vps-status", status);
}

fn emit_output(app: &AppHandle, chunk: String) {
    let _ = app.emit_to(WINDOW_LABEL, "vps-output", VpsOutput { chunk });
}

fn target(cfg: &VpsConfig) -> String {
    let host = cfg.host.trim();
    let user = cfg.user.trim();
    let alias = cfg.alias.trim();
    if host.is_empty() && !alias.is_empty() {
        return alias.to_string();
    }
    let host = if host.is_empty() { "100.96.41.47" } else { host };
    let user = if user.is_empty() { "alex" } else { user };
    format!("{user}@{host}")
}

fn key_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return Some(
                std::path::PathBuf::from(home)
                    .join(rest)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    Some(raw.to_string())
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

fn parse_stat_line(line: &str, prev_cpu: &mut Option<(u64, u64)>, status: &mut VpsStatus) {
    let mut tokens = Vec::new();
    for tok in line.split_whitespace() {
        if let Some(gpu_raw) = tok.strip_prefix("GPU:") {
            if gpu_raw != "NONE" && !gpu_raw.is_empty() {
                let parts: Vec<&str> = gpu_raw.split(',').collect();
                if let Some(pct) = parts.first().and_then(|s| s.parse::<f32>().ok()) {
                    status.gpu_percent = Some(round1(pct.clamp(0.0, 100.0)));
                }
                if let (Some(used), Some(total)) = (
                    parts.get(1).and_then(|s| s.parse::<u64>().ok()),
                    parts.get(2).and_then(|s| s.parse::<u64>().ok()),
                ) {
                    status.gpu_used_mb = Some(used);
                    status.gpu_total_mb = Some(total);
                }
            } else {
                status.gpu_percent = None;
                status.gpu_used_mb = None;
                status.gpu_total_mb = None;
            }
        } else {
            tokens.push(tok);
        }
    }
    if tokens.is_empty() {
        return;
    }

    if let Some(cpu_idx) = tokens.iter().position(|&t| t == "cpu") {
        let mut nums = Vec::new();
        for &tok in &tokens[cpu_idx + 1..] {
            if let Ok(n) = tok.parse::<u64>() {
                nums.push(n);
            } else {
                break;
            }
        }
        if nums.len() >= 4 {
            let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
            let total: u64 = nums.iter().sum();
            if let Some((prev_total, prev_idle)) = *prev_cpu {
                let total_d = total.saturating_sub(prev_total);
                let idle_d = idle.saturating_sub(prev_idle);
                if total_d > 0 {
                    let busy = total_d.saturating_sub(idle_d);
                    let pct = (busy as f32 / total_d as f32) * 100.0;
                    status.cpu_percent = Some(round1(pct.clamp(0.0, 100.0)));
                }
            }
            *prev_cpu = Some((total, idle));
        }
    }

    let mut mem_total_kb: Option<u64> = None;
    let mut mem_avail_kb: Option<u64> = None;
    for window in tokens.windows(2) {
        match window[0] {
            "MemTotal:" => mem_total_kb = window[1].parse::<u64>().ok(),
            "MemAvailable:" => mem_avail_kb = window[1].parse::<u64>().ok(),
            _ => {}
        }
    }
    if let (Some(total_kb), Some(avail_kb)) = (mem_total_kb, mem_avail_kb) {
        if total_kb > 0 {
            let used_kb = total_kb.saturating_sub(avail_kb);
            status.ram_total_mb = Some(total_kb / 1024);
            status.ram_used_mb = Some(used_kb / 1024);
            let pct = (used_kb as f32 / total_kb as f32) * 100.0;
            status.ram_percent = Some(round1(pct.clamp(0.0, 100.0)));
        }
    }

    if tokens.len() >= 5 {
        let len = tokens.len();
        if let (Ok(total_kb), Ok(used_kb)) = (
            tokens[len - 5].parse::<u64>(),
            tokens[len - 4].parse::<u64>(),
        ) {
            if total_kb > 0 {
                status.disk_total_gb = Some(round1(total_kb as f32 / (1024.0 * 1024.0)));
                status.disk_used_gb = Some(round1(used_kb as f32 / (1024.0 * 1024.0)));
                let pct = (used_kb as f32 / total_kb as f32) * 100.0;
                status.disk_percent = Some(round1(pct.clamp(0.0, 100.0)));
            }
        }
    }
}

async fn pump<R: AsyncRead + Unpin + Send + 'static>(
    app: AppHandle,
    reader: R,
    seq: u64,
    is_stdout: bool,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(rest) = line.trim().strip_prefix(STAT_PREFIX) {
            let status_snapshot = {
                let state = app.state::<VpsState>();
                let mut inner = lock(&state);
                if inner.session_seq != seq {
                    break;
                }
                let mut status = inner.status.clone();
                let mut prev_cpu = inner.prev_cpu;
                parse_stat_line(rest, &mut prev_cpu, &mut status);
                status.connected = true;
                status.connecting = false;
                status.error = None;
                inner.prev_cpu = prev_cpu;
                inner.status = status.clone();
                status
            };
            emit_status(&app, &status_snapshot);
            continue;
        }

        let clean = sanitize(&line);
        let status_snapshot = {
            let state = app.state::<VpsState>();
            let mut inner = lock(&state);
            if inner.session_seq != seq {
                break;
            }
            if !clean.trim().is_empty() {
                inner.status.last_line = clean.trim().to_string();
            }
            inner.status.connected = true;
            inner.status.connecting = false;
            inner.status.error = None;
            inner.status.clone()
        };
        emit_output(&app, format!("{clean}\n"));
        emit_status(&app, &status_snapshot);
    }

    if is_stdout {
        let maybe_status = {
            let state = app.state::<VpsState>();
            let mut inner = lock(&state);
            if inner.session_seq == seq {
                inner.status.connected = false;
                inner.status.connecting = false;
                inner.stdin = None;
                inner.child = None;
                Some(inner.status.clone())
            } else {
                None
            }
        };
        if let Some(status) = maybe_status {
            emit_status(&app, &status);
        }
    }
}

async fn send_raw(app: &AppHandle, seq: u64, data: &[u8]) -> bool {
    let mut stdin = {
        let state = app.state::<VpsState>();
        let mut inner = lock(&state);
        if inner.session_seq != seq {
            return false;
        }
        inner.stdin.take()
    };
    let Some(mut pipe) = stdin.take() else {
        return false;
    };
    let ok = pipe.write_all(data).await.is_ok() && pipe.flush().await.is_ok();
    let state = app.state::<VpsState>();
    let mut inner = lock(&state);
    if inner.session_seq == seq && ok {
        inner.stdin = Some(pipe);
        true
    } else {
        false
    }
}

fn session_active(app: &AppHandle, seq: u64) -> bool {
    let state = app.state::<VpsState>();
    let inner = lock(&state);
    inner.session_seq == seq && (inner.status.connected || inner.status.connecting)
}

async fn stats_loop(app: AppHandle, seq: u64) {
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = send_raw(&app, seq, STAT_CMD.as_bytes()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = send_raw(&app, seq, STAT_CMD.as_bytes()).await;
    let mut ticker = tokio::time::interval(Duration::from_secs(4));
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if !session_active(&app, seq) {
            break;
        }
        let _ = send_raw(&app, seq, STAT_CMD.as_bytes()).await;
    }
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&nc) {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn sanitize(line: &str) -> String {
    let stripped = strip_ansi(line);
    let lower = stripped.to_lowercase();
    if lower.contains("password") || lower.contains("token") || lower.contains("secret") {
        return "[redacted]".into();
    }
    stripped.chars().take(2000).collect()
}

pub async fn connect(
    app: AppHandle,
    state: tauri::State<'_, VpsState>,
    cfg: VpsConfig,
) -> Result<VpsStatus, String> {
    disconnect(state.clone()).await;
    let host_label = cfg.alias.trim();
    let host_label = if host_label.is_empty() {
        target(&cfg)
    } else {
        host_label.to_string()
    };
    let seq = {
        let mut inner = lock(&state);
        inner.session_seq = inner.session_seq.wrapping_add(1);
        inner.prev_cpu = None;
        inner.status = VpsStatus {
            connected: false,
            connecting: true,
            host: host_label.clone(),
            last_line: String::new(),
            error: None,
            ..VpsStatus::default()
        };
        emit_status(&app, &inner.status);
        inner.session_seq
    };

    let mut cmd = Command::new("ssh");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=2")
        .arg("-p")
        .arg(cfg.port.to_string());
    if let Some(path) = key_path(&cfg.key_path) {
        cmd.arg("-i").arg(path);
    }
    cmd.arg(target(&cfg))
        .arg("sh")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let err_msg = format!("ssh failed: {e}");
            let mut inner = lock(&state);
            inner.status.connected = false;
            inner.status.connecting = false;
            inner.status.error = Some(err_msg.clone());
            emit_status(&app, &inner.status);
            return Err(err_msg);
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    {
        let mut inner = lock(&state);
        inner.stdin = stdin;
        inner.child = Some(child);
        inner.status.connected = true;
        inner.status.connecting = false;
        inner.status.error = None;
        inner.status.host = host_label;
    }
    if let Some(stdout) = stdout {
        tauri::async_runtime::spawn(pump(app.clone(), stdout, seq, true));
    }
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(pump(app.clone(), stderr, seq, false));
    }
    tauri::async_runtime::spawn(stats_loop(app.clone(), seq));

    let status = lock(&state).status.clone();
    emit_status(&app, &status);
    Ok(status)
}

pub async fn ensure_connected(app: AppHandle) {
    let (already_active, seq, cfg) = {
        let Some(state) = app.try_state::<VpsState>() else {
            return;
        };
        let Some(shared) = app.try_state::<crate::Shared>() else {
            return;
        };
        let cfg = shared.settings.lock().unwrap().vps_config.clone();
        let inner = lock(&state);
        (
            inner.status.connected || inner.status.connecting,
            inner.session_seq,
            cfg,
        )
    };
    if already_active {
        let _ = send_raw(&app, seq, STAT_CMD.as_bytes()).await;
        return;
    }
    let state = app.state::<VpsState>();
    let _ = connect(app.clone(), state, cfg).await;
}

pub async fn disconnect(state: tauri::State<'_, VpsState>) {
    let mut child = {
        let mut inner = lock(&state);
        inner.session_seq = inner.session_seq.wrapping_add(1);
        inner.stdin = None;
        inner.prev_cpu = None;
        inner.child.take()
    };
    if let Some(child) = child.as_mut() {
        let _ = child.kill().await;
    }
    let mut inner = lock(&state);
    inner.status.connected = false;
    inner.status.connecting = false;
}

pub async fn write(state: tauri::State<'_, VpsState>, data: String) -> Result<(), String> {
    let mut stdin = {
        let mut inner = lock(&state);
        inner.stdin.take()
    };
    let Some(mut stdin) = stdin.take() else {
        return Err("VPS is not connected".into());
    };
    let result = match stdin.write_all(data.as_bytes()).await {
        Ok(()) => stdin.flush().await.map_err(|e| format!("flush failed: {e}")),
        Err(e) => Err(format!("write failed: {e}")),
    };
    let mut inner = lock(&state);
    inner.stdin = Some(stdin);
    result
}

pub fn status(state: tauri::State<'_, VpsState>) -> VpsStatus {
    lock(&state).status.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_stat_meminfo_gpu_and_df_from_srv() {
        let mut prev_cpu = None;
        let mut status = VpsStatus::default();
        let sample1 = "cpu 9072083 4557 3673940 927508229 12478450 0 154550 0 0 0 MemTotal: 8075340 kB MemAvailable: 5454704 kB GPU:NONE /dev/sda2 1905208664 516998604 1291356968 29% /";
        parse_stat_line(sample1, &mut prev_cpu, &mut status);

        assert!(prev_cpu.is_some());
        assert_eq!(status.cpu_percent, None);
        assert_eq!(status.gpu_percent, None);
        assert_eq!(status.ram_total_mb, Some(7886));
        assert_eq!(status.ram_used_mb, Some(2559));
        assert_eq!(status.ram_percent, Some(32.5));
        assert_eq!(status.disk_total_gb, Some(1816.9));
        assert_eq!(status.disk_used_gb, Some(493.0));
        assert_eq!(status.disk_percent, Some(27.1));

        let sample2 = "cpu 9072183 4557 3673990 927509079 12478450 0 154550 0 0 0 MemTotal: 8075340 kB MemAvailable: 5454704 kB GPU:35,2048,8192 /dev/sda2 1905208664 516998604 1291356968 29% /";
        parse_stat_line(sample2, &mut prev_cpu, &mut status);
        // busy delta = 150, idle delta = 850, total delta = 1000 => 15.0%
        assert_eq!(status.cpu_percent, Some(15.0));
        assert_eq!(status.gpu_percent, Some(35.0));
        assert_eq!(status.gpu_used_mb, Some(2048));
        assert_eq!(status.gpu_total_mb, Some(8192));
    }

    #[test]
    fn strips_ansi_and_redacts_secrets() {
        assert_eq!(sanitize("\x1b[32mhello\x1b[0m world"), "hello world");
        assert_eq!(sanitize("my secret key"), "[redacted]");
    }
}
