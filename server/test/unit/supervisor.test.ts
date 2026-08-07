import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobStore";
import { HelperSupervisor } from "../../src/supervisor";
import { DEFAULT_TIMEOUTS } from "../../src/config";
import { FAKE_HELPER_PATH, FAST_TIMEOUTS, fixtureMediaPath, makeTempDataDir } from "../helpers/testApp";

function makeStore(): JobStore {
  const store = new JobStore(makeTempDataDir());
  store.init();
  return store;
}

/** Like makeStore(), but also returns the backing data dir so a test can
 * assert on what actually landed on disk (transcript.json/srt), not just
 * the in-memory record. */
function makeStoreWithDir(): { store: JobStore; dataDir: string } {
  const dataDir = makeTempDataDir();
  const store = new JobStore(dataDir);
  store.init();
  return { store, dataDir };
}

describe("HelperSupervisor: happy path", () => {
  it("runs a full diarized job to completion, persisting segments, speakers, and clamped progress", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j1", path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j1")!;
    expect(finished.status).toBe("done");
    expect(finished.progress).toBe(1);
    expect(finished.durationSec).toBe(10);
    expect(finished.segments).toEqual([
      { start: 0, end: 2, text: "Hello there.", confidence: null, lowTokens: [] },
      { start: 2, end: 4, text: "General Kenobi.", confidence: null, lowTokens: [] },
    ]);
    expect(finished.speakers).toEqual({
      count: 2,
      segments: [
        { start: 0, end: 2, speaker: "S1" },
        { start: 2, end: 4, speaker: "S2" },
      ],
    });
    expect(finished.startedAt).not.toBeNull();
    expect(finished.finishedAt).not.toBeNull();
  });

  it("maps transcribe to the full [0,1] range when diarize is false and skips diarize stage data", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j2", path: fixtureMediaPath("no-diarize.wav"), locale: "en-US", diarize: false });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j2")!;
    expect(finished.status).toBe("done");
    expect(finished.progress).toBe(1);
    expect(finished.speakers).toBeNull();
    expect(finished.segments).toEqual([
      { start: 0, end: 2, text: "Solo segment.", confidence: null, lowTokens: [] },
    ]);
  });

  it("persists warning events into warnings[] and still completes the job", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j3", path: fixtureMediaPath("warning.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j3")!;
    expect(finished.status).toBe("done");
    expect(finished.warnings).toEqual([{ code: "diarizationFailed", message: "model download failed" }]);
  });
});

describe("HelperSupervisor: terminal helper error", () => {
  it("finalizes as error with the helper's code/message on a terminal `error` event", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j4", path: fixtureMediaPath("helper-error.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j4")!;
    expect(finished.status).toBe("error");
    expect(finished.error).toEqual({ code: "audioReadFailed", message: "could not read audio track" });
    expect(finished.stderrTail).toContain("diagnostic before terminal error");
  });

  it("finalizes as error(unknown) if the process exits without a terminal event", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j5", path: fixtureMediaPath("crash-silent.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j5")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("unknown");
  });

  it("finalizes as error(spawnFailed) and still resolves when the helper binary itself is missing", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j10", path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({
      helperPath: "/definitely/does/not/exist/speech-helper",
      timeouts: DEFAULT_TIMEOUTS,
    });
    // A spawn-level ENOENT never fires the child's `exit` event; run()
    // resolving at all (rather than hanging) is the assertion.
    await supervisor.run(job, store);

    const finished = store.getJob("j10")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("spawnFailed");
  }, 5_000);

  it("does not wedge subsequent jobs after a spawn failure (queue keeps moving)", async () => {
    const store = makeStore();
    const failing = store.createJob({ id: "j11a", path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true });
    const healthy = store.createJob({ id: "j11b", path: fixtureMediaPath("basic2.wav"), locale: "en-US", diarize: true });

    const badSupervisor = new HelperSupervisor({
      helperPath: "/definitely/does/not/exist/speech-helper",
      timeouts: DEFAULT_TIMEOUTS,
    });
    await badSupervisor.run(failing, store);
    expect(store.getJob("j11a")?.status).toBe("error");

    // Simulates the queue moving on to the next job with a working helper.
    const goodSupervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
    await goodSupervisor.run(healthy, store);
    expect(store.getJob("j11b")?.status).toBe("done");
  }, 5_000);
});

describe("HelperSupervisor: the three timeouts", () => {
  it("kills and errors the job if `ready` never arrives within the startup timeout", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j6", path: fixtureMediaPath("startup-timeout.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j6")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("startupTimeout");
  }, 10_000);

  it("kills and errors the job if no event arrives within the inactivity timeout", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j7", path: fixtureMediaPath("inactivity-timeout.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j7")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("inactivityTimeout");
  }, 10_000);

  it("kills and errors the job if total runtime exceeds max(2*durationSec, floor)", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j8", path: fixtureMediaPath("total-timeout.wav"), locale: "en-US", diarize: true });

    // total-timeout.wav emits ready{durationSec:0.01} then activity every
    // 50ms forever, so inactivity never trips; only the total-runtime
    // timeout (floor 120ms from FAST_TIMEOUTS) can end this job.
    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j8")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("totalTimeout");
  }, 10_000);

  it("captures a stderr tail on a timeout-driven failure when the helper wrote to stderr", async () => {
    const store = makeStore();
    const job = store.createJob({ id: "j9", path: fixtureMediaPath("stderr-then-hang.wav"), locale: "en-US", diarize: true });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j9")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("inactivityTimeout");
    expect(finished.stderrTail).toContain("diagnostic line for stderr capture test");
  }, 10_000);
});

