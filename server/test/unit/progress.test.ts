import { describe, expect, it } from "vitest";
import { mapStageProgress, MonotonicProgress, TRANSCRIBE_SHARE } from "../../src/progress";

describe("mapStageProgress", () => {
  it("maps transcribe to the full [0,1] range when diarize is disabled", () => {
    expect(mapStageProgress(false, "transcribe", 0)).toBe(0);
    expect(mapStageProgress(false, "transcribe", 0.5)).toBe(0.5);
    expect(mapStageProgress(false, "transcribe", 1)).toBe(1);
  });

  it("maps transcribe to [0,TRANSCRIBE_SHARE] and diarize to [TRANSCRIBE_SHARE,1] when diarize is enabled", () => {
    expect(mapStageProgress(true, "transcribe", 0)).toBe(0);
    expect(mapStageProgress(true, "transcribe", 0.5)).toBeCloseTo(TRANSCRIBE_SHARE * 0.5);
    expect(mapStageProgress(true, "transcribe", 1)).toBeCloseTo(TRANSCRIBE_SHARE);

    expect(mapStageProgress(true, "diarize", 0)).toBeCloseTo(TRANSCRIBE_SHARE);
    expect(mapStageProgress(true, "diarize", 0.5)).toBeCloseTo(TRANSCRIBE_SHARE + (1 - TRANSCRIBE_SHARE) * 0.5);
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
    expect(p.apply("transcribe", 0.5)).toBeCloseTo(TRANSCRIBE_SHARE * 0.5);
    expect(p.apply("transcribe", 1)).toBeCloseTo(TRANSCRIBE_SHARE);
    expect(p.apply("transcribe", 1)).toBeCloseTo(TRANSCRIBE_SHARE); // duplicate final transcribe pct
    expect(p.apply("diarize", 0.5)).toBeCloseTo(TRANSCRIBE_SHARE + (1 - TRANSCRIBE_SHARE) * 0.5);
    expect(p.apply("diarize", 1)).toBeCloseTo(1.0);
    expect(p.apply("diarize", 1)).toBeCloseTo(1.0); // duplicate final diarize pct (Task 2 note)
  });

  it("never reports a lower value even if a stray low-pct event arrives late", () => {
    const p = new MonotonicProgress(true);
    p.apply("diarize", 0.9);
    expect(p.value).toBeCloseTo(TRANSCRIBE_SHARE + (1 - TRANSCRIBE_SHARE) * 0.9);
    const result = p.apply("transcribe", 0.1); // stray/out-of-order event
    expect(result).toBeCloseTo(TRANSCRIBE_SHARE + (1 - TRANSCRIBE_SHARE) * 0.9);
    expect(p.value).toBeCloseTo(TRANSCRIBE_SHARE + (1 - TRANSCRIBE_SHARE) * 0.9);
  });

  it("a diarize-stage keepalive tick (pct:0) is a no-op once transcribe has reached 1.0 (Critical 1)", () => {
    // Pins existing MonotonicProgress/mapStageProgress behavior — this file
    // isn't touched by the Critical 1 fix, so this test passes identically
    // before and after it; it's a characterization test for the invariant
    // the fix depends on ("model_download doesn't move progress" already
    // held for the model_download event type; this documents that the same
    // holds for a synthetic diarize-stage pct:0 tick used as a keepalive),
    // not a regression test for the fix itself. Two other things this test
    // does NOT cover, verified separately (see the final fix report):
    // (1) the fake-helper pair in supervisor.test.ts ("Critical 1 —
    // diarization keepalive vs. the inactivity timeout") exercises the
    // SERVER's side of the contract (any NDJSON line resets the inactivity
    // timer; a post-transcription error still persists segments) against
    // canned NDJSON — it does not invoke the real Swift helper or
    // KeepAliveTicker at all, and would pass unchanged even if
    // KeepAliveTicker were deleted. (2) That the real helper binary
    // actually emits the `{"pct":0,"stage":"diarize","type":"progress"}`
    // tick immediately before diarization (the HELPER side of the
    // contract) was verified directly by running
    // `speech-helper transcribe --input test-fixtures/two-voice-interview.wav`
    // and inspecting its stdout.
    const p = new MonotonicProgress(true);
    p.apply("transcribe", 1); // mapped to TRANSCRIBE_SHARE
    expect(p.value).toBeCloseTo(TRANSCRIBE_SHARE);

    const afterFirstTick = p.apply("diarize", 0); // maps to TRANSCRIBE_SHARE + 0 = TRANSCRIBE_SHARE
    expect(afterFirstTick).toBeCloseTo(TRANSCRIBE_SHARE);
    expect(p.value).toBeCloseTo(TRANSCRIBE_SHARE);

    // Repeated ticks (the periodic keepalive) are equally inert.
    p.apply("diarize", 0);
    p.apply("diarize", 0);
    expect(p.value).toBeCloseTo(TRANSCRIBE_SHARE);
  });
});
