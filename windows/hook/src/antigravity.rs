//! Antigravity adapter.
//!
//! Antigravity app/IDE/CLI and the VS Code extension share `~/.gemini/config/hooks.json`.
//! This wrapper inspects the ancestor process tree, `ANTIGRAVITY_AGENTAPI_EXE`, environment,
//! and host metadata (never `toolCall` arguments) to distinguish Antigravity Desktop
//! (`antigravity`) from the Antigravity VS Code extension (`antigravity-vscode`),
//! logs the decision, and forwards the payload unchanged to `coucou-hook`.

use serde_json::Value;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const APP_AGENT: &str = "antigravity";
const VSCODE_AGENT: &str = "antigravity-vscode";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn main() {
    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    let payload = serde_json::from_slice::<Value>(&input).ok();
    let event = event_name(payload.as_ref());
    let agent = detect_agent(payload.as_ref());
    log_decision(&event, agent, payload.as_ref(), &input);

    // PostInvocation fires at the end of every internal LLM chunk (including at the exact
    // same millisecond as Stop) and carries no toolCall. Forwarding it races with Stop and
    // puts the pill back into "working" after the turn has already finished.
    if event.eq_ignore_ascii_case("PostInvocation") {
        let _ = std::io::stdout().write_all(br#"{}"#);
        return;
    }

    match forward(agent, &event, &input) {
        Ok(stdout) => {
            let _ = std::io::stdout().write_all(&stdout);
        }
        Err(err) => {
            log_line(format!(
                "forward failed event={event:?} agent={agent}: {err}"
            ));
            let fallback = if event.eq_ignore_ascii_case("PreToolUse") {
                br#"{"decision":"ask"}"#.as_slice()
            } else {
                br#"{}"#.as_slice()
            };
            let _ = std::io::stdout().write_all(fallback);
        }
    }
}

fn event_name(payload: Option<&Value>) -> String {
    let from_arg = std::env::args().skip(1).find(|arg| !arg.starts_with('-'));
    if let Some(event) = from_arg.filter(|arg| !arg.trim().is_empty()) {
        return event;
    }
    for key in [
        "hook_event_name",
        "hookEventName",
        "event",
        "event_name",
        "type",
    ] {
        if let Some(s) = payload.and_then(|p| p.get(key)).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

fn detect_agent(payload: Option<&Value>) -> &'static str {
    let env = |k: &str| std::env::var(k).ok();
    detect_agent_with(payload, &env, ancestor_host())
}

fn detect_agent_with(
    payload: Option<&Value>,
    env: &dyn Fn(&str) -> Option<String>,
    ancestor: Option<&'static str>,
) -> &'static str {
    // 1. Explicit binary path from Antigravity's language_server or git askpass.
    if let Some(agent) = classify_binary_env(env) {
        return agent;
    }
    // 2. Parent process tree on Windows (Code.exe vs Antigravity.exe).
    if let Some(agent) = ancestor {
        return agent;
    }
    // 3. Fallback environment variables or host metadata fields in the payload.
    if env_has_vscode_signal(env) || payload_has_vscode_signal(payload) {
        VSCODE_AGENT
    } else {
        APP_AGENT
    }
}

fn classify_binary_env(env: &dyn Fn(&str) -> Option<String>) -> Option<&'static str> {
    for key in ["ANTIGRAVITY_AGENTAPI_EXE", "VSCODE_GIT_ASKPASS_NODE"] {
        if let Some(val) = env(key) {
            let norm = val.replace('\\', "/").to_ascii_lowercase();
            if norm.contains("/.vscode/extensions/")
                || norm.contains("/code/extensions/")
                || norm.contains("google.google-antigravity")
                || norm.contains("microsoft vs code")
                || norm.ends_with("/code.exe")
                || norm.ends_with("/code - insiders.exe")
                || norm.ends_with("/vscodium.exe")
            {
                return Some(VSCODE_AGENT);
            }
            if norm.contains("/programs/antigravity/") || norm.ends_with("/antigravity.exe") {
                return Some(APP_AGENT);
            }
        }
    }
    None
}

#[cfg(windows)]
fn ancestor_host() -> Option<&'static str> {
    use std::collections::HashMap;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut procs: HashMap<u32, (u32, String)> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return None;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
                procs.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    let mut current = std::process::id();
    let mut seen = vec![current];
    for _ in 0..16 {
        let Some((parent, _)) = procs.get(&current) else {
            break;
        };
        let parent = *parent;
        if parent == 0 || seen.contains(&parent) {
            break;
        }
        seen.push(parent);
        let Some((_, exe)) = procs.get(&parent) else {
            break;
        };
        match exe.as_str() {
            "antigravity.exe" => return Some(APP_AGENT),
            "code.exe" | "code - insiders.exe" | "vscodium.exe" => return Some(VSCODE_AGENT),
            _ => {}
        }
        current = parent;
    }
    None
}

