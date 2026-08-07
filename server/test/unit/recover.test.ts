import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLikelyDamagedMedia, reencodeToWav, withReencoded } from "../../src/recover";
import type { JobRecord } from "../../src/types";

function failedJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "j",
    path: "/tmp/x.mp3",
    locale: "en-US",
    diarize: true,
    speakerHint: null,
    outputDir: null,
    status: "error",
    progress: 0.5,
    warnings: [],
    error: { code: "unknown", message: "boom" },
    createdAt: "2026-08-07T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    durationSec: null,
    stderrTail: null,
    segments: [],
    speakers: null,
    ...overrides,
  };
}

describe("isLikelyDamagedMedia", () => {
  it("is true for the observed mid-file abort signature", () => {
    // The real case: two independent attempts both died at progress 0.6227,
    // identical to four decimals, with _GenericObjCError.
    expect(isLikelyDamagedMedia(failedJob({ progress: 0.6227 }))).toBe(true);
  });

  it("is true when the container or codec never opened", () => {
    expect(isLikelyDamagedMedia(failedJob({ error: { code: "audioReadFailed", message: "no track" } }))).toBe(true);
  });

  it("is false when nothing was decoded", () => {
    // Nothing about the audio data is implicated at progress 0 — the fault is
    // upstream (helper, model, locale), and re-encoding burns minutes to fail
    // in exactly the same way.
    expect(isLikelyDamagedMedia(failedJob({ progress: 0 }))).toBe(false);
  });

  it("is false when the audio was fully read", () => {
    expect(isLikelyDamagedMedia(failedJob({ progress: 1 }))).toBe(false);
  });

  it("is false for configuration errors regardless of progress", () => {
    const job = failedJob({
      progress: 0.5,
      error: { code: "cannotAllocateUnsupportedLocale", message: "no such locale" },
    });
    expect(isLikelyDamagedMedia(job)).toBe(false);
  });

  it("is false for a job that did not fail", () => {
    expect(isLikelyDamagedMedia(failedJob({ status: "done", error: null }))).toBe(false);
  });
});

/** A real, tiny, valid WAV so afconvert has something genuine to convert. */
function writeSilentWav(target: string, seconds = 1, rate = 8000): void {
  const samples = seconds * rate;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(target, Buffer.concat([header, Buffer.alloc(samples * 2)]));
}

describe("reencodeToWav", () => {
  it("produces a real WAV and cleans up after withReencoded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-src-"));
    const source = path.join(dir, "sample.wav");
    writeSilentWav(source);

    let seen = "";
    const returned = await withReencoded(source, async (wavPath) => {
      seen = wavPath;
      expect(fs.statSync(wavPath).size).toBeGreaterThan(44);
      // Named so a temp file stranded by a hard kill explains itself.
      expect(path.basename(wavPath)).toBe("recovered-sample.wav");
      return "body-result";
    });

    expect(returned).toBe("body-result");
    // A 56-minute MP3 becomes ~300MB of WAV; leaking these across a 43-file
    // batch would fill the disk.
    expect(fs.existsSync(seen)).toBe(false);
    expect(fs.existsSync(path.dirname(seen))).toBe(false);
  });

  it("removes the temp directory even when the body throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-src-"));
    const source = path.join(dir, "sample.wav");
    writeSilentWav(source);

    let seen = "";
    await expect(
      withReencoded(source, async (wavPath) => {
        seen = wavPath;
        throw new Error("transcription blew up");
      }),
    ).rejects.toThrow("transcription blew up");
    expect(fs.existsSync(path.dirname(seen))).toBe(false);
  });

  it("reports a clear error when the source cannot be decoded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recover-src-"));
    const source = path.join(dir, "not-audio.wav");
    fs.writeFileSync(source, "this is not audio");
    await expect(reencodeToWav(source)).rejects.toThrow(/could not re-encode not-audio\.wav/);
  });
});
