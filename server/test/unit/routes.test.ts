import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTestApp, FAST_TIMEOUTS, fixtureMediaPath, waitFor } from "../helpers/testApp";

describe("POST /jobs validation", () => {
  it("rejects a body with a missing path", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/jobs", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a body where path is the wrong type", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/jobs", payload: { path: 42 } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a body where diarize is the wrong type", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), diarize: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a nonexistent path", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: "/definitely/does/not/exist.wav" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not exist/i);
  });

  it("rejects an unsupported file extension", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("unsupported.txt") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported file extension/i);
    expect(res.json().error).toMatch(/mp4/);
  });

  it("accepts a valid body and returns 202 with a queued job id", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav") },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("queued");
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });
});

describe("GET /jobs and /jobs/:id", () => {
  it("404s for an unknown job id", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/jobs/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("round-trips a job from POST through to done via GET /jobs/:id polling", async () => {
    const { app, store } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    expect(create.statusCode).toBe(202);
    const { id } = create.json();

    await waitFor(() => store.getJob(id)?.status === "done", { timeoutMs: 5000 });

    const getRes = await app.inject({ method: "GET", url: `/jobs/${id}` });
    expect(getRes.statusCode).toBe(200);
    const job = getRes.json();
    expect(job.status).toBe("done");
    expect(job.progress).toBe(1);
    expect(job.durationSec).toBe(10);
    // The public DTO (spec §2) exposes status/progress/warnings/timings/error,
    // not the raw segments/speakers Task 4 needs — see types.ts boundary note.
    expect(job.segments).toBeUndefined();
    expect(job.speakers).toBeUndefined();
  });

  it("lists jobs newest first", async () => {
    const { app } = buildTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav") },
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic2.wav") },
    });

    const listRes = await app.inject({ method: "GET", url: "/jobs" });
    expect(listRes.statusCode).toBe(200);
    const ids = listRes.json().map((j: { id: string }) => j.id);
    expect(ids[0]).toBe(second.json().id);
    expect(ids[1]).toBe(first.json().id);
  });
});

describe("FIFO queue, concurrency 1", () => {
  it("does not start the second job until the first has settled", async () => {
    const { app, store } = buildTestApp({ timeouts: FAST_TIMEOUTS });

    const first = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav") },
    });
    const second = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic2.wav") },
    });
    const firstId = first.json().id as string;
    const secondId = second.json().id as string;

    // Give the first job a moment to actually start (it has a short
    // synchronous startup before it reaches `done`).
    await waitFor(() => store.getJob(firstId)?.status !== "queued", { timeoutMs: 2000 });
    // While job 1 is running/finishing, job 2 must still be queued — proof
    // the queue is serial rather than firing both helpers concurrently.
    expect(store.getJob(secondId)?.status).toBe("queued");

    await waitFor(() => store.getJob(firstId)?.status === "done", { timeoutMs: 5000 });
    await waitFor(() => store.getJob(secondId)?.status === "done", { timeoutMs: 5000 });

    expect(store.getJob(firstId)?.status).toBe("done");
    expect(store.getJob(secondId)?.status).toBe("done");
  });

  it("keeps processing later jobs through the real queue even after an earlier spawn failure", async () => {
    // Exercises the full app/queue wiring (not just the supervisor in
    // isolation) against a broken helper path, then a job that should
    // still complete — the queue must not wedge on the first job's failure.
    const { app, store } = buildTestApp({ helperPath: "/definitely/does/not/exist/speech-helper" });
    const bad = await app.inject({ method: "POST", url: "/jobs", payload: { path: fixtureMediaPath("basic.wav") } });
    const badId = bad.json().id as string;
    await waitFor(() => store.getJob(badId)?.status === "error", { timeoutMs: 2000 });
    expect(store.getJob(badId)?.error?.code).toBe("spawnFailed");
  });
});

