/**
 * Pure rendering helpers for the `transcribe` CLI. No terminal I/O, no clock,
 * no process state — everything here is a function of its arguments so it can
 * be unit tested without a TTY. The imperative side lives in cli.ts.
 */

/** Phases the CLI reports, in the order they occur. */
export type Phase =
  | "preparing"
  | "downloading"
  | "transcribing"
  | "identifying"
  | "done";

const PHASE_LABELS: Record<Phase, string> = {
  preparing: "Preparing",
  downloading: "Downloading models",
  transcribing: "Transcribing",
  identifying: "Identifying speakers",
  done: "Done",
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}

/**
 * Phases with no meaningful percentage. `preparing` covers file open and the
 * MP3 tail-probe/repair, which emit nothing until `ready`; showing a creeping
 * fake number there would be a lie, so callers render a spinner instead.
 */
export function isIndeterminate(phase: Phase): boolean {
  return phase === "preparing";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(tick: number): string {
  const i = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[i]!;
}

/**
 * A filled bar of `width` cells. `fraction` outside [0,1] is clamped rather
 * than trusted — progress arrives from a separate process.
 */
export function renderBar(fraction: number, width: number): string {
  const cells = Math.max(0, Math.trunc(width));
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** `m:ss`, or `h:mm:ss` past an hour. Negative and non-finite render as "--:--". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Seconds remaining, extrapolated from observed throughput. Returns null when
 * the estimate would be untrustworthy: too little progress to extrapolate from
 * (below `minFraction`), no elapsed time yet, or already complete. Callers
 * render nothing rather than a wrong number.
 */
export function estimateRemaining(
  fraction: number,
  elapsedSec: number,
  minFraction = 0.1,
): number | null {
  if (!Number.isFinite(fraction) || !Number.isFinite(elapsedSec)) return null;
  if (fraction < minFraction || fraction >= 1 || elapsedSec <= 0) return null;
  return (elapsedSec / fraction) * (1 - fraction);
}

export interface StatusLineInput {
  phase: Phase;
  /** Overall job progress in [0,1]. Ignored for indeterminate phases. */
  fraction: number;
  elapsedSec: number;
  /** Total terminal width; the bar is sized to fit what's left after text. */
  columns: number;
  /** Monotonic tick used to advance the spinner. */
  tick: number;
}

const LABEL_WIDTH = 20;
const MIN_BAR = 8;
const MAX_BAR = 32;

/**
 * One status line: label, bar (or spinner), percentage, and ETA. Sized to the
 * terminal so it never wraps — a wrapped line breaks in-place redraw and
 * leaves a trail of half-finished bars.
 */
export function renderStatusLine(input: StatusLineInput): string {
  const { phase, fraction, elapsedSec, columns, tick } = input;
  const label = phaseLabel(phase).padEnd(LABEL_WIDTH);

  if (isIndeterminate(phase)) {
    return `  ${label}${spinnerFrame(tick)}`;
  }

  const clamped = Math.min(1, Math.max(0, fraction));
  const pct = `${String(Math.floor(clamped * 100)).padStart(3)}%`;
  const remaining = estimateRemaining(clamped, elapsedSec);
  const eta = remaining === null ? "" : `   ${formatDuration(remaining)}`;

  // Degrade in priority order so the line always fits: full line, then drop
  // the ETA, then drop the bar entirely. A line that exceeds the terminal
  // wraps, which breaks \r redraw and leaves a trail of stale half-bars.
  const budget = Math.max(0, columns - 1); // -1: avoid the last cell
  const overhead = (etaText: string) => 2 + LABEL_WIDTH + 2 + pct.length + etaText.length;

  for (const etaText of [eta, ""]) {
    const available = budget - overhead(etaText);
    if (available >= MIN_BAR) {
      const barWidth = Math.min(MAX_BAR, available);
      return `  ${label}${renderBar(clamped, barWidth)}  ${pct}${etaText}`;
    }
  }
  return `  ${label}${pct}`.slice(0, budget);
}

/** Header shown once before the bar: what we're working on. */
export function renderHeader(fileName: string, durationSec: number | null): string {
  const duration = durationSec === null ? "" : ` · ${formatDuration(durationSec)}`;
  return `  ${fileName}${duration}`;
}
