import { describe, it, expect } from "vitest";
import type { JobRecord, JobSegment, LowConfidenceToken } from "../../src/types";
import { assembleTranscript } from "../../src/transcript";
import {
  collectReviewItems,
  renderReview,
  REVIEW_THRESHOLD,
  MAX_REVIEW_ITEMS,
  presentableAlternatives,
  MAX_ALTERNATIVE_CHARS,
  MAX_ALTERNATIVES_SHOWN,
} from "../../src/review";

function token(overrides: Partial<LowConfidenceToken> = {}): LowConfidenceToken {
  return {
    text: "newth",
    start: 1.0,
    confidence: 0.185,
    alternatives: [" fine, newth", " fine, nuth"],
    ...overrides,
  };
}

function segment(overrides: Partial<JobSegment> = {}): JobSegment {
  return {
    start: 0,
    end: 2,
    text: "Find newth and comb.",
    confidence: 0.6,
    lowTokens: [],
    ...overrides,
  };
}

function makeJob(segments: JobSegment[], overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    path: "/recordings/Panel.wav",
    locale: "en-US",
    diarize: false,
    speakerHint: null,
    outputDir: null,
    status: "done",
    progress: 1,
    warnings: [],
    error: null,
    createdAt: "2026-08-07T10:00:00Z",
    startedAt: "2026-08-07T10:00:01Z",
    finishedAt: "2026-08-07T10:00:45Z",
    durationSec: 60,
    stderrTail: null,
    segments,
    speakers: null,
    ...overrides,
  };
}

function reviewOf(job: JobRecord): string {
  return renderReview(job, assembleTranscript(job));
}

function itemsOf(job: JobRecord) {
  return collectReviewItems(job, assembleTranscript(job));
}

describe("collectReviewItems: what gets flagged", () => {
  it("flags a low-confidence content word", () => {
    const job = makeJob([segment({ lowTokens: [token()] })]);
    const items = itemsOf(job);

    expect(items).toHaveLength(1);
    expect(items[0]?.word).toBe("newth");
    expect(items[0]?.confidence).toBe(0.185);
    expect(items[0]?.sentence).toBe("Find newth and comb.");
    expect(items[0]?.alternatives).toEqual([" fine, newth", " fine, nuth"]);
  });

  it("ignores words at or above the review threshold", () => {
    const job = makeJob([segment({ lowTokens: [token({ confidence: REVIEW_THRESHOLD })] })]);
    expect(itemsOf(job)).toHaveLength(0);
  });

  it("drops filler and function words however low their confidence", () => {
    // These are the measured floor tokens from a real 43-minute recording:
    // ranking on raw confidence would put all of them above the real errors.
    const fillers = ["their", "the", "um", "uh", "yeah", "Oh"];
    const job = makeJob([
      segment({
        lowTokens: fillers.map((text, i) => token({ text, confidence: 0.001 + i * 0.01 })),
      }),
    ]);
    expect(itemsOf(job)).toHaveLength(0);
  });

  it("drops words shorter than the minimum length", () => {
    const job = makeJob([segment({ lowTokens: [token({ text: "it" })] })]);
    expect(itemsOf(job)).toHaveLength(0);
  });

  it("matches stopwords ignoring case and trailing punctuation", () => {
    const job = makeJob([
      segment({ lowTokens: [token({ text: "Yeah," }), token({ text: "THE" })] }),
    ]);
    expect(itemsOf(job)).toHaveLength(0);
  });

  it("ranks worst-first regardless of position in the recording", () => {
    const job = makeJob([
      segment({ start: 0, end: 2, lowTokens: [token({ text: "vessel", confidence: 0.4 })] }),
      segment({
        start: 2,
        end: 4,
        text: "Second one.",
        lowTokens: [token({ text: "Crom", confidence: 0.1 })],
      }),
    ]);
    expect(itemsOf(job).map((i) => i.word)).toEqual(["Crom", "vessel"]);
  });
});

