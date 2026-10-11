// Diff card & Korus-style live code preview — port of DiffCardView / DiffLineRowView
// with syntax highlighting, line numbers, 3-line inline preview, and step timeline.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import {
  fileName,
  parseDiffStep,
  previewLinesOfDiff,
  type DiffKind,
  type FileDiff,
} from "../core/diff";
import type { AgentTask } from "../core/state";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import { N_, t, tl } from "../i18n/i18n";

const STRINGS = {
  back: N_("Back"),
  open: N_("Open in VS Code"),
  tooLarge: N_("Diff too large"),
  noChanges: N_("No changes"),
};

const SYMBOLS: Record<DiffKind, string> = { added: "+", removed: "−", context: " " };

export interface DiffCardHooks {
  dismiss(): void;
  /** ↗ — opens the file in the editor. */
  open(path: string): void;
  /** Switch to another diff in the session timeline. */
  selectDiff?(diffId: number): void;
}

const TOKEN_RE =
  /(\/\/.*$|#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(export|import|from|async|await|function|return|const|let|var|if|else|for|while|switch|case|break|continue|new|class|interface|type|enum|implements|extends|public|private|protected|readonly|static|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|fn|pub|mod|use|struct|impl|trait|match|mut|ref|where|crate|super|self|Self|def|elif|except|lambda|pass|raise|with|yield|package|func|go|defer|select|chan|map)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*\()/g;

/** Builds syntax-highlighted DOM spans for a single line of code (XSS-safe via textContent). */
export function highlightCodeLine(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!text) {
    frag.append(document.createTextNode(" "));
    return frag;
  }
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      frag.append(document.createTextNode(text.slice(last, m.index)));
    }
    const token = m[0];
    let cls = "tok-txt";
    if (m[1] != null) cls = "tok-com";
    else if (m[2] != null) cls = "tok-str";
    else if (m[3] != null) cls = "tok-kw";
    else if (m[4] != null) cls = "tok-num";
    else if (m[5] != null) cls = "tok-type";
    else if (m[6] != null) cls = "tok-fn";
    frag.append(h("span", { class: cls, text: token }));
    last = m.index + token.length;
  }
  if (last < text.length) {
    frag.append(document.createTextNode(text.slice(last)));
  }
  return frag;
}

function langBadgeOf(path: string): { label: string; color: string } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return { label: "TS", color: "#38BDF8" };
    case "js":
    case "jsx":
    case "mjs":
      return { label: "JS", color: "#FACC15" };
    case "rs":
      return { label: "RS", color: "#F97316" };
    case "py":
      return { label: "PY", color: "#60A5FA" };
    case "css":
      return { label: "CSS", color: "#A855F7" };
    case "html":
      return { label: "HTML", color: "#F43F5E" };
    case "json":
      return { label: "JSON", color: "#34D399" };
    case "md":
      return { label: "MD", color: "#94A3B8" };
    default:
      return { label: (ext.slice(0, 3) || "FILE").toUpperCase(), color: "#8E939C" };
  }
}

function shortRelativePath(fullPath: string, cwd?: string | null): string {
  const norm = fullPath.replace(/\\/g, "/");
  if (cwd) {
    const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.toLowerCase().startsWith(normCwd.toLowerCase() + "/")) {
      return norm.slice(normCwd.length + 1);
    }
  }
  const parts = norm.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : norm;
}

/**
 * Compact 3-line numbered syntax-highlighted code preview box shown inside the
 * Overview card right below the active step row (Korus Image 1).
 */
export function buildInlineCodePreview(
  diff: FileDiff,
  onOpen: (diffId: number) => void,
): HTMLElement {
  const preview = previewLinesOfDiff(diff, 3);
  const box = h("div", {
    class: "live-code-preview",
    title: `${fileName(diff.path)} — click to inspect`,
    onclick: () => onOpen(diff.id),
  });
  for (const row of preview) {
    const codeSpan = h("span", { class: "lcp-code" });
    codeSpan.append(highlightCodeLine(row.text));
    box.append(
      h(
        "div",
        { class: `lcp-row ${row.kind}` },
        h("span", { class: "lcp-ln", text: String(row.lineNo) }),
        codeSpan,
      ),
    );
  }
  return box;
}

function parseStepTimelineEntry(raw: string): {
  icon: string;
  action: string;
  target: string;
  diffId: number | null;
} {
  const diff = parseDiffStep(raw);
  if (diff) {
    const isRead = diff.added === 0 && diff.removed === 0;
    return {
      icon: isRead ? "📄" : "✏️",
      action: isRead ? "Read" : "Edit",
      target: diff.filename,
      diffId: diff.diffId,
    };
  }
  const parts = raw.split(" · ");
  const head = parts[0]?.trim() ?? raw;
  const rest = parts.slice(1).join(" · ").trim();
  const lower = head.toLowerCase();
  if (lower.includes("read") || lower.includes("lee")) {
    return { icon: "📄", action: "Read", target: rest, diffId: null };
  }
  if (lower.includes("edit") || lower.includes("edita")) {
    return { icon: "✏️", action: "Edit", target: rest, diffId: null };
  }
  if (lower.includes("write") || lower.includes("escribe")) {
    return { icon: "📝", action: "Write", target: rest, diffId: null };
  }
  if (lower.includes("run") || lower.includes("bash") || lower.includes("ejecuta")) {
    return { icon: ">_", action: "Bash", target: rest, diffId: null };
  }
  return { icon: "✓", action: head.slice(0, 18), target: rest, diffId: null };
}