describe("HelperSupervisor: Critical 1 — diarization keepalive vs. the inactivity timeout", () => {
  // Spec §6 review finding: FluidAudio's diarization model
  // download/prepareModels() window emits nothing on stdout on its own
  // (unlike Apple's AssetInventory path, which reports its own
  // model_download progress) — without a keepalive, that silence can
  // exceed the inactivity budget and kill an otherwise-healthy,
  // already-transcribed job. These two scenarios are a matched pair that
  // differ only in whether keepalive ticks are present, so together they
  // discriminate "the timeout logic works" from "this job just happened to
  // finish in time."

  it("errors with inactivityTimeout when silence follows real segments, but still persists the transcript to disk", async () => {
    const { store, dataDir } = makeStoreWithDir();
    const job = store.createJob({
      id: "j14",
      path: fixtureMediaPath("diarize-silent-after-segments.wav"),
      locale: "en-US",
      diarize: true,
    });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j14")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("inactivityTimeout");

    // The discriminating assertion: segments transcribed before the silence
    // hit disk even though the job ultimately errored. Reading job.segments
    // off the in-memory record would pass regardless of the fix (the
    // `segment` event handler always populates it); reading the actual
    // transcript.json file only passes once supervisor.ts's error-finalize
    // paths call store.writeTranscripts() (Critical 1b).
    const transcriptPath = path.join(dataDir, "jobs", "j14", "transcript.json");
    expect(fs.existsSync(transcriptPath)).toBe(true);
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    expect(transcript.segments).toEqual([
      { id: 0, start: 0, end: 2, text: "Hello there.", speaker: null, confidence: null },
      { id: 1, start: 2, end: 4, text: "General Kenobi.", speaker: null, confidence: null },
    ]);

    const srtPath = path.join(dataDir, "jobs", "j14", "transcript.srt");
    expect(fs.existsSync(srtPath)).toBe(true);
  }, 10_000);

  it("stays alive past the inactivity budget and reaches done when diarize-stage keepalive ticks arrive", async () => {
    const store = makeStore();
    const job = store.createJob({
      id: "j15",
      path: fixtureMediaPath("diarize-keepalive-then-done.wav"),
      locale: "en-US",
      diarize: true,
    });

    // Same FAST_TIMEOUTS.inactivityTimeoutMs (400ms) as the sibling test
    // above; the fixture's ticks are spaced 150ms apart across ~900ms —
    // longer than the budget — so reaching "done" here is only possible
    // because each tick resets the inactivity timer before it can fire.
    // NOTE on scope: this is canned NDJSON from fake-helper.sh, not the
    // real Swift helper — it proves the SERVER correctly treats a
    // diarize-stage tick as activity (a mechanism that already existed:
    // resetInactivityTimer() fires on any parsed line, unconditional of
    // event type). It does not, by itself, prove the real helper actually
    // emits these ticks — that was verified separately by running the real
    // `speech-helper transcribe` binary and inspecting its stdout for
    // `{"pct":0,"stage":"diarize","type":"progress"}` immediately after the
    // final transcribe pct:1 (see the final fix report).
    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });
    await supervisor.run(job, store);

    const finished = store.getJob("j15")!;
    expect(finished.status).toBe("done");
    expect(finished.progress).toBe(1);
    expect(finished.segments).toEqual([
      { start: 0, end: 2, text: "Hello there.", confidence: null, lowTokens: [] },
      { start: 2, end: 4, text: "General Kenobi.", confidence: null, lowTokens: [] },
    ]);
  }, 10_000);
});

describe("HelperSupervisor: exit vs. finalize race (orphaned descendant holds stdout open)", () => {
  // Regression test for a fix-round-1 finding: the run-promise must resolve
  // if and only if the job record has reached a terminal state. It must
  // NOT resolve merely because the immediate child process has exited —
  // `orphan-exit.wav` backgrounds a `sleep` before exiting (without a
  // terminal NDJSON event), so the process is gone but stdout stays open
  // via the orphaned descendant. Only the inactivity-timeout backstop may
  // finalize this job.
  it("does not resolve before the job is finalized, clears every timer once it does, and lets the queue continue", async () => {
    const store = makeStore();
    const orphanJob = store.createJob({
      id: "j13a",
      path: fixtureMediaPath("orphan-exit.wav"),
      locale: "en-US",
      diarize: true,
    });
    const nextJob = store.createJob({
      id: "j13b",
      path: fixtureMediaPath("basic2.wav"),
      locale: "en-US",
      diarize: true,
    });

    const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: FAST_TIMEOUTS });

    const runPromise = supervisor.run(orphanJob, store);
    let resolvedEarly = false;
    void runPromise.then(() => {
      resolvedEarly = true;
    });

    // The immediate child (bash) exits almost instantly, well before this;
    // give that plenty of margin while staying comfortably under the
    // inactivity-timeout backstop (FAST_TIMEOUTS: 400ms) that must
    // eventually finalize the job.
    await new Promise((r) => setTimeout(r, 150));
    expect(resolvedEarly).toBe(false);
    expect(store.getJob("j13a")?.status).toBe("running");

    await runPromise;

    // (a) resolves only once finalized.
    expect(resolvedEarly).toBe(true);
    const finished = store.getJob("j13a")!;
    expect(finished.status).toBe("error");
    expect(finished.error?.code).toBe("inactivityTimeout");

    // (b) no supervisor-owned timer remains armed.
    expect(supervisor.debugActiveTimerCount).toBe(0);

    // (c) the queue (simulated here by a direct next run() call, matching
    // how JobQueue awaits each job before starting the next) still
    // proceeds normally.
    await supervisor.run(nextJob, store);
    expect(store.getJob("j13b")?.status).toBe("done");
    expect(supervisor.debugActiveTimerCount).toBe(0);
  }, 10_000);
});
