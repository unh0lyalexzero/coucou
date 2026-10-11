// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { isComingSoon, pillDefinition } from "../core/pills";
import { refreshHookPills } from "../island/integrations";
import { readActivity, readPulse, readStats } from "../core/github";
import { githubDetail, githubPulseCard } from "./github";
import { N_, language, t } from "../i18n/i18n";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return t("just now");
  if (diff < 3600) return t("{n}m", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n}h", { n: Math.floor(diff / 3600) });
  return t("{n}d", { n: Math.floor(diff / 86400) });
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_paypal: "https://www.paypal.com/mep/dashboard",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** IntegrationCardView.statusLabel on macOS. */
export function idleStatus(
  id: string,
  info: { configured: boolean; error: string | null } | undefined,
  chatModel: string,
): { label: string; color: string } {
  if (isComingSoon(id)) return { label: t("Coming soon"), color: "#6B7079" };
  if (info?.error) return { label: info.error, color: "#F4505E" };
  const configured = info?.configured ?? false;
  const def = pillDefinition(id);
  const ok = (label: string) => ({ label, color: "#22C55E" });
  const missing = (label: string) => ({ label, color: "#F4505E" });
  // Pills driven by hooks never have a key: they are connected once the hooks
  // are in place (Mac #183). A session replaces this card; nothing is loading.
  if (def?.connect.kind === "hooks") return configured ? ok(t("Hooks installed")) : missing(t("Hooks not installed"));
  if (def?.connect.kind === "none") return ok(t("Ready · no setup needed"));
  if (def?.connect.kind === "server") return configured ? ok(t("Connected")) : missing(t("Not connected"));
  if (def?.category === "ai") {
    if (!configured) return missing(t("Key not configured"));
    return ok(id === "ai_anthropic" ? t("Key configured · {model}", { model: chatModel }) : t("Key configured"));
  }
  return configured ? ok(t("Connected · loading…")) : missing(t("Key not configured"));
}

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const def = pillDefinition(task.id);
  const status = idleStatus(task.id, info, State.settings.model);

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: t("Open Visual Studio Code"),
        onclick: () => void Bridge.openInVSCode(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "agent_claude-desktop") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open Claude"),
        onclick: () => void Bridge.openClaudeDesktop(),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open {name}", { name: "n8n" }),
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open {name}", { name: task.name }),
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  const hookPill = def?.connect.kind === "hooks";
  if (isComingSoon(task.id) || def?.connect.kind === "none") {
    // Nothing to set up, and nothing to refresh.
  } else if (configured && (hookPill || def?.category !== "ai")) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Refresh"),
        // A hook pill has nothing to poll: look at its hooks again instead.
        onclick: () => void (hookPill ? refreshHookPills() : Bridge.refreshIntegration(task.id)),
      }),
    );
  } else if (!configured) {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: t("Settings…"), onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(
      task.color,
      task.id === "integration_claude" ? "VS Code" : task.name,
      t(def?.subtitle ?? N_("Integration")),
    ),
    h("div", { class: "int-status" }, dot(status.color, 5), h("span", { text: status.label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: t("Details"), onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", t("Deployments")), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? t("Ready") : d.state === "CANCELED" ? t("Canceled") : t("Error");
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: t("{time} ago", { time: timeAgo(d.createdAt) }) }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? t("Deployment")) }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", t("Emails"), extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", t("Overview")),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", t("Total stars"), fmt(stars)),
      statRow(ICONS.stack, "#6B7079", t("Repositories"), String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? t("Payment")) }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", t("Payments")),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── PayPal ───────────────────────────────────────────────────────────────────

function currencyRank(code: unknown): number {
  switch (String(code ?? "").toUpperCase()) {
    case "USD":
      return 5;
    case "EUR":
      return 4;
    case "GBP":
      return 3;
    case "CAD":
    case "MXN":
      return 2;
    case "AUD":
      return 1;
    default:
      return 0;
  }
}

