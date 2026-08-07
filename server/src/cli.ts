#!/usr/bin/env node
/**
 * `transcribe` — a one-shot CLI around the same job machinery the HTTP service
 * uses. It runs the job in-process (no server, no port, no daemon) by driving
 * JobStore + HelperSupervisor directly, so transcripts land in the same
 * data/jobs/<id>/ layout and go through the same reviewed code path.
 *
 * Stdout carries only the result (a path, or JSON with --json) so it stays
 * pipeable; the progress bar and all human-facing chatter go to stderr, and
 * the bar is suppressed entirely when stderr isn't a TTY — the isatty
 * convention yap uses, which keeps CI logs and `2>file` output readable.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { loadConfig, DEFAULT_LOCALE } from "./config";
import { JobStore } from "./jobStore";
import { HelperSupervisor } from "./supervisor";
import { validateMediaPath, defaultOutputDir } from "./validateInput";
import { assembleTranscript } from "./transcript";
import { collectReviewItems } from "./review";
import { TRANSCRIBE_SHARE } from "./progress";
import { transcribeOne } from "./runFile";
import { runTree, planTree, runLogPath, type TreeSummary, type TreePlan } from "./runTree";
import { parseHints, type HintRule } from "./hints";
import type { JobRecord } from "./types";
import { type Phase, formatJobError, renderHeader, renderStatusLine } from "./cliRender";

const REDRAW_INTERVAL_MS = 100;

interface CliArgs {
  input: string;
  locale: string;
  diarize: boolean;
  json: boolean;
  quiet: boolean;
  /** Exact speaker count when known; overrides min/max inside FluidAudio. */
  speakers: number | null;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  outDir: string | null;
  /** Skip the interactive questionnaire even on a TTY. */
  noPrompt: boolean;
  /** Path to a per-file speaker-hint rules file (tree mode only). */
  hintsFile: string | null;
  /** Re-transcribe files that already have output (tree mode only). */
  force: boolean;
  /** Show what a tree run would do, without transcribing (tree mode only). */
  dryRun: boolean;
}

const USAGE = `Usage: transcribe <media-file|directory> [options]

Transcribes a local audio or video file on-device using Apple SpeechAnalyzer,
with speaker identification via FluidAudio. Given a directory, walks it
recursively and transcribes every media file found.

Options:
  --speakers <n>       Exact number of speakers, when known. Improves accuracy
                       markedly: automatic clustering tends to merge similar
                       voices on multi-party recordings.
  --min-speakers <n>   Lower bound, when the exact count is unknown
  --max-speakers <n>   Upper bound, when the exact count is unknown
  --locale <bcp47>     Transcription locale (default: ${DEFAULT_LOCALE})
  --no-diarize         Skip speaker identification (faster)
  --out <dir>          Write transcripts here instead of beside the media file
  --json               Print the full transcript as JSON to stdout
                       (in tree mode, prints the run summary instead)
  --quiet              Suppress the progress bar
  --no-prompt          Never ask questions; use defaults for anything omitted
  -h, --help           Show this help

Directory (tree) mode:
  --hints <file>       Per-file speaker rules: one "<glob> <flags>" per line,
                       first match wins. Lets panels take --speakers 5 while
                       solo segments take --min-speakers 1 --max-speakers 2 in
                       the same run.
  --force              Re-transcribe files that already have a transcript.
                       Without it, completed files are skipped, so an
                       interrupted run resumes for free.
  --dry-run            List what would be transcribed, which hint rule each
                       file matched, and where output would go — then stop.
                       Costs seconds; use it to check a hints file before
                       committing hours to a run.

Transcripts are written to a folder named after the media file, beside it:
  /recordings/Panel.wav  ->  /recordings/Panel/{transcript.txt,.json,.srt,review.md}

In tree mode with --out, the source layout is mirrored under it:
  Recordings/Next Deal Edit/Panel.wav  ->  <out>/Next Deal Edit/Panel/
A run log is written to <out>/_run.log (or <dir>/_run.log without --out).

Output goes to stdout (the transcript folder, or JSON with --json); progress
is drawn on stderr and hidden automatically when stderr is not a terminal.`;

