import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { DEFAULT_LOCALE } from "../config";
import { newJobId } from "../idgen";
import type { JobQueue } from "../queue";
import type { JobStore } from "../jobStore";
import { CreateJobBody, SUPPORTED_EXTENSIONS, toJobResponse } from "../types";

const SUPPORTED_EXTENSIONS_LIST = SUPPORTED_EXTENSIONS.join(", ");

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

    const ext = path.extname(body.path).slice(1).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      return reply.code(400).send({
        error: `Unsupported file extension "${ext || "(none)"}". Supported: ${SUPPORTED_EXTENSIONS_LIST}`,
      });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(body.path);
    } catch {
      return reply.code(400).send({ error: `File does not exist: ${body.path}` });
    }
    if (!stat.isFile()) {
      return reply.code(400).send({ error: `Not a file: ${body.path}` });
    }
    try {
      fs.accessSync(body.path, fs.constants.R_OK);
    } catch {
      return reply.code(400).send({ error: `File is not readable: ${body.path}` });
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
}