function paypalCard(): HTMLElement {
  const d = get("integration_paypal");
  const balances = arr("integration_paypal", "balances")
    .slice()
    .sort((a, b) => {
      const aNum = Math.abs(Number(a.amount ?? 0));
      const bNum = Math.abs(Number(b.amount ?? 0));
      if ((aNum > 0) !== (bNum > 0)) return bNum > 0 ? 1 : -1;
      if (Boolean(a.primary) !== Boolean(b.primary)) return b.primary ? 1 : -1;
      const rankDiff = currencyRank(b.currency) - currencyRank(a.currency);
      if (rankDiff !== 0) return rankDiff;
      return bNum - aNum;
    });
  const primary = balances[0] ?? {};
  const amount = String(primary.amount ?? "0.00");
  const currency = String(primary.currency ?? "USD").toUpperCase();
  const secondary = balances.slice(1, 3);
  const isSandbox = d.environment === "sandbox";
  const balanceError = typeof d.balanceError === "string" && d.balanceError ? d.balanceError : null;
  const balancePending = d.balancePending === true;
  const lastRefreshRaw = typeof d.lastRefreshTime === "string" ? d.lastRefreshTime : "";
  const refreshBtn = h(
    "button",
    {
      class: "int-more",
      title: t("Refresh"),
      onclick: () => void Bridge.refreshIntegration("integration_paypal"),
    },
    svg(ICONS.arrowClockwise, 8, { stroke: 2.2 }),
  );
  const rows = h("div", { class: "int-rows tight" });
  if (isSandbox) {
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#F5A524", 5),
        h("span", { class: "int-name", style: "color:#f5a524", text: "Sandbox · Usa claves Live para tu saldo real" }),
      ),
    );
  }
  if (balancePending && balances.length === 0) {
    rows.append(
      h(
        "div",
        { class: "int-row", title: "PayPal tarda entre 1 y 3 horas en activar el reporte tras marcar Transaction Search en Live" },
        dot("#009CDE", 5),
        h("span", { class: "int-name", style: "color:#8e939c", text: "Live conectado · PayPal indexando saldo (1–3h)" }),
      ),
    );
  } else if (balanceError && balances.length === 0) {
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#F4505E", 5),
        h("span", { class: "int-name", style: "color:#f4505e", text: balanceError }),
      ),
    );
  }
  const payments = arr("integration_paypal", "payments");
  for (const p of payments) {
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#22C55E", 5),
        h("span", { class: "int-name", text: String(p.description ?? t("Payment")) }),
        h("span", { class: "int-amount", style: "color:#22c55e", text: String(p.amount ?? "") }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  const allZero = balances.every((b) => Math.abs(Number(b.amount ?? 0)) < 0.0001);
  if (payments.length === 0 && !balanceError && !balancePending && !isSandbox) {
    if (allZero && lastRefreshRaw) {
      const dt = new Date(lastRefreshRaw);
      const hm = Number.isNaN(dt.getTime())
        ? ""
        : dt.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
      rows.append(
        h(
          "div",
          {
            class: "int-row",
            title: "El endpoint Reporting de PayPal actualiza saldos por lotes cada 1–3 horas tras activar Transaction Search",
          },
          dot("#009CDE", 5),
          h("span", {
            class: "int-name",
            style: "color:#8e939c",
            text: hm ? `Corte PayPal ${hm} · Sincronizando próximo lote` : t("No recent payments"),
          }),
        ),
      );
    } else {
      rows.append(h("div", { class: "int-empty", text: t("No recent payments") }));
    }
  }
  const balanceRow = h("div", { class: "int-balance" }, h("span", { text: amount }), h("i", { text: currency }));
  for (const sec of secondary) {
    const secAmt = String(sec.amount ?? "0.00");
    const secCur = String(sec.currency ?? "").toUpperCase();
    if (secCur) {
      balanceRow.append(
        h("span", {
          style: "margin-left:8px;font-size:10px;font-weight:500;color:#8e939c",
          text: `· ${secAmt} ${secCur}`,
        }),
      );
    }
  }
  return h(
    "div",
    { class: "int-card" },
    header("#009CDE", "PayPal", isSandbox ? "Sandbox" : t("Wallet"), refreshBtn),
    balanceRow,
    rows,
  );
}

// ── VPS ──────────────────────────────────────────────────────────────────────

const vpsCmdHistory: string[] = [];
let vpsHistoryIdx = -1;

interface VpsViewModel {
  connected: boolean;
  connecting: boolean;
  host: string;
  accent: string;
  statusText: string;
  cpuText: string;
  cpuWidth: number;
  cpuColor: string;
  gpuText: string;
  gpuWidth: number;
  gpuColor: string;
  ramText: string;
  ramWidth: number;
  ramColor: string;
  diskText: string;
  diskWidth: number;
  diskColor: string;
  miniStats: string;
  outputText: string;
}

function readVpsViewModel(): VpsViewModel {
  const data = get("integration_vps");
  const status = data.status as {
    connected?: boolean;
    connecting?: boolean;
    host?: string;
    lastLine?: string;
    cpuPercent?: number | null;
    gpuPercent?: number | null;
    gpuUsedMb?: number | null;
    gpuTotalMb?: number | null;
    ramUsedMb?: number | null;
    ramTotalMb?: number | null;
    ramPercent?: number | null;
    diskUsedGb?: number | null;
    diskTotalGb?: number | null;
    diskPercent?: number | null;
  } | undefined;

  const connected = status?.connected === true;
  const connecting = status?.connecting === true;
  const host = String(status?.host || State.settings.vpsConfig.alias || State.settings.vpsConfig.host || "srv");
  const accent = connected ? "#22C55E" : connecting ? "#F5A524" : "#6B7079";
  const statusText = connected ? t("Connected") : connecting ? t("Connecting…") : t("Disconnected");

  const cpuPct = typeof status?.cpuPercent === "number" ? status.cpuPercent : null;
  const cpuWidth = Math.max(0, Math.min(100, cpuPct ?? 0));
  const cpuColor = (cpuPct ?? 0) > 85 ? "#F4505E" : (cpuPct ?? 0) > 65 ? "#F5A524" : "#06B6D4";
  const cpuText = cpuPct != null ? `${cpuPct.toFixed(1)}%` : connected ? "…" : "—";

  const gpuPct = typeof status?.gpuPercent === "number" ? status.gpuPercent : null;
  const gpuUsedMb = typeof status?.gpuUsedMb === "number" ? status.gpuUsedMb : null;
  const gpuTotalMb = typeof status?.gpuTotalMb === "number" ? status.gpuTotalMb : null;
  const gpuWidth = Math.max(0, Math.min(100, gpuPct ?? 0));
  const gpuColor = (gpuPct ?? 0) > 85 ? "#F4505E" : (gpuPct ?? 0) > 65 ? "#F5A524" : "#3B82F6";
  const gpuText =
    gpuPct != null
      ? gpuUsedMb != null && gpuTotalMb != null && gpuTotalMb > 0
        ? `${(gpuUsedMb / 1024).toFixed(1)}/${(gpuTotalMb / 1024).toFixed(1)}G (${Math.round(gpuPct)}%)`
        : `${gpuPct.toFixed(1)}%`
      : connected
        ? "0% (N/A)"
        : "—";

  const ramPct = typeof status?.ramPercent === "number" ? status.ramPercent : null;
  const ramUsedMb = typeof status?.ramUsedMb === "number" ? status.ramUsedMb : null;
  const ramTotalMb = typeof status?.ramTotalMb === "number" ? status.ramTotalMb : null;
  const ramWidth = Math.max(0, Math.min(100, ramPct ?? 0));
  const ramColor = (ramPct ?? 0) > 85 ? "#F4505E" : (ramPct ?? 0) > 70 ? "#F5A524" : "#22C55E";
  const ramText =
    ramUsedMb != null && ramTotalMb != null
      ? `${(ramUsedMb / 1024).toFixed(1)}/${(ramTotalMb / 1024).toFixed(1)}G (${Math.round(ramPct ?? 0)}%)`
      : connected
        ? "…"
        : "—";

  const diskPct = typeof status?.diskPercent === "number" ? status.diskPercent : null;
  const diskUsedGb = typeof status?.diskUsedGb === "number" ? status.diskUsedGb : null;
  const diskTotalGb = typeof status?.diskTotalGb === "number" ? status.diskTotalGb : null;
  const diskWidth = Math.max(0, Math.min(100, diskPct ?? 0));
  const diskColor = (diskPct ?? 0) > 85 ? "#F4505E" : (diskPct ?? 0) > 75 ? "#F5A524" : "#A855F7";
  const diskText =
    diskUsedGb != null && diskTotalGb != null
      ? `${Math.round(diskUsedGb)}/${Math.round(diskTotalGb)}G (${Math.round(diskPct ?? 0)}%)`
      : connected
        ? "…"
        : "—";

  const miniStats = `CPU ${cpuPct != null ? `${Math.round(cpuPct)}%` : "—"} · GPU ${gpuPct != null ? `${Math.round(gpuPct)}%` : "0%"} · RAM ${ramPct != null ? `${Math.round(ramPct)}%` : "—"} · DSK ${diskPct != null ? `${Math.round(diskPct)}%` : "—"}`;

  const buffer = Array.isArray(data.buffer) ? (data.buffer as string[]) : [];
  const rawOut = buffer.join("").slice(-6000);
  const outputText = rawOut || (connected ? `ssh ${host} — ready. Type a command below.\n` : t("No output yet."));

  return {
    connected,
    connecting,
    host,
    accent,
    statusText,
    cpuText,
    cpuWidth,
    cpuColor,
    gpuText,
    gpuWidth,
    gpuColor,
    ramText,
    ramWidth,
    ramColor,
    diskText,
    diskWidth,
    diskColor,
    miniStats,
    outputText,
  };
}

function releaseVpsFocus() {
  void Bridge.focusWindow(false);
  if (!State.pendingApproval) {
    State.isPinned = false;
  }
}

function appendVpsEcho(line: string) {
  const info = State.integrations.integration_vps ?? { data: {}, error: null, loaded: true, configured: true };
  const buffer = Array.isArray(info.data.buffer) ? [...(info.data.buffer as string[])] : [];
  buffer.push(line);
  while (buffer.length > 200) buffer.shift();
  info.data = { ...info.data, buffer };
  State.integrations.integration_vps = info;
  State.notify();
}

export function syncVpsCard(container: HTMLElement, _task: AgentTask) {
  const vm = readVpsViewModel();

  const hostEl = container.querySelector<HTMLElement>('[data-vps="host"]');
  if (hostEl) hostEl.textContent = `ssh ${vm.host}`;

  const dotEl = container.querySelector<HTMLElement>('[data-vps="status-dot"]');
  if (dotEl) dotEl.style.background = vm.accent;

  const statusTextEl = container.querySelector<HTMLElement>('[data-vps="status-text"]');
  if (statusTextEl) statusTextEl.textContent = vm.statusText;

  const setMeter = (prefix: string, width: number, color: string, text: string) => {
    const fill = container.querySelector<HTMLElement>(`[data-vps="${prefix}-fill"]`);
    if (fill) {
      fill.style.width = `${width}%`;
      fill.style.background = color;
    }
    const val = container.querySelector<HTMLElement>(`[data-vps="${prefix}-val"]`);
    if (val) val.textContent = text;
  };

  setMeter("cpu", vm.cpuWidth, vm.cpuColor, vm.cpuText);
  setMeter("gpu", vm.gpuWidth, vm.gpuColor, vm.gpuText);
  setMeter("ram", vm.ramWidth, vm.ramColor, vm.ramText);
  setMeter("disk", vm.diskWidth, vm.diskColor, vm.diskText);

  const miniStatsEl = container.querySelector<HTMLElement>('[data-vps="mini-stats"]');
  if (miniStatsEl) miniStatsEl.textContent = vm.miniStats;

  const connectBtn = container.querySelector<HTMLButtonElement>('[data-vps="connect-btn"]');
  if (connectBtn) connectBtn.textContent = vm.connected ? t("Refresh") : t("Connect");

  const pre = container.querySelector<HTMLElement>('[data-vps="term-output"]');
  if (pre && pre.textContent !== vm.outputText) {
    pre.textContent = vm.outputText;
    pre.scrollTop = pre.scrollHeight;
  }
}

function vpsCard(task: AgentTask, detailOpen: boolean, onDetail: () => void, onBack: () => void): HTMLElement {
  const vm = readVpsViewModel();

  const openInlineTerminal = () => {
    if (!vm.connected && !vm.connecting) {
      void Bridge.vpsConnect();
    }
    onDetail();
  };

  if (!detailOpen) {
    const statusDot = dot(vm.accent, 5);
    statusDot.setAttribute("data-vps", "status-dot");

    const headRight = h(
      "div",
      { class: "vps-head-right" },
      h(
        "span",
        { class: "vps-status-chip" },
        statusDot,
        h("span", { "data-vps": "status-text", text: vm.statusText }),
      ),
      h("button", {
        class: "vps-term-open-btn",
        title: `ssh ${vm.host}`,
        text: `>_ ${t("Terminal")}`,
        onclick: openInlineTerminal,
      }),
    );

    const meterRow = (key: string, label: string, width: number, color: string, text: string) =>
      h(
        "div",
        { class: "vps-meter-row" },
        h("span", { class: "vps-meter-label", text: label }),
        h(
          "div",
          { class: "vps-meter-track" },
          h("div", {
            class: "vps-meter-fill",
            "data-vps": `${key}-fill`,
            style: `width:${width}%;background:${color}`,
          }),
        ),
        h("span", { class: "vps-meter-val", "data-vps": `${key}-val`, text }),
      );

    return h(
      "div",
      { class: "int-card vps-card" },
      h(
        "div",
        { class: "int-head vps-head" },
        dot(task.color, 7),
        h("b", { text: "VPS" }),
        h("span", { class: "vps-host-tag", "data-vps": "host", text: `ssh ${vm.host}` }),
        headRight,
      ),
      h(
        "div",
        { class: "vps-monitor" },
        meterRow("cpu", "CPU", vm.cpuWidth, vm.cpuColor, vm.cpuText),
        meterRow("gpu", "GPU", vm.gpuWidth, vm.gpuColor, vm.gpuText),
        meterRow("ram", "RAM", vm.ramWidth, vm.ramColor, vm.ramText),
        meterRow("disk", "DISK", vm.diskWidth, vm.diskColor, vm.diskText),
      ),
      h(
        "div",
        { class: "int-actions vps-actions" },
        h("button", {
          class: "link-btn",
          "data-vps": "connect-btn",
          style: `color:${task.color}d9`,
          text: vm.connected ? t("Refresh") : t("Connect"),
          onclick: () => void (vm.connected ? Bridge.refreshIntegration("integration_vps") : Bridge.vpsConnect()),
        }),
        h("button", {
          class: "link-btn",
          style: `color:${task.color}d9`,
          text: `>_ ssh ${vm.host}`,
          onclick: openInlineTerminal,
        }),
      ),
    );
  }

  const statusDot = dot(vm.accent, 6);
  statusDot.setAttribute("data-vps", "status-dot");

  const pre = h("pre", {
    class: "int-detail-text vps-term-output",
    "data-vps": "term-output",
    text: vm.outputText,
  });

  const input = h("input", {
    class: "vps-term-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: `ssh ${vm.host} — comando (ej. uptime, docker ps, df -h)…`,
  }) as HTMLInputElement;

  const activateInput = () => {
    State.isPinned = true;
    void Bridge.focusWindow(true);
  };

  input.addEventListener("mousedown", () => {
    activateInput();
  });
  input.addEventListener("focus", () => {
    activateInput();
  });
  input.addEventListener("blur", () => {
    releaseVpsFocus();
  });

  const send = () => {
    const cmd = input.value.trim();
    if (!cmd) return;
    vpsCmdHistory.push(cmd);
    vpsHistoryIdx = vpsCmdHistory.length;
    input.value = "";
    appendVpsEcho(`$ ${cmd}\n`);
    const current = readVpsViewModel();
    if (!current.connected && !current.connecting) {
      void Bridge.vpsConnect()
        .then(() => Bridge.vpsWrite(`${cmd}\n`))
        .catch((err) => appendVpsEcho(`[error] ${String(err)}\n`));
    } else {
      void Bridge.vpsWrite(`${cmd}\n`).catch((err) => appendVpsEcho(`[error] ${String(err)}\n`));
    }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.blur();
      releaseVpsFocus();
      onBack();
    } else if (e.key === "ArrowUp") {
      if (vpsCmdHistory.length > 0 && vpsHistoryIdx > 0) {
        e.preventDefault();
        vpsHistoryIdx--;
        input.value = vpsCmdHistory[vpsHistoryIdx] ?? "";
      }
    } else if (e.key === "ArrowDown") {
      if (vpsHistoryIdx < vpsCmdHistory.length - 1) {
        e.preventDefault();
        vpsHistoryIdx++;
        input.value = vpsCmdHistory[vpsHistoryIdx] ?? "";
      } else {
        vpsHistoryIdx = vpsCmdHistory.length;
        input.value = "";
      }
    }
  });

  pre.addEventListener("click", () => {
    activateInput();
    input.focus();
  });

  requestAnimationFrame(() => {
    pre.scrollTop = pre.scrollHeight;
    activateInput();
    input.focus();
  });

  return h(
    "div",
    { class: "int-card detail vps-card vps-term-card" },
    h(
      "div",
      { class: "int-detail-head vps-term-head" },
      h(
        "button",
        {
          class: "int-back",
          title: t("Back"),
          onclick: () => {
            releaseVpsFocus();
            onBack();
          },
        },
        svg(ICONS.chevronLeft, 10, { stroke: 2.4 }),
      ),
      statusDot,
      h("b", { "data-vps": "host", text: `ssh ${vm.host}` }),
      h("span", { class: "vps-mini-stats", "data-vps": "mini-stats", text: vm.miniStats }),
      h("button", {
        class: "vps-head-action",
        text: t("Clear"),
        onclick: () => {
          const info = State.integrations.integration_vps;
          if (info) info.data = { ...info.data, buffer: [] };
          State.notify();
        },
      }),
      h("button", {
        class: "vps-head-action",
        text: "↻",
        title: t("Reconnect"),
        onclick: () => void Bridge.vpsConnect(),
      }),
    ),
    pre,
    h(
      "div",
      { class: "vps-term-input-row" },
      h("span", { class: "vps-prompt", text: `${vm.host}$` }),
      input,
      h("button", { class: "vps-send-btn", title: t("Send"), text: "↵", onclick: send }),
    ),
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? t("Untitled")) }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", t("Recent")), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: t("No calls scheduled") }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(language(), { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? t("Meeting")) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", t("Schedule")), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", t("Workflow")),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? t("Workflow") }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? t("Workflow") }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? t("Success") : t("Failed"),
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? t("Completed successfully.") : t("No error details available."),
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null || readPulse(get(id)) != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_paypal":
      return info.loaded;
    case "integration_vps":
      return true;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vps") return vpsCard(task, hooks.detailOpen, hooks.openDetail, hooks.closeDetail);
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  // With the pulse in, GitHub gets the Mac's richer card and its lists.
  if (task.id === "integration_github") {
    const d = get(task.id);
    const pulse = readPulse(d);
    if (pulse) {
      return hooks.detailOpen
        ? githubDetail(pulse, readStats(d), readActivity(d), hooks.closeDetail)
        : githubPulseCard(pulse, readStats(d), readActivity(d), hooks.openDetail);
    }
  }

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_paypal":
      return paypalCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
