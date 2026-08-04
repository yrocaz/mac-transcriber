import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildApp, type BuiltApp } from "../../src/app";
import { DEFAULT_TIMEOUTS, type AppConfig } from "../../src/config";
import { waitFor, makeTempDataDir } from "../helpers/testApp";

// Real end-to-end suite (spec §7): spawns the actual speech-helper release
// binary, transcribing real media through the full HTTP API. macOS only.
// Kept separate from the fake-helper unit suite (`npm test`) via
// vitest.e2e.config.ts / `npm run test:e2e` so the unit suite stays fast
// and hermetic.
//
// First-run cost: the helper's diarizer downloads CoreML models from
// HuggingFace on first use (network required once, then fully offline).
// The beforeAll warm-up below absorbs that cost so individual test bodies
// aren't the ones eating the download time.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HELPER_DIR = path.join(REPO_ROOT, "helper");
const HELPER_PATH = path.join(HELPER_DIR, ".build", "release", "speech-helper");
const FIXTURES_DIR = path.join(REPO_ROOT, "test-fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

function ensureHelperBuilt(): boolean {
  if (process.platform !== "darwin") {
    console.warn("[e2e] Not running on macOS; SpeechAnalyzer/FluidAudio require macOS. Skipping E2E suite.");
    return false;
  }
  if (fs.existsSync(HELPER_PATH)) {
    return true;
  }

  console.warn(`[e2e] ${HELPER_PATH} not found; building via \`swift build -c release\` in ${HELPER_DIR}...`);
  try {
    execFileSync("swift", ["build", "-c", "release"], {
      cwd: HELPER_DIR,
      stdio: "inherit",
      timeout: 5 * 60_000,
    });
  } catch (err) {
    console.warn(
      "[e2e] Could not build speech-helper (swift/Xcode toolchain unavailable, or the build failed). " +
        "Skipping E2E suite. Underlying error:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
  return fs.existsSync(HELPER_PATH);
}

const HELPER_AVAILABLE = ensureHelperBuilt();

const MALFORMED_MP3_PATH = fixture("malformed.mp3");
const MALFORMED_MP3_AVAILABLE = fs.existsSync(MALFORMED_MP3_PATH);
if (HELPER_AVAILABLE && !MALFORMED_MP3_AVAILABLE) {
  console.warn(
    "[e2e] test-fixtures/malformed.mp3 not found; skipping the MP3 tail-probe/repair test. " +
      "Run `scripts/make-fixtures.sh` to generate it (requires the source system MP3 to be present on this Mac).",
  );
}

describe.skipIf(!HELPER_AVAILABLE)("E2E: real speech-helper (macOS only)", () => {
  let built: BuiltApp;

  beforeAll(async () => {
    const config: AppConfig = {
      dataDir: makeTempDataDir(),
      helperPath: HELPER_PATH,
      host: "127.0.0.1",
      port: 0,
      timeouts: DEFAULT_TIMEOUTS,
    };
    built = buildApp(config);

    // Warm-up: run one diarized job first so a first-run model download
    // lands here, not inside a timed assertion below.
    console.warn("[e2e] Warm-up run (first-run model download can take a while; subsequent runs are fast)...");
    const create = await built.app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixture("speech-short.aiff"), diarize: true },
    });
    const { id } = JSON.parse(create.payload) as { id: string };
    await waitFor(
      () => {
        const status = built.store.getJob(id)?.status;
        return status === "done" || status === "error";
      },
      { timeoutMs: 10 * 60_000, intervalMs: 500 },
    );
    console.warn(`[e2e] Warm-up job ${id} finished with status ${built.store.getJob(id)?.status}.`);
  }, 15 * 60_000);

  it("single-voice fixture: POST -> poll -> transcript text matches known content", async () => {
    const create = await built.app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixture("speech-short.aiff") },
    });
    expect(create.statusCode).toBe(202);
    const { id, status } = JSON.parse(create.payload) as { id: string; status: string };
    expect(status).toBe("queued");

    await waitFor(() => built.store.getJob(id)?.status === "done", { timeoutMs: 5 * 60_000, intervalMs: 250 });

    const res = await built.app.inject({ method: "GET", url: `/jobs/${id}/transcript.json` });
    expect(res.statusCode).toBe(200);
    const transcript = JSON.parse(res.payload);

    // Tolerant match: SpeechAnalyzer's exact punctuation/segmentation can
    // shift slightly across macOS/model versions (see scripts/make-fixtures.sh),
    // so normalize before comparing rather than requiring an exact string.
    const normalized = (transcript.text as string)
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    expect(normalized).toContain("quick brown fox");
    expect(normalized).toContain("runs entirely on device");
    expect(transcript.metadata.engine).toBe("apple-speechanalyzer");
    expect(transcript.metadata.source).toBe(fixture("speech-short.aiff"));
  });

  it("two-voice fixture: speakerCount is 2 and segments carry S1/S2", async () => {
    const create = await built.app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixture("two-voice-interview.wav"), diarize: true },
    });
    const { id } = JSON.parse(create.payload) as { id: string };

    await waitFor(() => built.store.getJob(id)?.status === "done", { timeoutMs: 5 * 60_000, intervalMs: 500 });

    const res = await built.app.inject({ method: "GET", url: `/jobs/${id}/transcript.json` });
    expect(res.statusCode).toBe(200);
    const transcript = JSON.parse(res.payload);

    expect(transcript.metadata.diarization).toBe("ok");
    expect(transcript.metadata.speakerCount).toBe(2);
    expect(transcript.segments.length).toBeGreaterThan(0);

    const speakers = new Set(transcript.segments.map((s: { speaker: string | null }) => s.speaker));
    expect(speakers.has("S1")).toBe(true);
    expect(speakers.has("S2")).toBe(true);
    for (const seg of transcript.segments) {
      expect(["S1", "S2"]).toContain(seg.speaker);
    }
  });

  it("sample-5s.mp4 (music, no speech): completes done with an empty transcript and a diarization warning", async () => {
    const create = await built.app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixture("sample-5s.mp4"), diarize: true },
    });
    const { id } = JSON.parse(create.payload) as { id: string };

    await waitFor(
      () => {
        const status = built.store.getJob(id)?.status;
        return status === "done" || status === "error";
      },
      { timeoutMs: 5 * 60_000, intervalMs: 500 },
    );

    const jobRes = await built.app.inject({ method: "GET", url: `/jobs/${id}` });
    const job = JSON.parse(jobRes.payload);
    expect(job.status).toBe("done");
    // Real, expected outcome (Task 2 report): FluidAudio raises
    // noSpeechDetected on this clip -> a non-fatal diarizationFailed
    // warning, job still completes. Assert the warning is present, not
    // that warnings are empty.
    expect(job.warnings.some((w: { code: string }) => w.code === "diarizationFailed")).toBe(true);

    const res = await built.app.inject({ method: "GET", url: `/jobs/${id}/transcript.json` });
    const transcript = JSON.parse(res.payload);
    expect(transcript.segments).toHaveLength(0);
    expect(transcript.text).toBe("");
    expect(transcript.metadata.diarization).toBe("failed");
    expect(transcript.metadata.speakerCount).toBeNull();
  });

  it("transcript.srt route returns well-formed SRT", async () => {
    const create = await built.app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixture("speech-short.aiff") },
    });
    const { id } = JSON.parse(create.payload) as { id: string };

    await waitFor(() => built.store.getJob(id)?.status === "done", { timeoutMs: 5 * 60_000, intervalMs: 250 });

    const res = await built.app.inject({ method: "GET", url: `/jobs/${id}/transcript.srt` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const srt = res.payload as string;
    const blocks = srt.trim().split(/\n\n+/);
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((block, i) => {
      const lines = block.split("\n");
      expect(lines[0]).toBe(String(i + 1));
      expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
      expect(lines[2]?.length ?? 0).toBeGreaterThan(0);
    });
  });

  it("/health reports the helper available with installed locales", async () => {
    const res = await built.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
    expect(body.helper.available).toBe(true);
    expect(Array.isArray(body.helper.installedLocales)).toBe(true);
    expect(body.helper.installedLocales.length).toBeGreaterThan(0);
    expect(body.helper.installedLocales).toContain("en-US");
  });

  // Uses the shared `built` app (production DEFAULT_TIMEOUTS) — this now
  // deliberately proves the production startup-timeout budget survives a
  // real repair, not just a test-only accommodation. History: discovered
  // while writing this suite that AVAssetExportSession(presetName:
  // .appleM4A) — the exact call AudioPreparer.repair() makes — takes ~90s
  // to re-export this ~32.7s MP3 on this machine, reproducibly, for a
  // WELL-FORMED MP3 too (isolated with a standalone Swift script calling
  // only AVAssetExportSession, outside the helper entirely) and even for a
  // 6.6s AIFF (not an MP3 at all) — ruling out "proportional to audio
  // length" or "MP3-decode-specific" and pointing at a fixed per-call
  // AVAssetExportSession overhead in this environment. That exceeded the
  // original 60s startup timeout (spec §6, "covers file-open and MP3
  // repair"), so the repair path was killed as a startup timeout before
  // `ready` — dead on arrival for the exact case it exists to handle.
  // Controller-authorized fix (config.ts, DEFAULT_TIMEOUTS.startupTimeoutMs
  // 60s -> 180s): comfortable margin over the ~90s measurement while still
  // catching a genuinely hung/missing helper. See the Task 5 report for
  // the full writeup and measurements.
  it.skipIf(!MALFORMED_MP3_AVAILABLE)(
    "malformed MP3 fixture: the tail-probe/repair path produces a correct transcript",
    async () => {
      const create = await built.app.inject({
        method: "POST",
        url: "/jobs",
        payload: { path: MALFORMED_MP3_PATH, diarize: false },
      });
      expect(create.statusCode).toBe(202);
      const { id } = JSON.parse(create.payload) as { id: string };

      await waitFor(
        () => {
          const status = built.store.getJob(id)?.status;
          return status === "done" || status === "error";
        },
        { timeoutMs: 6 * 60_000, intervalMs: 500 },
      );

      const jobRes = await built.app.inject({ method: "GET", url: `/jobs/${id}` });
      const job = JSON.parse(jobRes.payload);
      expect(job.status).toBe("done");
      expect(job.error).toBeNull();

      // The fixture's Xing header lies that the file is ~131s long (4x the
      // real ~32.7s). If AudioPreparer's tail-probe/repair path hadn't
      // kicked in, this job would either error out on the inflated tail
      // read or report a duration close to the lie. A correct duration
      // well below it is exactly what a successful repair produces.
      expect(job.durationSec).toBeGreaterThan(10);
      expect(job.durationSec).toBeLessThan(60);

      const res = await built.app.inject({ method: "GET", url: `/jobs/${id}/transcript.json` });
      expect(res.statusCode).toBe(200);
      const transcript = JSON.parse(res.payload);
      expect(transcript.segments.length).toBeGreaterThan(0);
      expect(transcript.text.toLowerCase()).toContain("hello");
    },
    6 * 60_000,
  );
});
