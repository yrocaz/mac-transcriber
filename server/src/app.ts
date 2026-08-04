import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config";
import { JobStore } from "./jobStore";
import { JobQueue } from "./queue";
import { HelperSupervisor } from "./supervisor";
import { registerJobRoutes } from "./routes/jobs";
import { registerHealthRoute } from "./routes/health";

export interface BuiltApp {
  app: FastifyInstance;
  store: JobStore;
  queue: JobQueue;
  /**
   * The single supervisor instance driving every job (concurrency 1).
   * Exposed so `index.ts` can call `killActive()` on SIGINT/SIGTERM —
   * without it, Ctrl-C mid-job orphans the helper holding a SpeechAnalyzer
   * session, and a re-POST after restart would run two analyses
   * concurrently (minor finding 7).
   */
  supervisor: HelperSupervisor;
  /** Ids of jobs marked "interrupted" by restart recovery during boot. */
  recoveredJobIds: string[];
}

/**
 * Wires up the job store (with restart recovery), the concurrency-1 queue,
 * the helper supervisor, and the HTTP routes. Kept separate from
 * `index.ts`'s `listen()` call so tests can exercise routes via
 * `app.inject()` without binding a port.
 */
export function buildApp(config: AppConfig): BuiltApp {
  const store = new JobStore(config.dataDir);
  const recoveredJobIds = store.init();

  const supervisor = new HelperSupervisor({
    helperPath: config.helperPath,
    timeouts: config.timeouts,
  });

  const queue = new JobQueue(async (id) => {
    const job = store.getJob(id);
    if (!job) return;
    await supervisor.run(job, store);
  });

  const app = Fastify({ logger: false });
  registerJobRoutes(app, { store, queue });
  registerHealthRoute(app, { helperPath: config.helperPath });

  return { app, store, queue, supervisor, recoveredJobIds };
}
