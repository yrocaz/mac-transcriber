import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobStore";
import type { JobRecord } from "../../src/types";
import { makeTempDataDir } from "../helpers/testApp";

function writeRawJob(dataDir: string, job: JobRecord): void {
  const dir = path.join(dataDir, "jobs", job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
}

function baseJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "job1",
    path: "/tmp/whatever.wav",
    locale: "en-US",
    diarize: true,
    status: "queued",
    progress: 0,
    warnings: [],
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationSec: null,
    stderrTail: null,
    segments: [],
    speakers: null,
    ...overrides,
  };
}

describe("JobStore restart recovery", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
  });

  it("marks a stale queued job as interrupted on init", () => {
    writeRawJob(dataDir, baseJob({ id: "queued-job", status: "queued" }));

    const store = new JobStore(dataDir);
    const recovered = store.init();

    expect(recovered).toContain("queued-job");
    const job = store.getJob("queued-job");
    expect(job?.status).toBe("error");
    expect(job?.error).toEqual({
      code: "interrupted",
      message: expect.stringContaining("restart"),
    });
    expect(job?.finishedAt).not.toBeNull();
  });

  it("marks a stale running job as interrupted on init", () => {
    writeRawJob(dataDir, baseJob({ id: "running-job", status: "running", startedAt: new Date().toISOString() }));

    const store = new JobStore(dataDir);
    store.init();

    const job = store.getJob("running-job");
    expect(job?.status).toBe("error");
    expect(job?.error?.code).toBe("interrupted");
  });

  it("persists the interrupted status back to disk", () => {
    writeRawJob(dataDir, baseJob({ id: "persisted-job", status: "running" }));

    const store = new JobStore(dataDir);
    store.init();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dataDir, "jobs", "persisted-job", "job.json"), "utf8"),
    );
    expect(onDisk.status).toBe("error");
    expect(onDisk.error.code).toBe("interrupted");
  });

  it("leaves done and error jobs untouched", () => {
    writeRawJob(dataDir, baseJob({ id: "done-job", status: "done", progress: 1 }));
    writeRawJob(
      dataDir,
      baseJob({ id: "error-job", status: "error", error: { code: "audioReadFailed", message: "boom" } }),
    );

    const store = new JobStore(dataDir);
    const recovered = store.init();

    expect(recovered).toEqual([]);
    expect(store.getJob("done-job")?.status).toBe("done");
    expect(store.getJob("error-job")?.error?.code).toBe("audioReadFailed");
  });

  it("createJob + updateJob persists to disk and updates the cache", () => {
    const store = new JobStore(dataDir);
    store.init();

    const job = store.createJob({ id: "new-job", path: "/tmp/a.wav", locale: "en-US", diarize: true });
    expect(job.status).toBe("queued");

    const updated = store.updateJob("new-job", { status: "running", progress: 0.5 });
    expect(updated.status).toBe("running");
    expect(updated.progress).toBe(0.5);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "jobs", "new-job", "job.json"), "utf8"));
    expect(onDisk.status).toBe("running");
    expect(onDisk.progress).toBe(0.5);
  });

  it("listJobs returns newest first", () => {
    const store = new JobStore(dataDir);
    store.init();
    store.createJob({ id: "a", path: "/tmp/a.wav", locale: "en-US", diarize: true });
    // Force distinguishable createdAt ordering regardless of clock resolution.
    store.updateJob("a", { createdAt: "2020-01-01T00:00:00.000Z" });
    store.createJob({ id: "b", path: "/tmp/b.wav", locale: "en-US", diarize: true });
    store.updateJob("b", { createdAt: "2021-01-01T00:00:00.000Z" });

    const listed = store.listJobs();
    expect(listed.map((j) => j.id)).toEqual(["b", "a"]);
  });
});

describe("writeTranscripts: the files that actually land on disk", () => {
  // The unit tests around review.ts exercise the renderer; these assert the
  // wiring. A new output is easiest to lose in the outputDir mirror loop, which
  // is a separate list of filenames from the job-directory writes — nothing but
  // a test keeps the two in step.
  const OUTPUTS = ["transcript.json", "transcript.srt", "transcript.txt", "review.md"];

  function doneJob(overrides: Partial<JobRecord> = {}): JobRecord {
    return baseJob({
      id: "written",
      status: "done",
      durationSec: 4,
      diarize: false,
      segments: [
        {
          start: 0,
          end: 2,
          text: "Find newth and comb.",
          confidence: 0.4,
          lowTokens: [
            { text: "newth", start: 0.5, confidence: 0.185, alternatives: [" fine, newth"] },
          ],
        },
      ],
      ...overrides,
    });
  }

  it("writes every output into the job directory", () => {
    const dataDir = makeTempDataDir();
    const store = new JobStore(dataDir);
    store.init();
    const job = doneJob();
    store.createJob({ id: job.id, path: job.path, locale: job.locale, diarize: job.diarize });
    store.writeTranscripts(job);

    for (const name of OUTPUTS) {
      expect(fs.existsSync(path.join(store.jobDir(job.id), name)), name).toBe(true);
    }
  });

  it("mirrors every output into the user-facing outputDir", () => {
    const dataDir = makeTempDataDir();
    const outputDir = path.join(dataDir, "user-facing");
    const store = new JobStore(dataDir);
    store.init();
    const job = doneJob({ outputDir });
    store.createJob({
      id: job.id,
      path: job.path,
      locale: job.locale,
      diarize: job.diarize,
      outputDir,
    });
    store.writeTranscripts(job);

    for (const name of OUTPUTS) {
      expect(fs.existsSync(path.join(outputDir, name)), name).toBe(true);
    }
  });

  it("review.md carries the flagged word, its context and its alternatives", () => {
    const dataDir = makeTempDataDir();
    const store = new JobStore(dataDir);
    store.init();
    const job = doneJob();
    store.createJob({ id: job.id, path: job.path, locale: job.locale, diarize: job.diarize });
    store.writeTranscripts(job);

    const review = fs.readFileSync(path.join(store.jobDir(job.id), "review.md"), "utf8");
    expect(review).toContain("`newth`");
    expect(review).toContain("Find **newth** and comb.");
    expect(review).toContain("`fine, newth`");
  });

  it("still writes review.md when nothing is flagged, so absence is unambiguous", () => {
    const dataDir = makeTempDataDir();
    const store = new JobStore(dataDir);
    store.init();
    const job = doneJob({
      segments: [
        { start: 0, end: 2, text: "Nothing wrong here.", confidence: 0.99, lowTokens: [] },
      ],
    });
    store.createJob({ id: job.id, path: job.path, locale: job.locale, diarize: job.diarize });
    store.writeTranscripts(job);

    const review = fs.readFileSync(path.join(store.jobDir(job.id), "review.md"), "utf8");
    expect(review).toContain("Nothing flagged");
  });
});
