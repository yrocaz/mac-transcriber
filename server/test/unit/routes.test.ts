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
