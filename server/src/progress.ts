/**
 * Spec §6: overall job progress is a monotonic mapping of helper stage
 * progress. With diarization enabled, `transcribe` maps to [0, TRANSCRIBE_SHARE]
 * and `diarize` maps to [TRANSCRIBE_SHARE, 1.0]; with `diarize: false`,
 * `transcribe` maps to [0, 1.0]. Per-event pct is clamped to [0, 1] first
 * (defensive against a malformed helper), then the running value is clamped to
 * never decrease — this alone absorbs the documented "duplicate final
 * progress{pct:1}" quirk (Task 2 note) since max(current, same-or-lower) is a
 * no-op.
 */

/**
 * Fraction of a diarized job's wall clock spent transcribing, used to weight
 * the two stages. Measured on a 60.1-minute two-speaker recording
 * (.superpowers/measurements/2026-08-05-one-hour-measurements.md): transcribe
 * ran 0→35.57s and diarize 35.57→53.75s, i.e. 66/34. The original 0.9/0.1
 * split was a guess made before any long-media measurement existed, and it
 * made every client sit at "90%" for a third of the job. Re-measure and update
 * this constant if either engine's throughput changes materially.
 */
export const TRANSCRIBE_SHARE = 0.65;
export function mapStageProgress(
  diarize: boolean,
  stage: "transcribe" | "diarize",
  pct: number,
): number {
  const clamped = Math.min(1, Math.max(0, pct));
  if (!diarize) {
    // A diarize-stage event should never arrive when diarize was disabled;
    // handled defensively rather than asserted, since the helper is a
    // separate, already-shipped binary.
    return stage === "diarize" ? 1 : clamped;
  }
  return stage === "transcribe"
    ? clamped * TRANSCRIBE_SHARE
    : TRANSCRIBE_SHARE + clamped * (1 - TRANSCRIBE_SHARE);
}

/** Stateful wrapper that enforces the "never decreases" clamp across a job. */
export class MonotonicProgress {
  private current = 0;

  constructor(private readonly diarize: boolean) {}

  apply(stage: "transcribe" | "diarize", pct: number): number {
    const mapped = mapStageProgress(this.diarize, stage, pct);
    this.current = Math.max(this.current, mapped);
    return this.current;
  }

  get value(): number {
    return this.current;
  }
}
