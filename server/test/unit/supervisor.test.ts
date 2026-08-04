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
      { start: 0, end: 2, text: "Hello there." },
      { start: 2, end: 4, text: "General Kenobi." },
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
    expect(finished.segments).toEqual([{ start: 0, end: 2, text: "Solo segment." }]);
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