export function parseArgs(argv: string[]): CliArgs | { help: true } | { error: string } {
  let input: string | null = null;
  let locale = DEFAULT_LOCALE;
  let diarize = true;
  let json = false;
  let quiet = false;
  let speakers: number | null = null;
  let minSpeakers: number | null = null;
  let maxSpeakers: number | null = null;
  let outDir: string | null = null;
  let noPrompt = false;
  let hintsFile: string | null = null;
  let force = false;
  let dryRun = false;

  const readCount = (raw: string | undefined, flag: string): number | string => {
    if (!raw) return `${flag} requires a value`;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return `${flag} must be a positive whole number`;
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg === "--no-diarize") diarize = false;
    else if (arg === "--json") json = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--no-prompt") noPrompt = true;
    else if (arg === "--force") force = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--hints") {
      const value = argv[++i];
      if (!value) return { error: "--hints requires a value" };
      hintsFile = value;
    } else if (arg === "--speakers" || arg === "--min-speakers" || arg === "--max-speakers") {
      const value = readCount(argv[++i], arg);
      if (typeof value === "string") return { error: value };
      if (arg === "--speakers") speakers = value;
      else if (arg === "--min-speakers") minSpeakers = value;
      else maxSpeakers = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) return { error: "--out requires a value" };
      outDir = value;
    } else if (arg === "--locale") {
      const value = argv[++i];
      if (!value) return { error: "--locale requires a value" };
      locale = value;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else if (input === null) {
      input = arg;
    } else {
      return { error: `Unexpected extra argument: ${arg}` };
    }
  }

  if (input === null) return { error: "Missing required <media-file|directory> argument" };
  if (minSpeakers !== null && maxSpeakers !== null && minSpeakers > maxSpeakers) {
    return { error: "--min-speakers must be <= --max-speakers" };
  }
  return {
    input,
    locale,
    diarize,
    json,
    quiet,
    speakers,
    minSpeakers,
    maxSpeakers,
    outDir,
    noPrompt,
    hintsFile,
    force,
    dryRun,
  };
}

/**
 * Derives the display phase from the persisted job record alone, so the CLI
 * needs no extra hook into the supervisor. `durationSec` is set by the helper's
 * `ready` event, which fires only after file open and any MP3 repair — so its
 * absence is exactly the indeterminate "preparing" window.
 */
export function derivePhase(job: JobRecord): Phase {
  if (job.status === "done" || job.status === "error") return "done";
  if (job.durationSec === null) return "preparing";
  if (!job.diarize) return "transcribing";
  return job.progress < TRANSCRIBE_SHARE ? "transcribing" : "identifying";
}

class ProgressBar {
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastLineLength = 0;
  private readonly startMs = Date.now();