export function buildDiffCard(
  diff: FileDiff,
  hooks: DiffCardHooks,
  task?: AgentTask | null,
): HTMLElement {
  const badge = langBadgeOf(diff.path);
  const relPath = shortRelativePath(diff.path, task?.sessionCwd);

  // Left sidebar: project name + agent subtitle + vertical step timeline (Image 2)
  const sidebar = h("div", { class: "diff-sidebar" });
  if (task) {
    const cwdParts = task.sessionCwd ? task.sessionCwd.replace(/\\/g, "/").split("/").filter(Boolean) : [];
    const projName = cwdParts.length > 0 ? cwdParts[cwdParts.length - 1] : task.name;
    const agentSub = pillDefinition(task.id)?.name ?? t(sessionSubtitle(task.id));
    sidebar.append(
      h(
        "div",
        { class: "diff-who" },
        h(
          "div",
          { style: "display:flex;align-items:center;gap:5px;min-width:0;" },
          dot(task.color, 7),
          h("span", { class: "diff-proj", text: projName }),
        ),
        h("div", { class: "diff-agent-sub", text: agentSub }),
      ),
    );
    const timeline = h("div", { class: "diff-timeline" });
    const recentSteps = task.steps.slice(-6);
    for (const rawStep of recentSteps) {
      const entry = parseStepTimelineEntry(rawStep);
      const isCurrent = entry.diffId === diff.id;
      const item = h(
        "div",
        {
          class: `diff-tl-item${isCurrent ? " active" : " done"}${entry.diffId != null ? " clickable" : ""}`,
          onclick: () => {
            if (entry.diffId != null && hooks.selectDiff) hooks.selectDiff(entry.diffId);
          },
        },
        h("span", { class: "diff-tl-dot" }),
        h("span", { class: "diff-tl-txt", text: `${entry.icon} ${entry.action}` }),
      );
      timeline.append(item);
    }
    if (task.state === "finished") {
      timeline.append(
        h(
          "div",
          { class: "diff-tl-item done" },
          h("span", { class: "diff-tl-dot" }),
          h("span", { class: "diff-tl-txt", text: "✓ Done" }),
        ),
      );
    }
    sidebar.append(timeline);
  }

  const head = h(
    "div",
    { class: "diff-head" },
    h(
      "button",
      { class: "diff-back", title: tl(STRINGS.back), onclick: () => hooks.dismiss() },
      svg(ICONS.chevronLeft, 9, { stroke: 2.4 }),
    ),
    h("span", {
      class: "diff-lang-badge",
      style: `color:${badge.color};background:${badge.color}1f;border-color:${badge.color}40`,
      text: badge.label,
    }),
    h("b", { class: "diff-filename", text: fileName(diff.path) }),
    h("span", { class: "diff-relpath", text: relPath }),
    h("span", { class: "grow" }),
    diff.added > 0 ? h("span", { class: "tick-count plus", text: `+${diff.added}` }) : null,
    diff.removed > 0 ? h("span", { class: "tick-count minus", text: `−${diff.removed}` }) : null,
    h(
      "button",
      { class: "icon-btn", title: tl(STRINGS.open), onclick: () => hooks.open(diff.path) },
      svg(ICONS.arrowUpRight, 8),
    ),
  );

  const lines = diff.hunks.flatMap((hunk) => hunk.lines);
  let content: HTMLElement;
  if (diff.tooLarge) {
    content = h("div", { class: "diff-note", text: tl(STRINGS.tooLarge) });
  } else if (lines.length === 0) {
    content = h("div", { class: "diff-note", text: tl(STRINGS.noChanges) });
  } else {
    content = h("div", { class: "diff-lines" });
    const rows = document.createDocumentFragment();
    lines.forEach((line, idx) => {
      const lineNo = line.newLine > 0 ? line.newLine : line.origLine > 0 ? line.origLine : idx + 1;
      const txtSpan = h("span", { class: "txt" });
      txtSpan.append(highlightCodeLine(line.text));
      rows.append(
        h(
          "div",
          { class: `diff-line ${line.kind}` },
          h("span", { class: "ln", text: String(lineNo) }),
          h("span", { class: "sym", text: SYMBOLS[line.kind] }),
          txtSpan,
        ),
      );
    });
    content.append(rows);
  }

  const main = h("div", { class: "diff-main" }, head, content);
  return h("div", { class: "diff-card korus-diff" }, sidebar, main);
}
