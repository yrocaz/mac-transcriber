import path from "node:path";
import type { JobRecord, LowConfidenceToken } from "./types";
import { hasText, type Transcript, type TranscriptSegment } from "./transcript";

/**
 * review.md — the places worth listening to, ranked by the model's own
 * uncertainty.
 *
 * Why this exists: Apple's SpeechAnalyzer is deterministic, so transcribing a
 * file repeatedly and diffing the runs finds nothing — measured over five runs
 * on two files, output is byte-identical, and the one known accuracy defect
 * (five speakers auto-clustering to three) reproduces exactly. Self-consensus
 * cannot see a mistake the decoder makes confidently every time. What does work
 * is the per-word confidence the engine already reports; this module turns it
 * into a short, ordered list a person can actually work through.
 *
 * See docs/2026-08-07-repeat-run-determinism.md for the measurements.
 */

/**
 * Words at or above this confidence are not listed. 0.5 was chosen from the
 * measured distribution on a 43-minute five-speaker panel: it yields ~70 spots
 * there, which is a real review pass rather than a wall of text, and it
 * comfortably includes both errors verified by hand ("newth" at 0.185, standing
 * in for "fine-tooth", and the misheard name "Crom" at 0.276).
 *
 * The helper captures everything below 0.9, so this can be raised toward that
 * ceiling without rebuilding the Swift binary.
 */
export const REVIEW_THRESHOLD = 0.5;

/** Beyond this many spots the list stops being a review pass and becomes noise. */
export const MAX_REVIEW_ITEMS = 200;

/**
 * Alternatives longer than this are dropped from the rendered list.
 *
 * `Result.alternatives` are phrase-scoped, and a long phrase's alternative is
 * usually the entire phrase restated with one word changed — which buries the
 * difference instead of showing it. Observed on a real recording: a flagged word
 * came with a 130-character alternative identical to the sentence already
 * printed directly above it. Short alternatives are where the signal is
 * ("someone than" against "someone, then").
 */
export const MAX_ALTERNATIVE_CHARS = 80;

/** No more than this many alternatives per entry; they are already ranked. */
export const MAX_ALTERNATIVES_SHOWN = 5;

/** Words shorter than this are dropped; see REVIEW_STOPWORDS for the rationale. */
export const MIN_WORD_LENGTH = 3;

/**
 * Function words and disfluencies excluded from the review list.
 *
 * This is a heuristic, and it is the single most consequential tuning knob in
 * this module — the count of flagged spots moves with it, so it lives here in
 * source rather than being applied ad hoc. The justification is empirical: on a
 * 43-minute recording the lowest-confidence words were " their" (0.001), " the"
 * (0.031), " um," (0.058) and " uh," (0.069). A misheard filler word does not
 * affect a transcript's usefulness, let alone an article derived from it, so
 * ranking on raw confidence buries the errors that matter under noise.
 *
 * The list is deliberately short and covers only high-frequency function words
 * and disfluencies. It will occasionally suppress a word that mattered ("right"
 * as a noun, "like" as a verb); that is the accepted cost of a list this simple.
 * Widen or narrow it here — the unit tests assert behaviour, not a specific
 * count, so tuning it will not break them.
 */
export const REVIEW_STOPWORDS = new Set([
  // disfluencies
  "uh", "um", "mm", "hmm", "ah", "oh", "er", "yeah", "okay", "ok", "mhm",
  // articles, conjunctions, prepositions
  "the", "and", "but", "for", "nor", "yet", "with", "from", "into", "onto",
  "than", "that", "this", "these", "those", "there", "their", "them", "they",
  // pronouns and auxiliaries
  "you", "your", "our", "his", "her", "hers", "its", "was", "were", "been",
  "are", "has", "had", "have", "will", "would", "could", "should", "can",
  "did", "does", "not", "but",
  // very common discourse filler
  "just", "well", "know", "like", "really", "actually", "sort", "kind",
]);

export interface ReviewItem {
  /** Seconds into the recording. */
  start: number;
  /** The flagged word, as transcribed. */
  word: string;
  confidence: number;
  /** Speaker label of the sentence the word sits in, if diarization ran. */
  speaker: string | null;
  /** The full sentence, for context. */
  sentence: string;
  /** Runner-up hypotheses from the engine for this word's phrase. */
  alternatives: string[];
}

