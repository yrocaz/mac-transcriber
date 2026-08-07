import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobStore";
import { HelperSupervisor } from "../../src/supervisor";
import { transcribeOne } from "../../src/runFile";
import { assembleTranscript } from "../../src/transcript";
import { DEFAULT_TIMEOUTS } from "../../src/config";
import { FAKE_HELPER_PATH, fixtureMediaPath, makeTempDataDir } from "../helpers/testApp";

function setup() {
  const store = new JobStore(makeTempDataDir());
  store.init();
  // DEFAULT_TIMEOUTS, not FAST_TIMEOUTS: the `basic` fake-helper scenario
  // sleeps 0.15s deliberately, and FAST_TIMEOUTS' 400ms inactivity budget
  // loses that race once the whole suite runs 14 files in parallel on a
  // cold machine. Nothing here is testing timeout behaviour.
  const supervisor = new HelperSupervisor({
    helperPath: FAKE_HELPER_PATH,
    timeouts: DEFAULT_TIMEOUTS,
  });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "runfile-out-"));
  return { store, supervisor, outputDir };
}

/**
 * Stands in for the real afconvert re-encode. Unit fixtures are zero-byte
 * files the fake helper never opens, so there is nothing for afconvert to
 * convert; what matters here is the control flow around it. The temp file is
 * named `recovered-*` because that is what selects the success scenario in
 * fake-helper.sh — the same asymmetry damaged media shows in practice.
 */
function fakeReencode(calls: string[]) {
  return async <T>(source: string, body: (wavPath: string) => Promise<T>): Promise<T> => {
    calls.push(source);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-recover-"));
    const wavPath = path.join(dir, `recovered-${path.basename(source, path.extname(source))}.wav`);
    fs.writeFileSync(wavPath, "");
    try {
      return await body(wavPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("transcribeOne", () => {
  it("returns the finished job for a healthy file without re-encoding", async () => {
    const { store, supervisor, outputDir } = setup();
    const calls: string[] = [];

    const { job, recovered } = await transcribeOne(supervisor, store, {
      mediaPath: fixtureMediaPath("basic.wav"),
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: fakeReencode(calls),
    });

    expect(job.status).toBe("done");
    expect(recovered).toBe(false);
    expect(calls).toEqual([]);
    expect(fs.readFileSync(path.join(outputDir, "transcript.txt"), "utf8")).toContain(
      "Hello there.",
    );
  });

  it("recovers a mid-file abort by re-encoding once", async () => {
    const { store, supervisor, outputDir } = setup();
    const calls: string[] = [];
    const source = fixtureMediaPath("damaged-midfile.mp3");

    const { job, recovered } = await transcribeOne(supervisor, store, {
      mediaPath: source,
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: fakeReencode(calls),
    });

    expect(recovered).toBe(true);
    expect(job.status).toBe("done");
    expect(calls).toEqual([source]); // exactly one re-encode, never a loop
    expect(fs.readFileSync(path.join(outputDir, "transcript.txt"), "utf8")).toContain(
      "Recovered after re-encoding.",
    );
  });

  it("records the ORIGINAL media as the transcript's source, not the temp file", async () => {
    // The temp WAV is deleted moments later. During the manual recovery that
    // motivated this feature, the transcript named a scratch path that no
    // longer existed and had to be patched by hand afterwards.
    const { store, supervisor, outputDir } = setup();
    const source = fixtureMediaPath("damaged-midfile.mp3");

    const { job } = await transcribeOne(supervisor, store, {
      mediaPath: source,
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: fakeReencode([]),
    });

    expect(assembleTranscript(job).metadata.source).toBe(source);
    // The readable header takes its title from that basename too.
    expect(fs.readFileSync(path.join(outputDir, "transcript.txt"), "utf8")).toContain(
      "damaged-midfile.mp3",
    );
  });

  it("leaves a warning so a recovered transcript is self-describing", async () => {
    const { store, supervisor, outputDir } = setup();
    const { job } = await transcribeOne(supervisor, store, {
      mediaPath: fixtureMediaPath("damaged-midfile.mp3"),
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: fakeReencode([]),
    });

    const warning = job.warnings.find((w) => w.code === "recoveredByReencode");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/re-encode/i);
  });

  it("does not re-encode a failure that happened before any audio was decoded", async () => {
    const { store, supervisor, outputDir } = setup();
    const calls: string[] = [];

    const { job, recovered } = await transcribeOne(supervisor, store, {
      mediaPath: fixtureMediaPath("damaged-at-zero.mp3"),
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: fakeReencode(calls),
    });

    expect(recovered).toBe(false);
    expect(job.status).toBe("error");
    expect(calls).toEqual([]);
  });

  it("keeps the original diagnosis when re-encoding itself fails", async () => {
    const { store, supervisor, outputDir } = setup();
    const { job, recovered } = await transcribeOne(supervisor, store, {
      mediaPath: fixtureMediaPath("damaged-midfile.mp3"),
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      reencode: async () => {
        throw new Error("afconvert: command not found");
      },
    });

    expect(recovered).toBe(false);
    expect(job.status).toBe("error");
    // "the re-encode also failed" is less actionable than the fault that
    // triggered recovery in the first place.
    expect(job.error!.message).toMatch(/GenericObjCError/);
  });

  it("honours recover:false", async () => {
    const { store, supervisor, outputDir } = setup();
    const calls: string[] = [];
    const { recovered } = await transcribeOne(supervisor, store, {
      mediaPath: fixtureMediaPath("damaged-midfile.mp3"),
      outputDir,
      locale: "en-US",
      diarize: true,
      speakerHint: null,
      recover: false,
      reencode: fakeReencode(calls),
    });
    expect(recovered).toBe(false);
    expect(calls).toEqual([]);
  });
});
