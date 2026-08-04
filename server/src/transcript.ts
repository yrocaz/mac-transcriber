import { z } from "zod";
import type { JobRecord, SpeakerTurn } from "./types";

// ---------------------------------------------------------------------------
// Transcript schema (spec §3)
// ---------------------------------------------------------------------------

export const TranscriptSegment = z.object({
  id: z.number(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  speaker: z.string().nullable(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const TranscriptMetadata = z.object({
  source: z.string(),
  durationSec: z.number(),
  locale: z.string(),
  engine: z.literal("apple-speechanalyzer"),
  diarization: z.enum(["ok", "failed", "disabled"]),
  speakerCount: z.number().nullable(),
  createdAt: z.string(),
});
export type TranscriptMetadata = z.infer<typeof TranscriptMetadata>;

export const Transcript = z.object({
  metadata: TranscriptMetadata,
  text: z.string(),
  segments: z.array(TranscriptSegment),
});
export type Transcript = z.infer<typeof Transcript>;

// ---------------------------------------------------------------------------
// Rounding utilities (avoid float artifacts; spec §3)
// ---------------------------------------------------------------------------

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Speaker merge: each segment gets the speaker with maximum time overlap
// against raw diarization turns (spec §8, Task 3 boundary note)
// ---------------------------------------------------------------------------

function findMaxOverlapSpeaker(
  segmentStart: number,
  segmentEnd: number,
  turns: SpeakerTurn[],
): string | null {
  if (turns.length === 0) return null;

  let maxOverlap = 0;
  let maxSpeaker: string | null = null;

  for (const turn of turns) {
    const overlapStart = Math.max(segmentStart, turn.start);
    const overlapEnd = Math.min(segmentEnd, turn.end);
    const overlap = overlapEnd - overlapStart;

    // Strictly > 0: touching boundaries (segEnd === turnStart) don't count.
    if (overlap > 0 && overlap > maxOverlap) {
      maxOverlap = overlap;
      maxSpeaker = turn.speaker;
    }
  }

  return maxSpeaker;
}

// ---------------------------------------------------------------------------
// Diarization status derivation (spec §3, types.ts boundary note)
// ---------------------------------------------------------------------------

function deriveDiarizationStatus(job: JobRecord): "ok" | "failed" | "disabled" {
  if (!job.diarize) {
    return "disabled";
  }

  // If diarize was requested but speakers never arrived, it's failed.
  if (job.speakers === null) {
    return "failed";
  }

  // speakers is non-null; even count:0 is "ok".
  // Check for explicit diarizationFailed warning as a secondary signal,
  // but the presence of the speakers event (even with 0 count) means we
  // got a result from the diarizer, so "failed" only if the warning is there.
  const hasDiarizationFailedWarning = job.warnings.some((w) => w.code === "diarizationFailed");
  if (hasDiarizationFailedWarning) {
    return "failed";
  }

  return "ok";
}

// ---------------------------------------------------------------------------
// Transcript assembly (pure function; no fs, no clock)
// ---------------------------------------------------------------------------

export function assembleTranscript(job: JobRecord): Transcript {
  const diarizationStatus = deriveDiarizationStatus(job);

  // Build segments with max-overlap speaker merge (if diarization succeeded).
  let segments: TranscriptSegment[] = job.segments.map((seg, idx) => {
    let speaker: string | null = null;

    if (diarizationStatus === "ok" && job.speakers) {
      speaker = findMaxOverlapSpeaker(seg.start, seg.end, job.speakers.segments);
    }

    return {
      id: idx, // temporary, will be reassigned after filtering
      start: roundMs(seg.start),
      end: roundMs(seg.end),
      text: seg.text.trim(),
      speaker,
    };
  });

  // Drop empty segments and reassign sequential ids after filtering.
  const nonEmptySegments = segments
    .filter((s) => s.text.length > 0)
    .map((seg, idx) => ({ ...seg, id: idx }));
  const text = nonEmptySegments.map((s) => s.text).join(" ");

  // Metadata.
  const speakerCount =
    diarizationStatus === "ok" && job.speakers
      ? job.speakers.count
      : null;

  const metadata: TranscriptMetadata = {
    source: job.path,
    durationSec: roundMs(job.durationSec ?? 0),
    locale: job.locale,
    engine: "apple-speechanalyzer",
    diarization: diarizationStatus,
    speakerCount,
    createdAt: job.createdAt,
  };

  return {
    metadata,
    text,
    segments: nonEmptySegments,
  };
}

// ---------------------------------------------------------------------------
// SRT rendering (spec §2 route output, spec §3 segment blocks)
// ---------------------------------------------------------------------------

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSecs = Math.floor(totalMs / 1000);
  const secs = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mins = totalMins % 60;
  const hours = Math.floor(totalMins / 60);

  const hh = String(hours).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

export function renderSrt(segments: TranscriptSegment[]): string {
  const lines: string[] = [];

  segments.forEach((seg, index) => {
    lines.push(String(index + 1)); // 1-based index
    lines.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`);
    lines.push(seg.text);
    lines.push(""); // blank line between blocks
  });

  return lines.join("\n");
}
