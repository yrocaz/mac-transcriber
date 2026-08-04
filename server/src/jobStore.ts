import fs from "node:fs";
import path from "node:path";
import type { JobRecord } from "./types";
import { JobRecord as JobRecordSchema } from "./types";

const INTERRUPTED_MESSAGE = "Server restarted while the job was in progress.";

export class JobStore {
  private readonly jobsDir: string;
  private readonly cache = new Map<string, JobRecord>();

  constructor(dataDir: string) {
    this.jobsDir = path.join(dataDir, "jobs");
  }

  /**
   * Ensures the jobs directory exists, loads every persisted job into the
   * in-memory cache, and marks any job left in `queued`/`running` state
   * (i.e. the server crashed or was restarted mid-job) as errored with
   * code "interrupted" (spec §5). Returns the ids that were recovered.
   */
  init(): string[] {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    const recovered: string[] = [];

    const entries = fs.readdirSync(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobFile = path.join(this.jobsDir, entry.name, "job.json");
      if (!fs.existsSync(jobFile)) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      } catch {
        continue; // corrupt job.json; skip rather than crash the server
      }
      const parsed = JobRecordSchema.safeParse(raw);
      if (!parsed.success) continue;
      let job = parsed.data;

      if (job.status === "queued" || job.status === "running") {
        job = {
          ...job,
          status: "error",
          error: { code: "interrupted", message: INTERRUPTED_MESSAGE },
          finishedAt: new Date().toISOString(),
        };
        this.persist(job);
        recovered.push(job.id);
      }

      this.cache.set(job.id, job);
    }

    return recovered;
  }

  createJob(input: {
    id: string;
    path: string;
    locale: string;
    diarize: boolean;
  }): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: input.id,
      path: input.path,
      locale: input.locale,
      diarize: input.diarize,
      status: "queued",
      progress: 0,
      warnings: [],
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      durationSec: null,
      stderrTail: null,
      segments: [],
      speakers: null,
    };
    this.persist(job);
    this.cache.set(job.id, job);
    return job;
  }

  getJob(id: string): JobRecord | undefined {
    return this.cache.get(id);
  }

  listJobs(): JobRecord[] {
    return [...this.cache.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /** Read-modify-write against the in-memory record; persists synchronously. */
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
    const existing = this.cache.get(id);
    if (!existing) {
      throw new Error(`updateJob: unknown job id ${id}`);
    }
    const updated: JobRecord = { ...existing, ...patch };
    this.persist(updated);
    this.cache.set(id, updated);
    return updated;
  }

  private persist(job: JobRecord): void {
    const dir = path.join(this.jobsDir, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, "job.json");
    const tmpPath = path.join(dir, `.job.json.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
    fs.renameSync(tmpPath, finalPath);
  }
}
