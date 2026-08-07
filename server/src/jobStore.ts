import fs from "node:fs";
import path from "node:path";
import type { JobRecord, SpeakerHint } from "./types";
import { JobRecord as JobRecordSchema } from "./types";
import { assembleTranscript, renderReadableText, renderSrt } from "./transcript";
import { renderReview } from "./review";

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
    speakerHint?: SpeakerHint | null;
    outputDir?: string | null;
  }): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: input.id,
      path: input.path,
      locale: input.locale,
      diarize: input.diarize,
      speakerHint: input.speakerHint ?? null,
      outputDir: input.outputDir ?? null,
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
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

  /** Directory holding a job's job.json and transcript files. */
  jobDir(id: string): string {
    return path.join(this.jobsDir, id);
  }

  private persist(job: JobRecord): void {
    const dir = path.join(this.jobsDir, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, "job.json");
    const tmpPath = path.join(dir, `.job.json.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
    fs.renameSync(tmpPath, finalPath);
  }

  /**
   * Assembles transcript.json and transcript.srt and writes them to the job
   * directory alongside job.json. Should only be called for done jobs
   * with segments present. Errors are logged but do not crash the queue.
   */
  writeTranscripts(job: JobRecord): void {
    try {
      const transcript = assembleTranscript(job);
      const dir = path.join(this.jobsDir, job.id);
      fs.mkdirSync(dir, { recursive: true });

      // Write transcript.json.
      const jsonPath = path.join(dir, "transcript.json");
      const jsonTmpPath = path.join(dir, `.transcript.json.${process.pid}.tmp`);
      fs.writeFileSync(jsonTmpPath, JSON.stringify(transcript, null, 2));
      fs.renameSync(jsonTmpPath, jsonPath);

      // Write transcript.srt.
      const srt = renderSrt(transcript.segments);
      const srtPath = path.join(dir, "transcript.srt");
      const srtTmpPath = path.join(dir, `.transcript.srt.${process.pid}.tmp`);
      fs.writeFileSync(srtTmpPath, srt + "\n");
      fs.renameSync(srtTmpPath, srtPath);

      // Readable, speaker-labelled prose — the format a human actually opens,
      // and the one a later article-generation step reads most naturally.
      const txt = renderReadableText(transcript);
      const txtPath = path.join(dir, "transcript.txt");
      const txtTmpPath = path.join(dir, `.transcript.txt.${process.pid}.tmp`);
      fs.writeFileSync(txtTmpPath, txt);
      fs.renameSync(txtTmpPath, txtPath);

      // The uncertainty-ranked review list. Written unconditionally, including
      // the "nothing flagged" case — an absent file is ambiguous between "clean"
      // and "not generated", and the difference matters to someone deciding
      // whether to trust the transcript.
      const review = renderReview(job, transcript);
      const reviewPath = path.join(dir, "review.md");
      const reviewTmpPath = path.join(dir, `.review.md.${process.pid}.tmp`);
      fs.writeFileSync(reviewTmpPath, review);
      fs.renameSync(reviewTmpPath, reviewPath);

      // Mirror into the human-facing folder beside the media file. Failures
      // here are reported but must not lose the job-directory copy above,
      // which has already landed.
      if (job.outputDir) {
        fs.mkdirSync(job.outputDir, { recursive: true });
        for (const [name, body] of [
          ["transcript.json", JSON.stringify(transcript, null, 2)],
          ["transcript.srt", srt + "\n"],
          ["transcript.txt", txt],
          ["review.md", review],
        ] as const) {
          const dest = path.join(job.outputDir, name);
          const tmp = path.join(job.outputDir, `.${name}.${process.pid}.tmp`);
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, dest);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to write transcripts for job ${job.id}:`, err);

      // Minor finding: previously console.error only, so the API and disk
      // could silently disagree (GET /jobs/:id keeps serving the in-memory
      // record as if nothing were wrong, e.g. status:"done" with no
      // transcript.json ever having landed). Surface the failure in the
      // job's own warnings[] — the documented, persisted, observable-after-
      // the-fact channel (spec §6) — so it shows up in GET /jobs/:id. A
      // separate try/catch: if the job record itself has since vanished
      // from the cache, or this update somehow fails, that must not mask
      // the original write failure by throwing out of this method (which
      // callers rely on never throwing).
      try {
        const message = err instanceof Error ? err.message : String(err);
        const current = this.cache.get(job.id);
        if (current) {
          this.updateJob(job.id, {
            warnings: [...current.warnings, { code: "transcriptWriteFailed", message }],
          });
        }
      } catch (warnErr) {
        // eslint-disable-next-line no-console
        console.error(`Failed to record transcriptWriteFailed warning for job ${job.id}:`, warnErr);
      }
    }
  }
}
