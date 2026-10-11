// Live diff — port of DiffEngine.swift (NotchBuddy/Sources/CoucouKit).
//
// Line diff (LCS) with 3-line context hunks, used for the Edit / MultiEdit /
// Write / Read tool calls the hooks see. Same size guards as macOS: beyond
// 200 KB or 4 000 lines, or when the LCS table would pass a million cells, only
// the +N −M counts are kept and the diff is marked `tooLarge`.
//
// Also home to `toOneLine` (Claude's final message → one line of plain text)
// and the diff step encoding the ticker reads.

export type DiffKind = "context" | "added" | "removed";
export type DiffToolKind = "read" | "edit" | "write";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based; -1 for pure adds. */
  origLine: number;
  /** 1-based; -1 for pure removes. */
  newLine: number;
}

export interface DiffHunk {
  origStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Stable identifier assigned by State.appendSessionDiff. */
  id: number;
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  tooLarge: boolean;
  /** True when produced by fromNew (Write tool). */
  isNewFile: boolean;
  /** Whether this came from a Read, Edit, or Write tool call. */
  toolKind?: DiffToolKind;
}

/** FileDiff.maxBytes / maxLines on macOS. */
export const DIFF_MAX_BYTES = 200 * 1024;
export const DIFF_MAX_LINES = 4000;
/** LCS is O(m·n): bail out before the quadratic blowup. */
const DIFF_MAX_CELLS = 1_000_000;
const CONTEXT = 3;

const encoder = new TextEncoder();
const utf8Length = (s: string) => encoder.encode(s).length;

/** Last path component, Windows or POSIX separators. */
export function fileName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function fromEdit(oldText: string, newText: string, path: string, startLine = 1): FileDiff {
  if (utf8Length(oldText) + utf8Length(newText) > DIFF_MAX_BYTES) {
    return countFallback(oldText, newText, path);
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length + newLines.length > DIFF_MAX_LINES) {
    return countFallback(oldText, newText, path);
  }
  if (oldLines.length * newLines.length > DIFF_MAX_CELLS) {
    return countFallback(oldText, newText, path);
  }
  const baseLine = Math.max(1, Math.floor(startLine));
  const flat = buildDiffLines(oldLines, newLines, baseLine);
  let added = 0;
  let removed = 0;
  for (const l of flat) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return {
    id: 0,
    path,
    added,
    removed,
    hunks: buildHunks(flat, CONTEXT),
    tooLarge: false,
    isNewFile: false,
    toolKind: "edit",
  };
}

export function fromNew(content: string, path: string, startLine = 1): FileDiff {
  if (utf8Length(content) > DIFF_MAX_BYTES) {
    const lineCount = content.split("\n").length;
    return { id: 0, path, added: lineCount, removed: 0, hunks: [], tooLarge: true, isNewFile: true, toolKind: "write" };
  }
  const lines = splitLines(content);
  if (lines.length > DIFF_MAX_LINES) {
    return { id: 0, path, added: lines.length, removed: 0, hunks: [], tooLarge: true, isNewFile: true, toolKind: "write" };
  }
  const baseLine = Math.max(1, Math.floor(startLine));
  const diffLines: DiffLine[] = lines.map((text, i) => ({
    kind: "added", text, origLine: -1, newLine: baseLine + i,
  }));
  return {
    id: 0,
    path,
    added: diffLines.length,
    removed: 0,
    hunks: diffLines.length ? [{ origStart: 0, newStart: baseLine, lines: diffLines }] : [],
    tooLarge: false,
    isNewFile: true,
    toolKind: "write",
  };
}

export function fromRead(content: string, path: string, startLine = 1): FileDiff {
  const lines = splitLines(content).slice(0, 40);
  const baseLine = Math.max(1, Math.floor(startLine));
  const diffLines: DiffLine[] = lines.map((text, i) => ({
    kind: "context",
    text,
    origLine: baseLine + i,
    newLine: baseLine + i,
  }));
  return {
    id: 0,
    path,
    added: 0,
    removed: 0,
    hunks: diffLines.length ? [{ origStart: baseLine, newStart: baseLine, lines: diffLines }] : [],
    tooLarge: false,
    isNewFile: false,
    toolKind: "read",
  };
}

/**
 * HookServer.buildFileDiff — the diff or code preview of one Edit, MultiEdit,
 * Write, or Read tool call across Claude Code, Antigravity, Codex, and Gemini CLI.
 */
