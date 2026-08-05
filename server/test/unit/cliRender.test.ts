import { describe, expect, it } from "vitest";
import {
  estimateRemaining,
  formatDuration,
  isIndeterminate,
  phaseLabel,
  renderBar,
  renderHeader,
  renderStatusLine,
  spinnerFrame,
} from "../../src/cliRender";
import { derivePhase } from "../../src/cli";
import { TRANSCRIBE_SHARE } from "../../src/progress";
import type { JobRecord } from "../../src/types";

function job(patch: Partial<JobRecord>): JobRecord {
  return {
    id: "abc123",
    path: "/tmp/a.wav",
    locale: "en-US",
    diarize: true,
    status: "running",
    progress: 0,
    warnings: [],
    error: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: null,
    durationSec: 100,
    stderrTail: null,
    segments: [],
    speakers: null,
    ...patch,
  };
}

describe("renderBar", () => {
  it("fills proportionally and always returns exactly `width` cells", () => {
    expect(renderBar(0, 10)).toBe("░░░░░░░░░░");
    expect(renderBar(1, 10)).toBe("██████████");
    expect(renderBar(0.5, 10)).toBe("█████░░░░░");
    for (const f of [0, 0.13, 0.5, 0.77, 1]) {
      expect([...renderBar(f, 17)]).toHaveLength(17);
    }
  });

  it("clamps out-of-range fractions instead of trusting the helper", () => {
    // Progress arrives from a separate process; a malformed value must not
    // produce a negative repeat count (which throws) or an over-long line.
    expect(renderBar(-0.5, 6)).toBe("░░░░░░");
    expect(renderBar(42, 6)).toBe("██████");
  });
});

describe("formatDuration", () => {
  it("uses m:ss under an hour and h:mm:ss past it", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(2589.9)).toBe("43:10");
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("renders unusable input as a placeholder rather than NaN", () => {
    expect(formatDuration(Number.NaN)).toBe("--:--");
    expect(formatDuration(-1)).toBe("--:--");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("--:--");
  });
});

describe("estimateRemaining", () => {
  it("extrapolates from observed throughput", () => {
    // 25% done in 10s implies 30s left.
    expect(estimateRemaining(0.25, 10)).toBeCloseTo(30, 5);
    expect(estimateRemaining(0.5, 20)).toBeCloseTo(20, 5);
  });

  it("returns null when an estimate would be untrustworthy", () => {
    expect(estimateRemaining(0.05, 10)).toBeNull(); // too early to extrapolate
    expect(estimateRemaining(1, 10)).toBeNull(); // finished
    expect(estimateRemaining(0.5, 0)).toBeNull(); // no elapsed time yet
    expect(estimateRemaining(Number.NaN, 10)).toBeNull();
  });
});

describe("renderStatusLine", () => {
  it("shows a spinner and no percentage while indeterminate", () => {
    const line = renderStatusLine({
      phase: "preparing",
      fraction: 0,
      elapsedSec: 3,
      columns: 80,
      tick: 0,
    });
    expect(line).toContain("Preparing");
    expect(line).not.toContain("%");
    expect(line).not.toContain("█");
  });

  it("shows label, bar and percentage once determinate", () => {
    const line = renderStatusLine({
      phase: "transcribing",
      fraction: 0.42,
      elapsedSec: 10,
      columns: 80,
      tick: 0,
    });
    expect(line).toContain("Transcribing");
    expect(line).toContain("42%");
    expect(line).toContain("█");
  });

  it("never exceeds the terminal width, so in-place redraw can't wrap", () => {
    // A wrapped line breaks \r redraw and leaves a trail of stale bars.
    for (const columns of [40, 60, 80, 120, 200]) {
      const line = renderStatusLine({
        phase: "identifying",
        fraction: 0.9,
        elapsedSec: 30,
        columns,
        tick: 2,
      });
      expect([...line].length).toBeLessThanOrEqual(columns);
    }
  });

  it("omits the ETA before there is enough progress to extrapolate", () => {
    const early = renderStatusLine({
      phase: "transcribing",
      fraction: 0.02,
      elapsedSec: 1,
      columns: 80,
      tick: 0,
    });
    const later = renderStatusLine({
      phase: "transcribing",
      fraction: 0.5,
      elapsedSec: 20,
      columns: 80,
      tick: 0,
    });
    expect(early.trimEnd()).toMatch(/\d+%$/);
    expect(later).toMatch(/\d+:\d\d$/);
  });
});

describe("spinnerFrame", () => {
  it("cycles and tolerates unbounded or negative ticks", () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(10));
    expect(spinnerFrame(-1)).toBeTruthy();
    expect(spinnerFrame(1_000_003)).toBeTruthy();
  });
});

describe("renderHeader", () => {
  it("includes the duration when known and omits it when not", () => {
    expect(renderHeader("Panel.wav", 2589.9)).toBe("  Panel.wav · 43:10");
    expect(renderHeader("Panel.wav", null)).toBe("  Panel.wav");
  });
});

describe("phase derivation", () => {
  it("treats the pre-`ready` window as indeterminate preparing", () => {
    // durationSec is set by the helper's `ready` event, which fires only after
    // file open and any MP3 repair — so its absence IS the silent window.
    expect(derivePhase(job({ durationSec: null }))).toBe("preparing");
    expect(isIndeterminate("preparing")).toBe(true);
  });

  it("switches from transcribing to identifying at the measured split", () => {
    expect(derivePhase(job({ progress: TRANSCRIBE_SHARE - 0.01 }))).toBe("transcribing");
    expect(derivePhase(job({ progress: TRANSCRIBE_SHARE }))).toBe("identifying");
  });

  it("never reports identifying when diarization is disabled", () => {
    expect(derivePhase(job({ diarize: false, progress: 0.99 }))).toBe("transcribing");
  });

  it("reports done for both terminal statuses", () => {
    expect(derivePhase(job({ status: "done", progress: 1 }))).toBe("done");
    expect(derivePhase(job({ status: "error" }))).toBe("done");
  });

  it("labels every phase", () => {
    for (const p of ["preparing", "downloading", "transcribing", "identifying", "done"] as const) {
      expect(phaseLabel(p).length).toBeGreaterThan(0);
    }
  });
});
