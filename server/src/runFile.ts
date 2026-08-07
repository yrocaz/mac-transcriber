/**
 * One media file, end to end: create the job, run the helper, and — when the
 * failure looks like damaged media — re-encode and try once more.
 *
 * Extracted from cli.ts so single-file and tree mode run *identical* code.
 * A second copy of this lifecycle for batches is exactly how the two surfaces
 * drift apart, and the batch path is the one nobody watches closely.
 */
import { newJobId } from "./idgen";
import type { JobStore } from "./jobStore";
import { isLikelyDamagedMedia, withReencoded } from "./recover";
import type { HelperSupervisor } from "./supervisor";
import type { JobRecord, SpeakerHint } from "./types";

export interface TranscribeOneOptions {
  mediaPath: string;
  outputDir: string;
  locale: string;
  diarize: boolean;
  speakerHint: SpeakerHint | null;
  /**
   * Called with each job id as it starts, including the recovery attempt's.
   * The CLI uses it to keep the progress bar pointed at the live job — a bar
   * polling the first job's id would freeze at 62% through the whole recovery.
   */
  onJobStart?: (jobId: string) => void;
  /** Set false to disable the re-encode fallback (used by tests). */
  recover?: boolean;
  /**
   * Injectable re-encoder, defaulting to the real `afconvert` one. Tests
   * substitute a stub: the fake helper never opens its input, so unit
   * fixtures are zero-byte files that `afconvert` cannot convert.
   */
  reencode?: typeof withReencoded;
}

export interface TranscribeOneResult {
  job: JobRecord;
  /** True when the transcript came from a re-encoded copy of the input. */
  recovered: boolean;
}

/**
 * Runs one file, returning the final job record whatever its status. Callers
 * decide what a failure means — tree mode logs and continues, single-file mode
 * exits non-zero.
 */
export async function transcribeOne(
  supervisor: HelperSupervisor,
  store: JobStore,
  options: TranscribeOneOptions,
): Promise<TranscribeOneResult> {
  const { mediaPath, outputDir, locale, diarize, speakerHint } = options;

  const start = (path: string): JobRecord => {
    const job = store.createJob({ id: newJobId(), path, locale, diarize, speakerHint, outputDir });
    options.onJobStart?.(job.id);
    return job;
  };

  const first = start(mediaPath);
  await supervisor.run(first, store);
  const afterFirst = store.getJob(first.id) ?? first;

  if (afterFirst.status === "done") return { job: afterFirst, recovered: false };
  if (options.recover === false || !isLikelyDamagedMedia(afterFirst)) {
    return { job: afterFirst, recovered: false };
  }

  // Damaged-media path. Deliberately a single attempt against a *different*
  // input — see recover.ts for why repeating the same input cannot help.
  const reencode = options.reencode ?? withReencoded;
  try {
    return await reencode(mediaPath, async (wavPath) => {
      const second = start(wavPath);
      await supervisor.run(second, store);
      const afterSecond = store.getJob(second.id) ?? second;
      if (afterSecond.status !== "done") {
        // Report the *original* failure: "the re-encode also failed" is less
        // actionable than the fault that triggered recovery in the first place.
        return { job: afterFirst, recovered: false };
      }

      // Rewrite provenance before the transcripts are re-rendered. `transcript.ts`
      // takes `metadata.source` from `job.path`, and the readable header takes
      // its title from that basename — so without this the transcript would
      // name a temp file that is deleted moments later. This exact mistake was
      // made by hand during the archive run and had to be patched afterwards.
      const repaired = store.updateJob(afterSecond.id, {
        path: mediaPath,
        warnings: [
          ...afterSecond.warnings,
          {
            code: "recoveredByReencode",
            message:
              `Source media failed at ${(afterFirst.progress * 100).toFixed(1)}% ` +
              `(${afterFirst.error?.code ?? "unknown"}); transcribed from an afconvert WAV re-encode.`,
          },
        ],
      });
      store.writeTranscripts(repaired);
      return { job: repaired, recovered: true };
    });
  } catch {
    // afconvert missing or unable to decode: keep the original diagnosis.
    return { job: afterFirst, recovered: false };
  }
}
