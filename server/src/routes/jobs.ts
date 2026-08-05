import type { FastifyInstance } from "fastify";
import { DEFAULT_LOCALE } from "../config";
import { newJobId } from "../idgen";
import type { JobQueue } from "../queue";
import type { JobStore } from "../jobStore";
import { CreateJobBody, toJobResponse } from "../types";
import { assembleTranscript, renderSrt } from "../transcript";
import { validateMediaPath } from "../validateInput";

export interface JobRoutesDeps {
  store: JobStore;
  queue: JobQueue;
}

export function registerJobRoutes(app: FastifyInstance, deps: JobRoutesDeps): void {
  const { store, queue } = deps;

  app.post("/jobs", async (request, reply) => {
    const parsed = CreateJobBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    const invalid = validateMediaPath(body.path);
    if (invalid) {
      return reply.code(400).send({ error: invalid });
    }

    const job = store.createJob({
      id: newJobId(),
      path: body.path,
      locale: body.locale ?? DEFAULT_LOCALE,
      diarize: body.diarize ?? true,
    });
    queue.enqueue(job.id);

    return reply.code(202).send({ id: job.id, status: job.status });
  });

  app.get("/jobs", async (_request, reply) => {
    return reply.send(store.listJobs().map(toJobResponse));
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const job = store.getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Job not found: ${request.params.id}` });
    }
    return reply.send(toJobResponse(job));
  });

  app.get<{ Params: { id: string } }>("/jobs/:id/transcript.json", async (request, reply) => {
    const job = store.getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Job not found: ${request.params.id}` });
    }
    if (job.status !== "done") {
      return reply.code(404).send({ error: `Job is not done: ${request.params.id}` });
    }

    const transcript = assembleTranscript(job);
    return reply.send(transcript);
  });

  app.get<{ Params: { id: string } }>("/jobs/:id/transcript.srt", async (request, reply) => {
    const job = store.getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: `Job not found: ${request.params.id}` });
    }
    if (job.status !== "done") {
      return reply.code(404).send({ error: `Job is not done: ${request.params.id}` });
    }

    const transcript = assembleTranscript(job);
    const srt = renderSrt(transcript.segments);
    return reply.type("text/plain; charset=utf-8").send(srt + "\n");
  });
}