#[cfg(not(windows))]
fn ancestor_host() -> Option<&'static str> {
    None
}

fn env_has_vscode_signal(env: &dyn Fn(&str) -> Option<String>) -> bool {
    let keys = [
        "VSCODE_PID",
        "VSCODE_CWD",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "TERM_PROGRAM",
    ];
    keys.iter().any(|key| {
        env(key)
            .filter(|v| !v.trim().is_empty())
            .is_some_and(|v| *key != "TERM_PROGRAM" || contains_vscode_signal(&v))
    })
}

/// Inspects only host-level metadata fields in the payload — never `toolCall` or
/// `workspacePaths`, so editing a file or running a command that mentions "vscode"
/// inside Antigravity Desktop does not misroute the session to VS Code.
fn payload_has_vscode_signal(payload: Option<&Value>) -> bool {
    let Some(map) = payload.and_then(Value::as_object) else {
        return false;
    };
    for key in [
        "transcriptPath",
        "transcript_path",
        "artifactDirectoryPath",
        "artifact_directory_path",
        "ide",
        "host",
        "client",
        "coucou_agent",
    ] {
        if let Some(s) = map.get(key).and_then(Value::as_str) {
            if contains_vscode_signal(s) {
                return true;
            }
        }
    }
    false
}

fn contains_vscode_signal(text: &str) -> bool {
    let s = text.replace('\\', "/").to_ascii_lowercase();
    s.contains("vscode")
        || s.contains("visual studio code")
        || s.contains("/.vscode/extensions/")
        || s.contains("/code/extensions/")
        || s.contains("code.exe")
        || s.contains("google.google-antigravity")
        || s.contains("antigravity-vscode")
}

fn forward(agent: &str, event: &str, input: &[u8]) -> std::io::Result<Vec<u8>> {
    let hook = hook_exe();
    let mut cmd = Command::new(hook);
    cmd.arg("--agent")
        .arg(agent)
        .arg(event)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input)?;
    }
    let output = child.wait_with_output()?;
    Ok(output.stdout)
}

fn hook_exe() -> OsString {
    let name = if cfg!(windows) {
        "coucou-hook.exe"
    } else {
        "coucou-hook"
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let beside = parent.join(name);
            if beside.exists() {
                return beside.into_os_string();
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let path = PathBuf::from(local).join("Coucou").join("bin").join(name);
        if path.exists() {
            return path.into_os_string();
        }
    }
    OsString::from(name)
}

fn log_decision(event: &str, agent: &str, payload: Option<&Value>, input: &[u8]) {
    let workspace = payload
        .and_then(|p| p.get("workspace_paths").or_else(|| p.get("workspacePaths")))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    let transcript = payload
        .and_then(|p| p.get("transcript_path").or_else(|| p.get("transcriptPath")))
        .and_then(Value::as_str)
        .unwrap_or("");
    log_line(format!(
        "event={event:?} agent={agent} source={} bytes={} workspace={workspace:?} transcript={transcript:?}",
        if agent == VSCODE_AGENT { "vscode" } else { "app" },
        input.len()
    ));
}

fn log_line(line: String) {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let path = PathBuf::from(local)
        .join("Coucou")
        .join("antigravity-hook.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{} {line}", timestamp());
    }
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn desktop_agentapi_exe_routes_to_antigravity_even_if_tool_mentions_vscode() {
        let env = env_of(&[(
            "ANTIGRAVITY_AGENTAPI_EXE",
            r"C:\Users\power\AppData\Local\Programs\antigravity\resources\bin\language_server.exe",
        )]);
        let payload = json!({
            "conversationId": "conv-1",
            "workspacePaths": [r"C:\Users\power\Documents\Coucou-Unreal"],
            "toolCall": {
                "name": "run_command",
                "args": { "CommandLine": "code --version && echo vscode" }
            }
        });
        assert_eq!(
            detect_agent_with(Some(&payload), &env, None),
            "antigravity"
        );
    }

    #[test]
    fn vscode_extension_agentapi_exe_routes_to_antigravity_vscode() {
        let env = env_of(&[(
            "ANTIGRAVITY_AGENTAPI_EXE",
            r"c:\Users\power\.vscode\extensions\google.google-antigravity-1.7.0\bin\language_server.exe",
        )]);
        let payload = json!({ "conversationId": "conv-2" });
        assert_eq!(
            detect_agent_with(Some(&payload), &env, None),
            "antigravity-vscode"
        );
    }

    #[test]
    fn ancestor_process_distinguishes_desktop_and_vscode() {
        let empty = env_of(&[]);
        let payload = json!({
            "toolCall": { "name": "view_file", "args": { "AbsolutePath": "C:/repo/vscode.ts" } }
        });
        assert_eq!(
            detect_agent_with(Some(&payload), &empty, Some("antigravity")),
            "antigravity"
        );
        assert_eq!(
            detect_agent_with(Some(&payload), &empty, Some("antigravity-vscode")),
            "antigravity-vscode"
        );
    }
}