describe("collectReviewItems: alignment with the assembled transcript", () => {
  it("attaches the speaker label of the sentence the word sits in", () => {
    const job = makeJob(
      [
        segment({ start: 0, end: 2, text: "First sentence.", lowTokens: [] }),
        segment({ start: 2, end: 4, text: "Second sentence.", lowTokens: [token({ start: 3 })] }),
      ],
      {
        diarize: true,
        speakers: {
          segments: [
            { start: 0, end: 2, speaker: "S1" },
            { start: 2, end: 4, speaker: "S2" },
          ],
          count: 2,
        },
      },
    );

    const items = itemsOf(job);
    expect(items).toHaveLength(1);
    expect(items[0]?.speaker).toBe("S2");
    expect(items[0]?.sentence).toBe("Second sentence.");
  });

  it("stays aligned when empty segments are filtered out", () => {
    // assembleTranscript drops empty segments and renumbers; the review list
    // walks the raw segments through the same filter. If the two ever fall out
    // of step, the flagged word is quoted against the wrong sentence — the kind
    // of error that looks plausible and misleads a reader.
    const job = makeJob(
      [
        segment({ start: 0, end: 1, text: "   ", lowTokens: [] }),
        segment({
          start: 1,
          end: 2,
          text: "Real sentence here.",
          lowTokens: [token({ start: 1.5 })],
        }),
      ],
      {
        diarize: true,
        speakers: { segments: [{ start: 1, end: 2, speaker: "S3" }], count: 1 },
      },
    );

    const items = itemsOf(job);
    expect(items).toHaveLength(1);
    expect(items[0]?.sentence).toBe("Real sentence here.");
    expect(items[0]?.speaker).toBe("S3");
  });
});

describe("renderReview", () => {
  it("lists a flagged word with timestamp, confidence, context and alternatives", () => {
    const job = makeJob([
      segment({ start: 1467, end: 1470, lowTokens: [token({ start: 1467.32 })] }),
    ]);
    const md = reviewOf(job);

    expect(md).toContain("# Review — Panel.wav");
    expect(md).toContain("24:27");
    expect(md).toContain("`newth`");
    expect(md).toContain("(0.185)");
    expect(md).toContain("Find **newth** and comb.");
    expect(md).toContain("`fine, newth`");
  });

  it("says so plainly when nothing is flagged", () => {
    const md = reviewOf(makeJob([segment({ lowTokens: [] })]));
    expect(md).toContain("Nothing flagged");
    // A clean list must not be read as a correctness guarantee.
    expect(md).toContain("confidently wrong");
  });

  it("distinguishes 'no confidence data' from 'nothing flagged'", () => {
    // A transcript produced by a helper build predating this feature.
    const job = makeJob([segment({ confidence: null, lowTokens: [] })]);
    const md = reviewOf(job);
    expect(md).toContain("no confidence data");
    expect(md).not.toContain("Nothing flagged");
  });

  it("handles a transcript with no segments at all", () => {
    const md = reviewOf(makeJob([]));
    expect(md).toContain("nothing to review");
  });

  it("caps a very long list and says how many were withheld", () => {
    const many = Array.from({ length: MAX_REVIEW_ITEMS + 25 }, (_, i) =>
      segment({
        start: i,
        end: i + 1,
        text: `Sentence ${i} about vessel.`,
        lowTokens: [token({ text: "vessel", start: i, confidence: 0.2 })],
      }),
    );
    const md = reviewOf(makeJob(many));

    expect(md).toContain(`Showing the worst ${MAX_REVIEW_ITEMS} of ${MAX_REVIEW_ITEMS + 25}`);
    // The header still reports the true total, not the truncated count.
    expect(md).toContain(`${MAX_REVIEW_ITEMS + 25} spots`);
  });

  it("falls back to the plain sentence when the word cannot be located in it", () => {
    const job = makeJob([
      segment({ text: "Punctuation differs here.", lowTokens: [token({ text: "differs," })] }),
    ]);
    const md = reviewOf(job);
    expect(md).toContain("Punctuation differs here.");
    expect(md).not.toContain("**");
  });
});

describe("presentableAlternatives", () => {
  it("collapses hypotheses differing only in case or punctuation", () => {
    // Observed verbatim on a real recording.
    expect(presentableAlternatives([" All right.", " Right.", " right.", " All right,"])).toEqual([
      "All right.",
      "Right.",
    ]);
  });

  it("keeps a genuine word difference — the whole point of showing alternatives", () => {
    expect(presentableAlternatives([" someone, then", " someone than"])).toEqual([
      "someone, then",
      "someone than",
    ]);
  });

  it("drops phrase-length restatements that bury the difference", () => {
    const longPhrase = "a".repeat(MAX_ALTERNATIVE_CHARS + 1);
    expect(presentableAlternatives([longPhrase, " short"])).toEqual(["short"]);
  });

  it("caps how many are shown", () => {
    const many = Array.from({ length: MAX_ALTERNATIVES_SHOWN + 3 }, (_, i) => `word${i}`);
    expect(presentableAlternatives(many)).toHaveLength(MAX_ALTERNATIVES_SHOWN);
  });

  it("drops empty and punctuation-only entries", () => {
    expect(presentableAlternatives(["  ", " , ", " real"])).toEqual(["real"]);
  });
});
