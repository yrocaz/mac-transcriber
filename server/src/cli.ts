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
import path from "node:path";
import process from "node:process";
import { loadConfig, DEFAULT_LOCALE } from "./config";
import { JobStore } from "./jobStore";
import { HelperSupervisor } from "./supervisor";
import { newJobId } from "./idgen";
import { validateMediaPath } from "./validateInput";
import { assembleTranscript } from "./transcript";
import { TRANSCRIBE_SHARE } from "./progress";
import type { JobRecord } from "./types";
import { type Phase, renderHeader, renderStatusLine } from "./cliRender";

const REDRAW_INTERVAL_MS = 100;

interface CliArgs {
  input: string;
  locale: string;
  diarize: boolean;
  json: boolean;
  quiet: boolean;
}

const USAGE = `Usage: transcribe <media-file> [options]

Transcribes a local audio or video file on-device using Apple SpeechAnalyzer,
with speaker identification via FluidAudio.

Options:
  --locale <bcp47>   Transcription locale (default: ${DEFAULT_LOCALE})
  --no-diarize       Skip speaker identification (faster)
  --json             Print the full transcript as JSON to stdout
  --quiet            Suppress the progress bar
  -h, --help         Show this help

Output goes to stdout (transcript path, or JSON with --json); progress is
drawn on stderr and is hidden automatically when stderr is not a terminal.`;

export function parseArgs(argv: string[]): CliArgs | { help: true } | { error: string } {
  let input: string | null = null;
  let locale = DEFAULT_LOCALE;
  let diarize = true;
  let json = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg === "--no-diarize") diarize = false;
    else if (arg === "--json") json = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--locale") {
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

  if (input === null) return { error: "Missing required <media-file> argument" };
  return { input, locale, diarize, json, quiet };
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

export async function main(argv: string[]): Promise<number> {
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
  const invalid = validateMediaPath(absolute);
  if (invalid) {
    process.stderr.write(`error: ${invalid}\n`);
    return 2;
  }

  const config = loadConfig();
  const store = new JobStore(config.dataDir);
  store.init();
  const supervisor = new HelperSupervisor({
    helperPath: config.helperPath,
    timeouts: config.timeouts,
  });

  const job = store.createJob({
    id: newJobId(),
    path: absolute,
    locale: args.locale,
    diarize: args.diarize,
  });

  const showBar = !args.quiet && process.stderr.isTTY === true;
  const bar = showBar
    ? new ProgressBar(() => store.getJob(job.id), process.stderr)
    : null;

  if (showBar) {
    process.stderr.write(`\n${renderHeader(path.basename(absolute), null)}\n\n`);
    bar!.start();
  }

  // Kill the helper rather than orphaning it if the user interrupts the CLI.
  const onSignal = (signal: NodeJS.Signals) => {
    bar?.stop();
    supervisor.killActive(signal);
    process.stderr.write("\ninterrupted\n");
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await supervisor.run(job, store);
  bar?.stop();

  const final = store.getJob(job.id);
  if (!final || final.status !== "done") {
    process.stderr.write(`error: ${final?.error ?? "job did not complete"}\n`);
    if (final?.stderrTail) process.stderr.write(`${final.stderrTail}\n`);
    return 1;
  }

  for (const warning of final.warnings) {
    process.stderr.write(`warning: ${warning.code}: ${warning.message}\n`);
  }

  const transcript = assembleTranscript(final);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  } else {
    const dir = store.jobDir(final.id);
    if (showBar) {
      const speakers =
        transcript.metadata.speakerCount === null
          ? ""
          : ` · ${transcript.metadata.speakerCount} speaker${transcript.metadata.speakerCount === 1 ? "" : "s"}`;
      process.stderr.write(
        `  ${transcript.segments.length} segments${speakers}\n\n`,
      );
    }
    process.stdout.write(`${path.join(dir, "transcript.json")}\n`);
  }
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