  constructor(
    private readonly getJob: () => JobRecord | undefined,
    private readonly stream: NodeJS.WriteStream,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.draw(), REDRAW_INTERVAL_MS);
    // Don't hold the process open on the redraw timer alone.
    this.timer.unref();
  }

  private draw(): void {
    const job = this.getJob();
    if (!job) return;
    const line = renderStatusLine({
      phase: derivePhase(job),
      fraction: job.progress,
      elapsedSec: (Date.now() - this.startMs) / 1000,
      columns: this.stream.columns ?? 80,
      tick: this.tick++,
    });
    // Pad to erase the previous, possibly longer, line rather than leaving
    // its tail behind when the bar shortens.
    const padded = line.padEnd(this.lastLineLength);
    this.lastLineLength = line.length;
    this.stream.write(`\r${padded}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lastLineLength > 0) {
      this.stream.write(`\r${" ".repeat(this.lastLineLength)}\r`);
      this.lastLineLength = 0;
    }
  }
}

/**
 * Asks the few questions that measurably change the result, but only when
 * they weren't answered on the command line and only on an interactive
 * terminal. Piped/scripted runs and --no-prompt fall straight through to
 * defaults, so nothing ever blocks waiting on a human that isn't there.
 *
 * Speaker count is the one question worth asking: automatic clustering merged
 * a 5-person panel into 3 speakers on 2026-08-05, and naming the count is the
 * documented fix.
 */
async function askQuestions(args: CliArgs): Promise<CliArgs> {
  const interactive =
    !args.noPrompt && process.stdin.isTTY === true && process.stderr.isTTY === true;
  const alreadyAnswered =
    args.speakers !== null || args.minSpeakers !== null || args.maxSpeakers !== null;
  if (!interactive || !args.diarize || alreadyAnswered) return args;

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (
      await rl.question("  How many speakers are in this recording? [enter to detect] ")
    ).trim();
    if (answer === "") return args;

    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write("  Not a whole number — detecting automatically.\n");
      return args;
    }
    return { ...args, speakers: n };
  } finally {
    rl.close();
  }
}

/**
 * Renders the end-of-run summary. Failures are listed individually and last,
 * where they stay on screen — a run that reports only "43 files, 1 failed"
 * makes you go hunting through the log for which one.
 */
export function renderTreeSummary(summary: TreeSummary): string {
  const lines = [
    "",
    `  ${summary.total} media files · ${summary.done} transcribed · ` +
      `${summary.skipped} skipped · ${summary.failed} failed`,
  ];
  if (summary.recovered > 0) {
    lines.push(`  ${summary.recovered} recovered from damaged source media`);
  }
  if (summary.failed > 0) {
    lines.push("", "  failed:");
    for (const outcome of summary.outcomes.filter((o) => o.status === "failed")) {
      lines.push(`    ${outcome.relativePath} — ${outcome.error ?? "unknown error"}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Renders a `--dry-run` plan: what would run, with which speaker hint, and
 * where it would land. Exists because checking a hints file by starting a real
 * run means waiting out the whole archive to find out rule 3 never matched.
 */
export function renderTreePlan(plan: TreePlan): string {
  if (plan.files.length === 0) return `\n  no media files found under ${plan.root}\n\n`;

  const describe = (file: TreePlan["files"][number]): string => {
    const hint = file.speakerHint;
    const speakers =
      hint === null
        ? "no hint"
        : hint.exact !== null
          ? `${hint.exact} speakers`
          : `${hint.min ?? "?"}–${hint.max ?? "?"} speakers`;
    const rule = file.matchedGlob ? `via "${file.matchedGlob}"` : "via CLI flags";
    return `${speakers} ${rule}`;
  };

  const width = Math.min(60, Math.max(...plan.files.map((f) => f.relativePath.length)));
  const lines = ["", `  ${plan.files.length} media files under ${plan.root}`, ""];
  for (const file of plan.files) {
    const mark = file.action === "skip" ? "skip" : "  → ";
    lines.push(`  ${mark} ${file.relativePath.padEnd(width)}  ${describe(file)}`);
  }

  const todo = plan.files.filter((f) => f.action === "transcribe").length;
  const skip = plan.files.length - todo;
  lines.push("", `  would transcribe ${todo}, skip ${skip} (already done)`, "");
  return `${lines.join("\n")}\n`;
}

function loadHints(hintsFile: string | null): HintRule[] | { error: string } {
  if (!hintsFile) return [];
  try {
    return parseHints(fs.readFileSync(path.resolve(hintsFile), "utf8"));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tree mode. Never prompts — a walk of unknown size can't sensibly ask about
 * speaker counts per file, which is what --hints is for.
 */
async function runTreeMode(
  args: CliArgs,
  root: string,
  store: JobStore,
  supervisor: HelperSupervisor,
  bar: ProgressBar | null,
  onJobStart: (id: string) => void,
): Promise<number> {
  const hints = loadHints(args.hintsFile);
  if ("error" in hints) {
    process.stderr.write(`error: ${hints.error}\n`);
    return 2;
  }

  const outRoot = args.outDir ? path.resolve(args.outDir) : null;
  const speakerHint =
    args.speakers === null && args.minSpeakers === null && args.maxSpeakers === null
      ? null
      : { exact: args.speakers, min: args.minSpeakers, max: args.maxSpeakers };

  if (args.dryRun) {
    const plan = planTree({ root, outRoot, hints, speakerHint, force: args.force });
    if (args.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else process.stderr.write(renderTreePlan(plan));
    return 0;
  }

  const summary = await runTree(supervisor, store, {
    root,
    outRoot,
    locale: args.locale,
    diarize: args.diarize,
    speakerHint,
    hints,
    force: args.force,
    onJobStart,
    onFileStart: (index, total, relativePath) => {
      if (!bar) return;
      process.stderr.write(`\n  [${index}/${total}] ${relativePath}\n\n`);
      bar.start();
    },
    onFileEnd: () => bar?.stop(),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    // Not gated on `bar`: a non-TTY or --quiet run is exactly the scripted
    // batch case, and the summary — counts plus which files failed — is the
    // deliverable. Only the live progress bar depends on a terminal.
    process.stderr.write(renderTreeSummary(summary));
    process.stderr.write(`  log: ${runLogPath(root, outRoot)}\n\n`);
    // stdout stays pipeable: one output directory per line.
    for (const outcome of summary.outcomes) {
      if (outcome.status !== "failed") process.stdout.write(`${outcome.outputDir}\n`);
    }
  }
  // Non-zero on any failure so `transcribe dir/ && next-step` behaves.
  return summary.failed > 0 ? 1 : 0;
}

/**
 * Registers the interrupt handlers for the duration of one run and removes
 * them afterwards. Without the removal, anything that calls `main()` more than
 * once in a process (the test suite, or an embedder) accumulates listeners and
 * inherits a handler that calls `process.exit(130)` — so a teardown SIGTERM
 * kills the process mid-assertion.
 */
export async function main(argv: string[]): Promise<number> {
  const handlers: Array<[NodeJS.Signals, (signal: NodeJS.Signals) => void]> = [];
  try {
    return await runMain(argv, handlers);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function runMain(
  argv: string[],
  handlers: Array<[NodeJS.Signals, (signal: NodeJS.Signals) => void]>,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  const args = parsed;
  const absolute = path.resolve(args.input);

  // Directory in, tree mode. Checked before validateMediaPath, which is
  // file-shaped and would reject a directory for having no media extension.
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat) {
    process.stderr.write(`error: Path does not exist: ${absolute}\n`);
    return 2;
  }
  const inputIsDirectory = stat.isDirectory();

  const config = loadConfig();
  const store = new JobStore(config.dataDir);
  store.init();
  const supervisor = new HelperSupervisor({
    helperPath: config.helperPath,
    timeouts: config.timeouts,
  });

  // The bar follows whichever job is live. Recovery starts a second job for
  // the same file, so a bar bound to one fixed id would freeze mid-run.
  let currentJobId: string | null = null;
  const showBar = !args.quiet && process.stderr.isTTY === true;
  const bar = showBar
    ? new ProgressBar(() => (currentJobId ? store.getJob(currentJobId) : undefined), process.stderr)
    : null;

  // Kill the helper rather than orphaning it if the user interrupts the CLI.
  const onSignal = (signal: NodeJS.Signals) => {
    bar?.stop();
    supervisor.killActive(signal);
    process.stderr.write("\ninterrupted\n");
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  handlers.push(["SIGINT", onSignal], ["SIGTERM", onSignal]);

  if (inputIsDirectory) {
    return await runTreeMode(args, absolute, store, supervisor, bar, (id) => {
      currentJobId = id;
    });
  }

  const invalid = validateMediaPath(absolute);
  if (invalid) {
    process.stderr.write(`error: ${invalid}\n`);
    return 2;
  }

  const args2 = await askQuestions(args);
  const outputDir = args2.outDir ? path.resolve(args2.outDir) : defaultOutputDir(absolute);

  if (showBar) {
    process.stderr.write(`\n${renderHeader(path.basename(absolute), null)}\n\n`);
    bar!.start();
  }

  const { job: final, recovered } = await transcribeOne(supervisor, store, {
    mediaPath: absolute,
    outputDir,
    locale: args2.locale,
    diarize: args2.diarize,
    speakerHint:
      args2.speakers === null && args2.minSpeakers === null && args2.maxSpeakers === null
        ? null
        : { exact: args2.speakers, min: args2.minSpeakers, max: args2.maxSpeakers },
    onJobStart: (id) => {
      currentJobId = id;
    },
  });
  bar?.stop();

  if (!final || final.status !== "done") {
    process.stderr.write(`error: ${formatJobError(final?.error)}\n`);
    if (final?.stderrTail) process.stderr.write(`${final.stderrTail}\n`);
    return 1;
  }
  if (recovered && showBar) {
    process.stderr.write("  recovered: transcribed from a re-encoded copy of the source\n");
  }

  for (const warning of final.warnings) {
    process.stderr.write(`warning: ${warning.code}: ${warning.message}\n`);
  }

  const transcript = assembleTranscript(final);
  if (args2.json) {
    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
    return 0;
  }

  if (showBar) {
    const count = transcript.metadata.speakerCount;
    const speakers = count === null ? "" : ` · ${count} speaker${count === 1 ? "" : "s"}`;
    const flagged = collectReviewItems(final, transcript).length;
    process.stderr.write(`  ${transcript.segments.length} segments${speakers}\n\n`);
    process.stderr.write(`  ${path.join(outputDir, "transcript.txt")}   ← readable\n`);
    process.stderr.write(`  ${path.join(outputDir, "transcript.json")}\n`);
    process.stderr.write(`  ${path.join(outputDir, "transcript.srt")}\n`);
    // Naming the count here is the point: a review list nobody knows about is
    // a file nobody opens.
    const suffix = flagged === 0 ? "   ← nothing flagged" : `   ← ${flagged} to check`;
    process.stderr.write(`  ${path.join(outputDir, "review.md")}${suffix}\n\n`);
  }
  // stdout gets the folder alone, so `open "$(transcribe f.wav)"` works.
  process.stdout.write(`${outputDir}\n`);
  return 0;
}

// Only run when invoked directly, so tests can import parseArgs/derivePhase.
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
