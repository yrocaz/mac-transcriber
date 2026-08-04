/**
 * Spec §6: overall job progress is a monotonic mapping of helper stage
 * progress. With diarization enabled, `transcribe` maps to [0, 0.9] and
 * `diarize` maps to [0.9, 1.0]; with `diarize: false`, `transcribe` maps to
 * [0, 1.0]. Per-event pct is clamped to [0, 1] first (defensive against a
 * malformed helper), then the running value is clamped to never decrease —
 * this alone absorbs the documented "duplicate final progress{pct:1}" quirk
 * (Task 2 note) since max(current, same-or-lower) is a no-op.
 */
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
  return stage === "transcribe" ? clamped * 0.9 : 0.9 + clamped * 0.1;
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
