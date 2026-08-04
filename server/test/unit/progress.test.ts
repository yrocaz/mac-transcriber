import { describe, expect, it } from "vitest";
import { mapStageProgress, MonotonicProgress } from "../../src/progress";

describe("mapStageProgress", () => {
  it("maps transcribe to the full [0,1] range when diarize is disabled", () => {
    expect(mapStageProgress(false, "transcribe", 0)).toBe(0);
    expect(mapStageProgress(false, "transcribe", 0.5)).toBe(0.5);
    expect(mapStageProgress(false, "transcribe", 1)).toBe(1);
  });

  it("maps transcribe to [0,0.9] and diarize to [0.9,1] when diarize is enabled", () => {
    expect(mapStageProgress(true, "transcribe", 0)).toBe(0);
    expect(mapStageProgress(true, "transcribe", 0.5)).toBeCloseTo(0.45);
    expect(mapStageProgress(true, "transcribe", 1)).toBeCloseTo(0.9);

    expect(mapStageProgress(true, "diarize", 0)).toBeCloseTo(0.9);
    expect(mapStageProgress(true, "diarize", 0.5)).toBeCloseTo(0.95);
    expect(mapStageProgress(true, "diarize", 1)).toBeCloseTo(1.0);
  });

  it("clamps out-of-range pct defensively", () => {
    expect(mapStageProgress(false, "transcribe", -0.5)).toBe(0);
    expect(mapStageProgress(false, "transcribe", 1.5)).toBe(1);
  });
});

describe("MonotonicProgress", () => {
  it("never decreases, absorbing the duplicate-final-pct helper quirk", () => {
    const p = new MonotonicProgress(false);
    expect(p.apply("transcribe", 0.4)).toBe(0.4);
    expect(p.apply("transcribe", 1)).toBe(1);
    // Task 2 note: a duplicate final progress{pct:1} line can occur.
    expect(p.apply("transcribe", 1)).toBe(1);
  });

  it("handles the diarize split monotonically across both stages", () => {
    const p = new MonotonicProgress(true);
    expect(p.apply("transcribe", 0.5)).toBeCloseTo(0.45);
    expect(p.apply("transcribe", 1)).toBeCloseTo(0.9);
    expect(p.apply("transcribe", 1)).toBeCloseTo(0.9); // duplicate final transcribe pct
    expect(p.apply("diarize", 0.5)).toBeCloseTo(0.95);
    expect(p.apply("diarize", 1)).toBeCloseTo(1.0);
    expect(p.apply("diarize", 1)).toBeCloseTo(1.0); // duplicate final diarize pct (Task 2 note)
  });

  it("never reports a lower value even if a stray low-pct event arrives late", () => {
    const p = new MonotonicProgress(true);
    p.apply("diarize", 0.9);
    expect(p.value).toBeCloseTo(0.99);
    const result = p.apply("transcribe", 0.1); // stray/out-of-order event
    expect(result).toBeCloseTo(0.99);
    expect(p.value).toBeCloseTo(0.99);
  });
});
