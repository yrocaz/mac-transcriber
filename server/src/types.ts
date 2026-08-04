import { z } from "zod";

// ---------------------------------------------------------------------------
// Helper NDJSON event contract (spec §4). One JSON object per stdout line.
// `done` or `error` is guaranteed to be the last event for a helper run.
// ---------------------------------------------------------------------------

export const ReadyEvent = z.object({
  type: z.literal("ready"),
  durationSec: z.number(),
});

export const ModelDownloadEvent = z.object({
  type: z.literal("model_download"),
  progress: z.number(),
});

export const ProgressEvent = z.object({
  type: z.literal("progress"),
  stage: z.enum(["transcribe", "diarize"]),
  pct: z.number(),
});

export const SegmentEvent = z.object({
  type: z.literal("segment"),
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const SpeakerTurn = z.object({
  start: z.number(),
  end: z.number(),
  speaker: z.string(),
});

export const SpeakersEvent = z.object({
  type: z.literal("speakers"),
  segments: z.array(SpeakerTurn),
  count: z.number(),
});

export const WarningEvent = z.object({
  type: z.literal("warning"),
  code: z.string(),
  message: z.string(),
});

export const DoneEvent = z.object({
  type: z.literal("done"),
  durationSec: z.number(),
});

export const ErrorEvent = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const HelperEvent = z.discriminatedUnion("type", [
  ReadyEvent,
  ModelDownloadEvent,
  ProgressEvent,
  SegmentEvent,
  SpeakersEvent,
  WarningEvent,
  DoneEvent,
  ErrorEvent,
]);

export type HelperEvent = z.infer<typeof HelperEvent>;
export type SpeakerTurn = z.infer<typeof SpeakerTurn>;

// ---------------------------------------------------------------------------
// Job record — the internal on-disk representation (data/jobs/<id>/job.json).
//
// INTERNAL BOUNDARY FOR TASK 4:
// This is the full record Task 4's transcript assembly step should read
// (via jobStore.getJob(id), not the HTTP DTO). It carries the raw material
// transcript.json assembly needs:
//   - `segments`: raw sentence segments in the order the helper emitted them
//     (spec §3's `text`/`segments` come from these; sentence ids are simply
//     the array index once assembled).
//   - `speakers`: the single raw `speakers` event payload (turns + count),
//     or null if diarization was disabled, never completed, or the job
//     hasn't reached that stage yet. Task 4 does the max-overlap merge of
//     these turns onto `segments` server-side (per the Task 2 controller
//     ruling — the helper only emits raw turns). Per the Task 2 handoff
//     note, `speakers{count:0}` is a real, non-error outcome (e.g. a file
//     with no detectable speaker turns) and is stored as-is — a non-null
//     `speakers` object with an empty `segments` array and `count: 0`.
//     Task 4 should treat that the same as "ok, zero speakers found": every
//     transcript segment merges to `speaker: null` (no turns to overlap),
//     and `metadata.speakerCount` is 0, NOT the same as `diarization:
//     "failed"` (that state is warning-driven, not count-driven).
//   - `diarize` + `warnings`: enough to derive metadata.diarization
//     ("disabled" if !diarize; "failed" if a `diarizationFailed` warning is
//     present or diarize was requested but no `speakers` event ever arrived;
//     "ok" otherwise once `speakers` is non-null — including the count:0 case
//     above).
//   - `durationSec`, `locale`, `path`, `createdAt`: feed metadata directly.
// Task 4 should NOT re-parse job.json itself; extend jobStore's read API
// instead so the on-disk shape stays owned by one module.
// ---------------------------------------------------------------------------

export const JobStatus = z.enum(["queued", "running", "done", "error"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobError = z.object({
  code: z.string(),
  message: z.string(),
});
export type JobError = z.infer<typeof JobError>;

export const JobWarning = z.object({
  code: z.string(),
  message: z.string(),
});
export type JobWarning = z.infer<typeof JobWarning>;

export const JobSegment = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});
export type JobSegment = z.infer<typeof JobSegment>;

export const JobSpeakers = z.object({
  segments: z.array(SpeakerTurn),
  count: z.number(),
});
export type JobSpeakers = z.infer<typeof JobSpeakers>;

export const JobRecord = z.object({
  id: z.string(),
  path: z.string(),
  locale: z.string(),
  diarize: z.boolean(),

  status: JobStatus,
  progress: z.number(),
  warnings: z.array(JobWarning),
  error: JobError.nullable(),

  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationSec: z.number().nullable(),

  stderrTail: z.string().nullable(),

  // Raw material for Task 4's transcript assembly. See boundary note above.
  segments: z.array(JobSegment),
  speakers: JobSpeakers.nullable(),
});
export type JobRecord = z.infer<typeof JobRecord>;

// ---------------------------------------------------------------------------
// HTTP DTOs (spec §2)
// ---------------------------------------------------------------------------

export const SUPPORTED_EXTENSIONS = [
  "mp4",
  "mov",
  "m4v",
  "mp3",
  "m4a",
  "wav",
  "aiff",
  "aif",
  "caf",
] as const;

export const CreateJobBody = z.object({
  path: z.string().min(1, "path is required"),
  locale: z.string().min(1).optional(),
  diarize: z.boolean().optional(),
});
export type CreateJobBody = z.infer<typeof CreateJobBody>;

export interface JobResponse {
  id: string;
  path: string;
  locale: string;
  diarize: boolean;
  status: JobStatus;
  progress: number;
  warnings: JobWarning[];
  error: JobError | null;
  timings: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  durationSec: number | null;
}

export function toJobResponse(job: JobRecord): JobResponse {
  return {
    id: job.id,
    path: job.path,
    locale: job.locale,
    diarize: job.diarize,
    status: job.status,
    progress: job.progress,
    warnings: job.warnings,
    error: job.error,
    timings: {
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
    durationSec: job.durationSec,
  };
}