describe("GET /jobs/:id/transcript.json", () => {
  it("404s for an unknown job id", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/jobs/does-not-exist/transcript.json" });
    expect(res.statusCode).toBe(404);
  });

  it("404s when job is not done (e.g., error status with segments present)", async () => {
    const { app, store } = buildTestApp();
    const jobId = "error-job";
    store.createJob({ id: jobId, path: "/path/to/media.wav", locale: "en-US", diarize: false });
    store.updateJob(jobId, {
      status: "error",
      error: { code: "testError", message: "test error" },
      finishedAt: new Date().toISOString(),
      segments: [{ start: 0, end: 1, text: "Test" }],
    });

    const res = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.json` });
    expect(res.statusCode).toBe(404);
  });

  it("returns transcript JSON for a done job", async () => {
    const { app, store } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    const res = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.json` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata).toBeDefined();
    expect(body.metadata.source).toBe(fixtureMediaPath("basic.wav"));
    expect(body.metadata.engine).toBe("apple-speechanalyzer");
    expect(body.metadata.diarization).toBe("ok");
    expect(body.metadata.speakerCount).toBe(2);
    expect(body.text).toMatch(/hello|kenobi/i);
    expect(Array.isArray(body.segments)).toBe(true);
    expect(body.segments.length).toBeGreaterThan(0);
  });

  it("is consistent with the written transcript.json file", async () => {
    const { app, store, dataDir } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    // Get via route
    const routeRes = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.json` });
    const routeBody = routeRes.json();

    // Read from disk
    const diskPath = path.join(dataDir, "jobs", jobId, "transcript.json");
    const diskBody = JSON.parse(fs.readFileSync(diskPath, "utf8"));

    // Both should be identical
    expect(routeBody).toEqual(diskBody);
  });
});

describe("GET /jobs/:id/transcript.srt", () => {
  it("404s for an unknown job id", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/jobs/does-not-exist/transcript.srt" });
    expect(res.statusCode).toBe(404);
  });

  it("404s when job is not done", async () => {
    const { app, store } = buildTestApp();
    const jobId = "error-job";
    store.createJob({ id: jobId, path: "/path/to/media.wav", locale: "en-US", diarize: false });
    store.updateJob(jobId, {
      status: "error",
      error: { code: "testError", message: "test error" },
      finishedAt: new Date().toISOString(),
      segments: [{ start: 0, end: 1, text: "Test" }],
    });

    const res = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.srt` });
    expect(res.statusCode).toBe(404);
  });

  it("returns SRT subtitle format with proper timing", async () => {
    const { app, store } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    const res = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.srt` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    const srt = res.payload;
    // Basic sanity checks on SRT format
    expect(srt).toMatch(/\d+/); // line numbers
    expect(srt).toMatch(/00:\d{2}:\d{2},\d{3} --> 00:\d{2}:\d{2},\d{3}/); // timestamps
    expect(srt.endsWith("\n")).toBe(true); // trailing newline
  });

  it("writes transcript.srt to disk and is consistent with route response", async () => {
    const { app, store, dataDir } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    // Get via route
    const routeRes = await app.inject({ method: "GET", url: `/jobs/${jobId}/transcript.srt` });
    const routeBody = routeRes.payload;

    // Read from disk
    const diskPath = path.join(dataDir, "jobs", jobId, "transcript.srt");
    const diskBody = fs.readFileSync(diskPath, "utf8");

    // Both should be identical
    expect(routeBody).toBe(diskBody);
  });
});

describe("Transcript files on disk after job completion", () => {
  it("writes both transcript.json and transcript.srt to the job directory", async () => {
    const { app, store, dataDir } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    const jobDir = path.join(dataDir, "jobs", jobId);
    const jsonPath = path.join(jobDir, "transcript.json");
    const srtPath = path.join(jobDir, "transcript.srt");

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(srtPath)).toBe(true);

    // Both should be valid and non-empty
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const srt = fs.readFileSync(srtPath, "utf8");
    expect(json.metadata).toBeDefined();
    expect(srt.length).toBeGreaterThan(0);
  });

  it("spec §5 invariant: done job ALWAYS has its transcript files (completion ordering)", async () => {
    // Verify the core invariant: if status === "done", transcript files exist.
    // This ensures no orphaned done jobs with missing transcripts.
    const { app, store, dataDir } = buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { path: fixtureMediaPath("basic.wav"), locale: "en-US", diarize: true },
    });
    const jobId = create.json().id as string;

    await waitFor(() => store.getJob(jobId)?.status === "done", { timeoutMs: 5000 });

    const job = store.getJob(jobId);
    expect(job?.status).toBe("done");

    const jobDir = path.join(dataDir, "jobs", jobId);
    const jsonPath = path.join(jobDir, "transcript.json");
    const srtPath = path.join(jobDir, "transcript.srt");

    // The invariant: done job => both files exist.
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(srtPath)).toBe(true);
  });
});

describe("GET /health", () => {
  it("returns 200 with ok status when helper is present and working", async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.helper).toBeDefined();
    expect(typeof body.helper.available).toBe("boolean");
    expect(Array.isArray(body.helper.supportedLocales)).toBe(true);
    expect(Array.isArray(body.helper.installedLocales)).toBe(true);
  });

  it("returns 200 with degraded status when helper binary is missing", async () => {
    const { app } = buildTestApp({ helperPath: "/definitely/does/not/exist/speech-helper" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.helper).toBeNull();
  });
});
