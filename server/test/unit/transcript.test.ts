import { describe, it, expect } from "vitest";
import type { JobRecord } from "../../src/types";
import { assembleTranscript, renderSrt } from "../../src/transcript";

function makeJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "test-job",
    path: "/path/to/media.mp4",
    locale: "en-US",
    diarize: true,
    status: "done",
    progress: 1,
    warnings: [],
    error: null,
    createdAt: "2026-07-27T18:00:00Z",
    startedAt: "2026-07-27T18:00:01Z",
    finishedAt: "2026-07-27T18:00:30Z",
    durationSec: 10.5,
    stderrTail: null,
    segments: [
      { start: 0, end: 2.5, text: "Hello world." },
      { start: 2.5, end: 4.5, text: "This is a test." },
    ],
    speakers: {
      segments: [
        { start: 0, end: 2.5, speaker: "S1" },
        { start: 2.5, end: 4.5, speaker: "S2" },
      ],
      count: 2,
    },
    ...overrides,
  };
}

describe("assembleTranscript", () => {
  describe("metadata.diarization", () => {
    it('is "disabled" when diarize is false', () => {
      const job = makeJobRecord({
        diarize: false,
        speakers: null,
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.diarization).toBe("disabled");
      expect(transcript.metadata.speakerCount).toBeNull();
    });

    it('is "ok" when speakers event arrived (including count:0)', () => {
      const job = makeJobRecord({
        diarize: true,
        speakers: {
          segments: [],
          count: 0,
        },
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.diarization).toBe("ok");
      expect(transcript.metadata.speakerCount).toBe(0);
    });

    it('is "failed" when diarize is true but speakers is null', () => {
      const job = makeJobRecord({
        diarize: true,
        speakers: null,
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.diarization).toBe("failed");
      expect(transcript.metadata.speakerCount).toBeNull();
    });

    it('(defensive, not reachable via the real helper) is "failed" when speakers is non-null but a diarizationFailed warning is also present', () => {
      // TranscribeCommand.swift's diarization block makes a non-null
      // `speakers` event and a `diarizationFailed` warning mutually
      // exclusive in practice (see transcript.ts's deriveDiarizationStatus
      // comment) — this combination can't arise from the real helper. Kept
      // as a defensive-fallback test: if that invariant ever regresses, the
      // job should still degrade to "failed" rather than silently "ok".
      const job = makeJobRecord({
        diarize: true,
        speakers: {
          segments: [],
          count: 0,
        },
        warnings: [
          {
            code: "diarizationFailed",
            message: "model download failed",
          },
        ],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.diarization).toBe("failed");
      expect(transcript.metadata.speakerCount).toBeNull();
    });
  });

  describe("speaker merge (max-overlap strategy)", () => {
    it("breaks a tied overlap by earliest speaker (genuine max-overlap case is below)", () => {
      const job = makeJobRecord({
        segments: [{ start: 0, end: 5, text: "Long segment" }],
        speakers: {
          segments: [
            { start: 0, end: 2, speaker: "S1" },
            { start: 3, end: 5, speaker: "S2" },
          ],
          count: 2,
        },
      });
      const transcript = assembleTranscript(job);
      // Segment spans 0-5. S1 overlaps 0-2 (2s), S2 overlaps 3-5 (2s) — an
      // exact tie, not a max. findMaxOverlapSpeaker only replaces the
      // running winner on strictly-greater overlap, so the first speaker
      // encountered (S1) wins ties. The test for a genuine strictly-greater
      // max lives at "speaker merge: maximum overlap selection" below.
      expect(transcript.segments[0].speaker).toBe("S1");
    });

    it("returns null when no overlapping turn exists", () => {
      const job = makeJobRecord({
        segments: [{ start: 5, end: 7, text: "No overlap" }],
        speakers: {
          segments: [{ start: 0, end: 2, speaker: "S1" }],
          count: 1,
        },
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments[0].speaker).toBeNull();
    });

    it("ignores touching boundaries (strict > 0 overlap)", () => {
      const job = makeJobRecord({
        segments: [{ start: 2, end: 4, text: "Touches boundary" }],
        speakers: {
          segments: [
            { start: 0, end: 2, speaker: "S1" }, // ends exactly where segment starts
          ],
          count: 1,
        },
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments[0].speaker).toBeNull();
    });

    it("returns null for all segments when diarization is disabled", () => {
      const job = makeJobRecord({
        diarize: false,
        speakers: null,
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments.every((s) => s.speaker === null)).toBe(true);
    });

    it("returns null for all segments when diarization failed", () => {
      const job = makeJobRecord({
        diarize: true,
        speakers: null,
        warnings: [],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments.every((s) => s.speaker === null)).toBe(true);
    });

    it("(defensive, not reachable via the real helper) returns null for all segments when count:0 but a diarizationFailed warning is also present", () => {
      // Same unreachable-in-practice combination as the metadata.diarization
      // defensive test above (speakers non-null + diarizationFailed warning
      // both present) — kept to pin the defensive fallback's segment-level
      // behavior too.
      const job = makeJobRecord({
        diarize: true,
        speakers: {
          segments: [],
          count: 0,
        },
        warnings: [
          {
            code: "diarizationFailed",
            message: "failed",
          },
        ],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments.every((s) => s.speaker === null)).toBe(true);
    });
  });

  describe("millisecond rounding", () => {
    it("rounds segment timestamps and durationSec to 3 decimals", () => {
      const job = makeJobRecord({
        durationSec: 10.5709999999999997,
        segments: [{ start: 0.123456, end: 2.987654, text: "Test" }],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.durationSec).toBe(10.571);
      expect(transcript.segments[0].start).toBe(0.123);
      expect(transcript.segments[0].end).toBe(2.988);
    });
  });

  describe("flat text and segment ordering", () => {
    it("joins non-empty segments with spaces, drops empty ones", () => {
      const job = makeJobRecord({
        segments: [
          { start: 0, end: 1, text: "Hello" },
          { start: 1, end: 2, text: "" }, // empty, dropped
          { start: 2, end: 3, text: "  world  " }, // trimmed to "world"
        ],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.text).toBe("Hello world");
      // Empty segments are dropped from the segments array entirely (not
      // just from `text`); remaining segments get contiguous 0-based ids —
      // see the "segment id assignment" describe block below for that.
      expect(transcript.segments).toHaveLength(2); // Only non-empty
    });

    it("trims whitespace from segment text", () => {
      const job = makeJobRecord({
        segments: [{ start: 0, end: 1, text: "  padded  " }],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments[0].text).toBe("padded");
    });
  });

  describe("metadata fields", () => {
    it("uses job.createdAt for metadata.createdAt (not new Date())", () => {
      const job = makeJobRecord({
        createdAt: "2026-07-27T18:00:00Z",
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.createdAt).toBe("2026-07-27T18:00:00Z");
    });

    it("uses job.path for metadata.source", () => {
      const job = makeJobRecord({
        path: "/custom/path/video.mp4",
      });
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.source).toBe("/custom/path/video.mp4");
    });

    it("engine is always apple-speechanalyzer", () => {
      const job = makeJobRecord();
      const transcript = assembleTranscript(job);
      expect(transcript.metadata.engine).toBe("apple-speechanalyzer");
    });
  });

  describe("segment id assignment", () => {
    it("assigns sequential 0-based ids to non-empty segments", () => {
      const job = makeJobRecord({
        segments: [
          { start: 0, end: 1, text: "First" },
          { start: 1, end: 2, text: "Second" },
          { start: 2, end: 3, text: "Third" },
        ],
      });
      const transcript = assembleTranscript(job);
      expect(transcript.segments[0].id).toBe(0);
      expect(transcript.segments[1].id).toBe(1);
      expect(transcript.segments[2].id).toBe(2);
    });

    it("reassigns contiguous ids after filtering empty segments", () => {
      const job = makeJobRecord({
        segments: [
          { start: 0, end: 1, text: "First" },
          { start: 1, end: 2, text: "" }, // empty, will be filtered
          { start: 2, end: 3, text: "Third" },
          { start: 3, end: 4, text: "   " }, // whitespace-only, trims to empty
          { start: 4, end: 5, text: "Fifth" },
        ],
      });
      const transcript = assembleTranscript(job);
      // Only non-empty segments: First (id 0), Third (id 1), Fifth (id 2)
      expect(transcript.segments.length).toBe(3);
      expect(transcript.segments[0].id).toBe(0);
      expect(transcript.segments[0].text).toBe("First");
      expect(transcript.segments[1].id).toBe(1);
      expect(transcript.segments[1].text).toBe("Third");
      expect(transcript.segments[2].id).toBe(2);
      expect(transcript.segments[2].text).toBe("Fifth");
    });
  });

  describe("speaker merge: maximum overlap selection", () => {
    it("assigns speaker with strictly greater overlap (not just tied)", () => {
      const job = makeJobRecord({
        segments: [{ start: 0, end: 10, text: "Long segment spans both speakers" }],
        speakers: {
          segments: [
            { start: 0, end: 3, speaker: "S1" }, // 3s overlap (0-3)
            { start: 2, end: 10, speaker: "S2" }, // 8s overlap (2-10)
          ],
          count: 2,
        },
      });
      const transcript = assembleTranscript(job);
      // S2 wins because 8 > 3 (not because it comes later; max is the tiebreaker).
      expect(transcript.segments[0].speaker).toBe("S2");
    });

    it('assigns speaker: null for all segments when diarization is "ok" with zero turns', () => {
      const job = makeJobRecord({
        diarize: true,
        speakers: {
          segments: [],
          count: 0,
        },
        segments: [
          { start: 0, end: 1, text: "Segment one" },
          { start: 1, end: 2, text: "Segment two" },
        ],
      });
      const transcript = assembleTranscript(job);
      // Diarization succeeded (ok) but found zero speakers.
      expect(transcript.metadata.diarization).toBe("ok");
      expect(transcript.metadata.speakerCount).toBe(0);
      // No turns to merge, so all speakers are null.
      expect(transcript.segments[0].speaker).toBeNull();
      expect(transcript.segments[1].speaker).toBeNull();
    });
  });
});

describe("renderSrt", () => {
  it("renders SRT with proper timing and sequential indices", () => {
    const segments = [
      {
        id: 0,
        start: 0,
        end: 2.5,
        text: "Hello world.",
        speaker: "S1",
      },
      {
        id: 1,
        start: 2.5,
        end: 5.123,
        text: "This is a test.",
        speaker: "S2",
      },
    ];
    const srt = renderSrt(segments);
    const lines = srt.split("\n");
    expect(lines[0]).toBe("1");
    expect(lines[1]).toBe("00:00:00,000 --> 00:00:02,500");
    expect(lines[2]).toBe("Hello world.");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("2");
    expect(lines[5]).toBe("00:00:02,500 --> 00:00:05,123");
    expect(lines[6]).toBe("This is a test.");
    expect(lines[7]).toBe("");
  });

  it("formats times with HH:MM:SS,mmm format", () => {
    const segments = [
      {
        id: 0,
        start: 3661.5, // 1h 1m 1.5s
        end: 7325, // 2h 2m 5s
        text: "Long segment",
        speaker: null,
      },
    ];
    const srt = renderSrt(segments);
    const lines = srt.split("\n");
    expect(lines[1]).toBe("01:01:01,500 --> 02:02:05,000");
  });

  it("zero-pads hours, minutes, seconds, and milliseconds", () => {
    const segments = [
      {
        id: 0,
        start: 0.001, // 1 ms
        end: 1.1, // 1.1 seconds
        text: "Padding test",
        speaker: null,
      },
    ];
    const srt = renderSrt(segments);
    const lines = srt.split("\n");
    expect(lines[1]).toBe("00:00:00,001 --> 00:00:01,100");
  });

  it("produces trailing newline", () => {
    const segments = [
      {
        id: 0,
        start: 0,
        end: 1,
        text: "Test",
        speaker: null,
      },
    ];
    const srt = renderSrt(segments);
    // renderSrt doesn't add trailing newline; that's up to the caller.
    // Verify the format ends with a blank line between blocks.
    expect(srt.endsWith("\n")).toBe(true);
  });

  it("handles empty segment list", () => {
    const srt = renderSrt([]);
    expect(srt).toBe("");
  });
});
