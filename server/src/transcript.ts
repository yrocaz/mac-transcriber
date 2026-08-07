import path from "node:path";
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
  /**
   * Mean per-word confidence for this sentence, or null when the engine
   * reported none. Published so a downstream consumer — notably an
   * article-generation step — can weigh how much to trust a given sentence
   * without re-reading the audio. The per-word detail behind a low score lives
   * in review.md, not here, to keep transcript.json readable.
   */
  confidence: z.number().nullable(),
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

  // speakers is non-null here, which per the helper's own contract already
  // means diarization succeeded: TranscribeCommand.swift's diarization
  // block (lines ~141-161) makes a non-null `speakers` event and a
  // `diarizationFailed` warning mutually exclusive — the `speakers` event
  // fires only on the success path, the warning only in the catch block
  // that skips it. So `job.speakers !== null && hasDiarizationFailedWarning`
  // is not a reachable combination in production; this check is defensive
  // only (e.g. against a future helper change relaxing that contract, or a
  // malformed job.json), and intentionally kept rather than removed so a
  // regression in that invariant degrades to "failed" instead of silently
  // reporting "ok".
  const hasDiarizationFailedWarning = job.warnings.some((w) => w.code === "diarizationFailed");
  if (hasDiarizationFailedWarning) {
    return "failed";
  }

  return "ok";
}

// ---------------------------------------------------------------------------
// Transcript assembly (pure function; no fs, no clock)
// ---------------------------------------------------------------------------

/**
 * The empty-segment filter, exported so review rendering can walk the job's raw
 * segments in lockstep with the assembled transcript. Both must drop exactly the
 * same segments or the two fall out of alignment by an index — hence one
 * definition rather than two identical predicates.
 */
export function hasText(segment: { text: string }): boolean {
  return segment.text.trim().length > 0;
}

export function assembleTranscript(job: JobRecord): Transcript {
  const diarizationStatus = deriveDiarizationStatus(job);

  // Build segments with max-overlap speaker merge (if diarization succeeded).
  const segments: TranscriptSegment[] = job.segments.map((seg, idx) => {
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
      // `== null` rather than `=== null`: zod's default fills this in for
      // records that went through parsing, but a record constructed in-process
      // can carry `undefined`, and `roundMs(undefined)` is NaN — which
      // serializes into transcript.json as `null` only by accident and compares
      // equal to nothing.
      confidence: seg.confidence == null ? null : roundMs(seg.confidence),
    };
  });

  // Drop empty segments and reassign sequential ids after filtering.
  const nonEmptySegments = segments.filter(hasText).map((seg, idx) => ({ ...seg, id: idx }));
  const text = nonEmptySegments.map((s) => s.text).join(" ");

  // Metadata.
  const speakerCount = diarizationStatus === "ok" && job.speakers ? job.speakers.count : null;

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

/** `[h:]mm:ss` for reading, distinct from SRT's `HH:MM:SS,mmm` timing format. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Human-readable transcript: a header, then one block per speaker turn with a
 * timestamp, consecutive same-speaker segments joined into paragraphs.
 *
 * This is the format a person opens and the one a later article-generation
 * step reads most naturally — transcript.json is the machine contract and SRT
 * is for video players, but neither is pleasant to read. Grouping by turn
 * rather than by sentence is what makes an interview legible as dialogue.
 */
export function renderReadableText(transcript: Transcript): string {
  const { metadata, segments } = transcript;
  const out: string[] = [];

  out.push(path.basename(metadata.source));
  const speakers = metadata.speakerCount === null ? "" : ` · ${metadata.speakerCount} speakers`;
  out.push(`${formatClock(metadata.durationSec)}${speakers} · ${metadata.locale}`);
  out.push("");

  let currentSpeaker: string | null | undefined;
  let buffer: string[] = [];
  let blockStart = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const label = currentSpeaker ?? "Unknown speaker";
    out.push(`[${formatClock(blockStart)}] ${label}`);
    out.push(buffer.join(" "));
    out.push("");
    buffer = [];
  };

  for (const seg of segments) {
    if (seg.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = seg.speaker;
      blockStart = seg.start;
    }
    buffer.push(seg.text);
  }
  flush();

  return out.join("\n");
}
