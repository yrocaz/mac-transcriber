/**
 * Tree mode: transcribe every media file under a directory.
 *
 * Replaces the out-of-band bash driver a 43-file archive run needed. The three
 * behaviours that mattered most there are the ones that look least like
 * features: skip what is already done, never let one bad file stop the run,
 * and write a log you can read while it is still going.
 */
import fs from "node:fs";
import path from "node:path";
import type { JobStore } from "./jobStore";
import { transcribeOne } from "./runFile";
import type { HelperSupervisor } from "./supervisor";
import { assembleTranscript } from "./transcript";
import { hasTranscript, mirroredOutputDir, relativeKey, walkMediaTree } from "./tree";
import { matchHint, type HintRule } from "./hints";
import { defaultOutputDir } from "./validateInput";
import type { SpeakerHint } from "./types";

export type FileStatus = "done" | "skipped" | "failed";

export interface FileOutcome {
  relativePath: string;
  outputDir: string;
  status: FileStatus;
  /** Transcribed from a re-encoded copy after the original failed. */
  recovered: boolean;
  speakerCount: number | null;
  error: string | null;
}

export interface TreeSummary {
  root: string;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  recovered: number;
  outcomes: FileOutcome[];
}

export interface RunTreeOptions {
  root: string;
  outRoot: string | null;
  locale: string;
  diarize: boolean;
  /** Fallback hint for files no rule matches. */
  speakerHint: SpeakerHint | null;
  hints: HintRule[];
  force: boolean;
  onJobStart?: (jobId: string) => void;
  /** Called before each file so the CLI can draw a `[3/43] name` header. */
  onFileStart?: (index: number, total: number, relativePath: string) => void;
  onFileEnd?: (outcome: FileOutcome) => void;
}

/** One file's resolved plan: where it goes, which rule chose its speaker count. */
export interface PlannedFile {
  mediaPath: string;
  relativePath: string;
  outputDir: string;
  /** The glob that matched, or null when falling back to the CLI's own flags. */
  matchedGlob: string | null;
  speakerHint: SpeakerHint | null;
  action: "transcribe" | "skip";
}

export interface TreePlan {
  root: string;
  files: PlannedFile[];
}

function hintToSpeakerHint(rule: HintRule): SpeakerHint {
  return { exact: rule.flags.speakers, min: rule.flags.minSpeakers, max: rule.flags.maxSpeakers };
}

/**
 * Resolves what a run *would* do, without transcribing anything.
 *
 * `runTree` executes this exact plan rather than recomputing as it goes, so
 * `--dry-run` cannot drift from the real thing — a preview that disagrees with
 * the run is worse than no preview, because you'd trust it.
 */
export function planTree(options: {
  root: string;
  outRoot: string | null;
  hints: HintRule[];
  speakerHint: SpeakerHint | null;
  force: boolean;
}): TreePlan {
  const root = path.resolve(options.root);
  const files = walkMediaTree(root).map((mediaPath): PlannedFile => {
    const relativePath = relativeKey(root, mediaPath);
    const outputDir = options.outRoot
      ? mirroredOutputDir(root, mediaPath, options.outRoot)
      : defaultOutputDir(mediaPath);
    const rule = matchHint(options.hints, relativePath);
    return {
      mediaPath,
      relativePath,
      outputDir,
      matchedGlob: rule?.glob ?? null,
      speakerHint: rule ? hintToSpeakerHint(rule) : options.speakerHint,
      action: !options.force && hasTranscript(outputDir) ? "skip" : "transcribe",
    };
  });
  return { root, files };
}

/** Appends one timestamped line to the run log; never throws into the batch. */
function makeLogger(logPath: string): (line: string) => void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* fall through — a failed log must not stop transcription */
  }
  return (line: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    try {
      fs.appendFileSync(logPath, `[${stamp}] ${line}\n`);
    } catch {
      /* the transcripts matter more than the log */
    }
  };
}

/**
 * Where the run log goes: under `--out` when given, else beside the media at
 * the walk root, mirroring where the transcripts themselves land.
 */
export function runLogPath(root: string, outRoot: string | null): string {
  return path.join(path.resolve(outRoot ?? root), "_run.log");
}

export async function runTree(
  supervisor: HelperSupervisor,
  store: JobStore,
  options: RunTreeOptions,
): Promise<TreeSummary> {
  const { root, files } = planTree(options);
  const log = makeLogger(runLogPath(root, options.outRoot));

  log(`=== run started · ${files.length} media files under ${root} ===`);

  const outcomes: FileOutcome[] = [];

  for (const [index, planned] of files.entries()) {
    const { mediaPath, relativePath, outputDir, speakerHint, matchedGlob } = planned;

    if (planned.action === "skip") {
      const outcome: FileOutcome = {
        relativePath,
        outputDir,
        status: "skipped",
        recovered: false,
        speakerCount: null,
        error: null,
      };
      outcomes.push(outcome);
      log(`skip  ${relativePath} (already transcribed)`);
      options.onFileEnd?.(outcome);
      continue;
    }

    options.onFileStart?.(index + 1, files.length, relativePath);
    log(`start ${relativePath}${matchedGlob ? ` · hint "${matchedGlob}"` : ""}`);

    // One file's failure is one file's failure. A throw here — not just a
    // failed job, but a bug in our own code — must not cost the other 42.
    let outcome: FileOutcome;
    try {
      const { job, recovered } = await transcribeOne(supervisor, store, {
        mediaPath,
        outputDir,
        locale: options.locale,
        diarize: options.diarize,
        speakerHint,
        onJobStart: options.onJobStart,
      });

      if (job.status === "done") {
        const speakerCount = assembleTranscript(job).metadata.speakerCount;
        outcome = { relativePath, outputDir, status: "done", recovered, speakerCount, error: null };
        log(`done  ${relativePath}${recovered ? " (recovered via re-encode)" : ""}`);
      } else {
        const error = job.error ? `${job.error.code}: ${job.error.message}` : "job did not complete";
        outcome = { relativePath, outputDir, status: "failed", recovered: false, speakerCount: null, error };
        log(`FAIL  ${relativePath} — ${error}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome = { relativePath, outputDir, status: "failed", recovered: false, speakerCount: null, error };
      log(`FAIL  ${relativePath} — ${error}`);
    }

    outcomes.push(outcome);
    options.onFileEnd?.(outcome);
  }

  const summary: TreeSummary = {
    root,
    total: files.length,
    done: outcomes.filter((o) => o.status === "done").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    recovered: outcomes.filter((o) => o.recovered).length,
    outcomes,
  };

  log(
    `=== run finished · ${summary.done} done, ${summary.skipped} skipped, ` +
      `${summary.failed} failed, ${summary.recovered} recovered ===`,
  );
  return summary;
}