export function buildFileDiff(tool: string, input: Record<string, unknown>): FileDiff | null {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1);
  const path = str(input.file_path) ?? str(input.TargetFile) ?? str(input.AbsolutePath) ?? str(input.path);
  const startLine = num(input.start_line ?? input.StartLine ?? input.offset);

  switch (tool) {
    case "Edit":
    case "replace_file_content":
    case "edit_file":
    case "replace": {
      const oldText = str(input.old_string) ?? str(input.TargetContent);
      const newText = str(input.new_string) ?? str(input.ReplacementContent);
      if (oldText == null || newText == null || path == null) return null;
      if (!oldText && !newText) return null;
      const d = fromEdit(oldText, newText, path, startLine);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    case "MultiEdit":
    case "multi_replace_file_content": {
      const edits = Array.isArray(input.edits)
        ? input.edits
        : Array.isArray(input.ReplacementChunks)
          ? input.ReplacementChunks
          : null;
      if (path == null || !edits || edits.length === 0) return null;
      let added = 0;
      let removed = 0;
      let tooLarge = false;
      const hunks: DiffHunk[] = [];
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit as Record<string, unknown>;
        const oldText = str(e.old_string) ?? str(e.TargetContent);
        const newText = str(e.new_string) ?? str(e.ReplacementContent);
        const chunkStart = num(e.start_line ?? e.StartLine ?? startLine);
        if (oldText == null || newText == null) continue;
        const d = fromEdit(oldText, newText, path, chunkStart);
        added += d.added;
        removed += d.removed;
        hunks.push(...d.hunks);
        if (d.tooLarge) tooLarge = true;
      }
      if (added === 0 && removed === 0) return null;
      return { id: 0, path, added, removed, hunks, tooLarge, isNewFile: false, toolKind: "edit" };
    }
    case "Write":
    case "write_to_file":
    case "write_file": {
      const content = str(input.content) ?? str(input.CodeContent);
      if (path == null || !content) return null;
      const d = fromNew(content, path, startLine);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    case "Read":
    case "view_file":
    case "read_file": {
      const preview = str(input.code_preview) ?? str(input.content);
      if (path == null || !preview) return null;
      const d = fromRead(preview, path, startLine);
      return d.hunks.length > 0 ? d : null;
    }
    default:
      return null;
  }
}

/**
 * Extracts up to `maxLines` representative lines from a FileDiff for the
 * compact 3-line live code preview box in the Overview card (Image 1).
 */
export function previewLinesOfDiff(diff: FileDiff, maxLines = 3): { lineNo: number; text: string; kind: DiffKind }[] {
  const all = diff.hunks.flatMap((h) => h.lines);
  if (all.length === 0) return [];
  // Prefer added/changed lines if present; for context-only (Read), skip leading comment/blank lines.
  const firstChangedIdx = all.findIndex((l) => l.kind === "added" || l.kind === "removed");
  let startIdx = 0;
  if (firstChangedIdx >= 0) {
    startIdx = Math.max(0, firstChangedIdx - 1);
  } else {
    const firstCodeIdx = all.findIndex((l) => {
      const t = l.text.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("#");
    });
    if (firstCodeIdx >= 0) startIdx = firstCodeIdx;
  }
  const picked: { lineNo: number; text: string; kind: DiffKind }[] = [];
  for (let i = startIdx; i < all.length && picked.length < maxLines; i++) {
    const l = all[i];
    if (l.kind === "removed" && all.some((x) => x.kind === "added")) continue;
    if (firstChangedIdx < 0 && l.text.trim().length === 0) continue;
    const lineNo = l.newLine > 0 ? l.newLine : l.origLine > 0 ? l.origLine : i + 1;
    picked.push({ lineNo, text: l.text, kind: l.kind });
  }
  if (picked.length === 0) {
    for (let i = 0; i < Math.min(maxLines, all.length); i++) {
      const l = all[i];
      const lineNo = l.origLine > 0 ? l.origLine : i + 1;
      picked.push({ lineNo, text: l.text, kind: l.kind });
    }
  }
  return picked;
}

// ── Line splitting ────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline leaves one empty element behind.
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ── LCS diff ──────────────────────────────────────────────────────────────────

