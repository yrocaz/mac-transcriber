import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, DEFAULT_TIMEOUTS } from "../../src/config";

describe("DEFAULT_TIMEOUTS", () => {
  it("pins the startup timeout at 180s (spec §6)", () => {
    // Startup covers file-open AND the MP3 tail-probe/repair path: a
    // malformed MP3's AVAssetExportSession re-export was measured taking
    // up to ~90s during Task 5's E2E verification, which the original 60s
    // budget didn't survive (the repair path was killed as a startup
    // timeout before it could finish, even though the repair itself was
    // correct). Pinned here as an explicit assertion, not left incidental,
    // so a future change to this value is a deliberate edit, not a silent
    // regression back to a budget the repair path can't meet.
    expect(DEFAULT_TIMEOUTS.startupTimeoutMs).toBe(180_000);
  });

  it("leaves the other timeouts unchanged (spec §6)", () => {
    expect(DEFAULT_TIMEOUTS.inactivityTimeoutMs).toBe(120_000);
    expect(DEFAULT_TIMEOUTS.totalRuntimeMultiplier).toBe(2);
    expect(DEFAULT_TIMEOUTS.totalRuntimeFloorMs).toBe(10 * 60 * 1000);
  });
});

describe("DEFAULT_LOCALE", () => {
  it("defaults to en-US", () => {
    expect(DEFAULT_LOCALE).toBe("en-US");
  });
});