function isReviewable(token: LowConfidenceToken): boolean {
  if (token.confidence >= REVIEW_THRESHOLD) return false;
  const normalized = token.text.toLowerCase().replace(/[^a-z0-9']/g, "");
  if (normalized.length < MIN_WORD_LENGTH) return false;
  return !REVIEW_STOPWORDS.has(normalized);
}

/**
 * Pairs each assembled transcript segment with the raw low-confidence words the
 * helper reported for it, and flattens the result into a ranked review list.
 *
 * `job.segments` and `transcript.segments` are walked in lockstep through the
 * same `hasText` filter assembleTranscript uses, so index i refers to the same
 * sentence in both.
 */
export function collectReviewItems(job: JobRecord, transcript: Transcript): ReviewItem[] {
  const rawSegments = job.segments.filter(hasText);
  const items: ReviewItem[] = [];

  rawSegments.forEach((raw, index) => {
    const assembled: TranscriptSegment | undefined = transcript.segments[index];
    if (!assembled) return;

    // `?? []` guards the same undefined-on-a-hand-built-record case that
    // assembleTranscript's confidence handling does.
    for (const token of raw.lowTokens ?? []) {
      if (!isReviewable(token)) continue;
      items.push({
        start: token.start,
        word: token.text,
        confidence: token.confidence,
        speaker: assembled.speaker,
        sentence: assembled.text,
        alternatives: token.alternatives,
      });
    }
  });

  return items.sort((a, b) => a.confidence - b.confidence);
}

/**
 * Trims, drops over-long phrase restatements, and collapses alternatives that
 * differ only in capitalization or punctuation.
 *
 * The collapse matters because the engine routinely offers "All right.",
 * "All right,", "right." and "Right." as four distinct hypotheses — visually
 * noisy, and identical for review purposes. Case and punctuation are stripped
 * only for the *comparison*; the first spelling seen is what gets shown, so a
 * genuine word difference ("then" vs "than") still survives as two entries.
 */
export function presentableAlternatives(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ALTERNATIVE_CHARS) continue;
    const key = trimmed.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length === MAX_ALTERNATIVES_SHOWN) break;
  }

  return out;
}

/** `[h:]mm:ss`, matching transcript.txt's timestamps so the two can be cross-read. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Highlights the flagged word inside its sentence with `**bold**`, so the eye
 * lands on it without having to re-read the line. Falls back to the plain
 * sentence when the word can't be located (e.g. the helper trimmed punctuation
 * differently), rather than emitting a broken highlight.
 */
function highlight(sentence: string, word: string): string {
  const index = sentence.indexOf(word);
  if (index === -1) return sentence;
  return (
    sentence.slice(0, index) + `**${word}**` + sentence.slice(index + word.length)
  );
}

export function renderReview(job: JobRecord, transcript: Transcript): string {
  const items = collectReviewItems(job, transcript);
  const shown = items.slice(0, MAX_REVIEW_ITEMS);
  const out: string[] = [];

  out.push(`# Review — ${path.basename(transcript.metadata.source)}`);
  out.push("");

  if (transcript.segments.length === 0) {
    out.push("No transcript segments were produced, so there is nothing to review.");
    return out.join("\n") + "\n";
  }

  const measured = transcript.segments.some((s) => s.confidence !== null);
  if (!measured) {
    out.push(
      "This transcript carries no confidence data — it was produced by a helper",
      "build predating per-word confidence. Re-run the job to generate a review list.",
    );
    return out.join("\n") + "\n";
  }

  if (shown.length === 0) {
    out.push(
      `Nothing flagged. No content word fell below ${REVIEW_THRESHOLD} confidence.`,
      "",
      "That is a statement about the model's certainty, not a guarantee of accuracy —",
      "a confidently wrong transcription looks exactly like a correct one here.",
    );
    return out.join("\n") + "\n";
  }

  out.push(
    `${items.length} ${items.length === 1 ? "spot" : "spots"} where the transcription is least certain, worst first.`,
    `Words scoring below ${REVIEW_THRESHOLD} confidence, excluding filler and function words.`,
    "",
    "Each entry is a place worth listening to. The alternatives are the engine's own",
    "runner-up hypotheses — sometimes they contain the right answer, often they do not,",
    "so treat them as hints rather than corrections.",
    "",
  );

  if (items.length > shown.length) {
    out.push(
      `> Showing the worst ${shown.length} of ${items.length}. Lower \`REVIEW_THRESHOLD\` in`,
      "> `server/src/review.ts` to shorten the list.",
      "",
    );
  }

  out.push("---", "");

  for (const item of shown) {
    const speaker = item.speaker ? ` · ${item.speaker}` : "";
    out.push(
      `### ${formatClock(item.start)}${speaker} — \`${item.word}\` (${item.confidence.toFixed(3)})`,
    );
    out.push("");
    out.push(`> ${highlight(item.sentence, item.word)}`);
    out.push("");
    const alternatives = presentableAlternatives(item.alternatives);
    if (alternatives.length > 0) {
      out.push(`Also considered: ${alternatives.map((a) => `\`${a}\``).join(", ")}`);
      out.push("");
    }
  }

  return out.join("\n");
}