function buildDiffLines(oldLines: string[], newLines: string[], baseLine = 1): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const w = n + 1;
  // dp[i*w + j] = LCS length of oldLines[0..<i] and newLines[0..<j]. Lengths stay
  // under DIFF_MAX_LINES, so 16 bits are plenty and the table is half the size.
  const dp = new Uint16Array((m + 1) * w);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * w + j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[(i - 1) * w + j - 1] + 1
        : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }

  // Backtrack to the matching pairs.
  const matches: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();

  const offset = baseLine - 1;
  const result: DiffLine[] = [];
  let prevOld = -1;
  let prevNew = -1;
  const removedLine = (k: number): DiffLine => ({ kind: "removed", text: oldLines[k], origLine: offset + k + 1, newLine: -1 });
  const addedLine = (k: number): DiffLine => ({ kind: "added", text: newLines[k], origLine: -1, newLine: offset + k + 1 });
  for (const [oi, ni] of matches) {
    for (let k = prevOld + 1; k < oi; k++) result.push(removedLine(k));
    for (let k = prevNew + 1; k < ni; k++) result.push(addedLine(k));
    result.push({ kind: "context", text: oldLines[oi], origLine: offset + oi + 1, newLine: offset + ni + 1 });
    prevOld = oi;
    prevNew = ni;
  }
  for (let k = prevOld + 1; k < m; k++) result.push(removedLine(k));
  for (let k = prevNew + 1; k < n; k++) result.push(addedLine(k));
  return result;
}

// ── Hunks ─────────────────────────────────────────────────────────────────────

function buildHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const merged: [number, number][] = [];
  lines.forEach((line, i) => {
    if (line.kind === "context") return;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged.map(([start, end]) => {
    const hunkLines = lines.slice(start, end + 1);
    return {
      origStart: hunkLines.find((l) => l.origLine > 0)?.origLine ?? 1,
      newStart: hunkLines.find((l) => l.newLine > 0)?.newLine ?? 1,
      lines: hunkLines,
    };
  });
}

// ── Count fallback (too large) ────────────────────────────────────────────────

function countFallback(oldText: string, newText: string, path: string): FileDiff {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => l !== "" && !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => l !== "" && !newSet.has(l)).length;
  return { id: 0, path, added, removed, hunks: [], tooLarge: true, isNewFile: false, toolKind: "edit" };
}

// ── toOneLine ─────────────────────────────────────────────────────────────────

/**
 * A possibly multi-line Markdown message as one line of plain text: only the
 * first non-empty paragraph (a blank line, a horizontal rule or a table row ends
 * it), without `**`, `__`, backticks, leading `#` or list markers.
 */
export function toOneLine(text: string, maxChars = 200): string {
  const trimWS = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = trimWS(line);
    const isHR = t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
    if (t === "" || isHR || t.startsWith("|")) {
      if (current.length) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current);

  for (const para of paragraphs) {
    const s = para.join("\n").replaceAll("**", "").replaceAll("__", "").replaceAll("`", "");
    const processed: string[] = [];
    for (const line of s.split("\n")) {
      let l = trimWS(line.replace(/^#+/, ""));
      if (l.startsWith("- ") || l.startsWith("* ") || l.startsWith("• ")) l = l.slice(2);
      else l = l.replace(/^\d+\.\s+/, "");
      l = trimWS(l);
      if (l) processed.push(l);
    }
    const collapsed = processed.join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) return Array.from(collapsed).slice(0, maxChars).join("");
  }
  return "";
}

// ── Diff steps ────────────────────────────────────────────────────────────────
// A diff shows up in the ticker as a step string the user never sees raw:
// `"<filename>\t<added>:<removed>:<diffId>"` — same format as macOS.

export const DIFF_STEP_MARKER = "";

export interface DiffStep {
  filename: string;
  added: number;
  removed: number;
  diffId: number;
}

export function isDiffStep(step: string): boolean {
  return step.startsWith(DIFF_STEP_MARKER);
}

export function makeDiffStep(filename: string, added: number, removed: number, diffId: number): string {
  return `${DIFF_STEP_MARKER}${filename}\t${added}:${removed}:${diffId}`;
}

export function parseDiffStep(step: string): DiffStep | null {
  if (!isDiffStep(step)) return null;
  const body = step.slice(DIFF_STEP_MARKER.length);
  const tab = body.indexOf("\t");
  if (tab < 0) return null;
  const parts = body.slice(tab + 1).split(":");
  if (parts.length !== 3 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
  const [added, removed, diffId] = parts.map(Number);
  return { filename: body.slice(0, tab), added, removed, diffId };
}

/** The last step that is text, never a diff marker. */
export function lastTextStep(steps: readonly string[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!isDiffStep(steps[i])) return steps[i];
  }
  return undefined;
}
