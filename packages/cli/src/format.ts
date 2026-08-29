/**
 * Terminal formatting without dependencies. Colour only when stdout is a TTY and NO_COLOR is
 * unset (https://no-color.org); every output must read well as plain text in a screenshot.
 */
export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const ESC = "\x1b";

export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

/** NO_COLOR wins over FORCE_COLOR (per no-color.org: the user's opt-out is final); then TTY. */
export function colourEnabled(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  return isTTY;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI, "").length;

export interface Column {
  header: string;
  align?: "left" | "right";
}

/** Renders rows as a plain, aligned table. Cells may contain ANSI codes. */
export function table(columns: Column[], rows: string[][], style: Style): string {
  const widths = columns.map((c, i) => Math.max(visibleLength(c.header), ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const pad = (cell: string, i: number) => {
    const fill = " ".repeat((widths[i] ?? 0) - visibleLength(cell));
    return columns[i]?.align === "right" ? fill + cell : cell + fill;
  };
  const line = (cells: string[]) => cells.map(pad).join("  ").trimEnd();
  const out = [style.dim(line(columns.map((c) => c.header))), style.dim(widths.map((w) => "─".repeat(w)).join("  "))];
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

export function formatDuration(start: string, end: string | null): string {
  if (!end) return "…";
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function formatBytes(n: number | null): string {
  if (n === null) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function shortId(id: string): string {
  return id.slice(-8);
}
