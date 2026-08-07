import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobStore";
import { HelperSupervisor } from "../../src/supervisor";
import { runTree, runLogPath } from "../../src/runTree";
import { parseHints } from "../../src/hints";
import { DEFAULT_TIMEOUTS } from "../../src/config";
import { FAKE_HELPER_PATH, makeTempDataDir } from "../helpers/testApp";

/** Builds a source tree of empty media files; the fake helper picks its
 *  scenario from the basename, so contents are irrelevant. */
function makeSourceTree(relatives: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtree-src-"));
  for (const relative of relatives) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }
  return root;
}

function setup() {
  const store = new JobStore(makeTempDataDir());
  store.init();
  // DEFAULT_TIMEOUTS, not FAST_TIMEOUTS: the `basic` fake-helper scenario
  // sleeps 0.15s deliberately, and FAST_TIMEOUTS' 400ms inactivity budget
  // loses that race once the whole suite runs 14 files in parallel on a
  // cold machine. Nothing here is testing timeout behaviour.
  const supervisor = new HelperSupervisor({ helperPath: FAKE_HELPER_PATH, timeouts: DEFAULT_TIMEOUTS });
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtree-out-"));
  return { store, supervisor, outRoot };
}

const base = {
  locale: "en-US",
  diarize: true,
  speakerHint: null,
  hints: [],
  force: false,
};

describe("runTree", () => {
  it("transcribes every media file in the tree, mirroring the layout", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav", "Nested/basic2.wav"]);

    const summary = await runTree(supervisor, store, { ...base, root, outRoot });

    expect(summary.total).toBe(2);
    expect(summary.done).toBe(2);
    expect(summary.failed).toBe(0);
    expect(fs.existsSync(path.join(outRoot, "basic", "transcript.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, "Nested", "basic2", "transcript.txt"))).toBe(true);
  });

  it("keeps identically-named files in different folders apart", async () => {
    // The silent data-loss case this whole layout exists to prevent.
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["A/basic.wav", "B/basic.wav"]);

    const summary = await runTree(supervisor, store, { ...base, root, outRoot });

    expect(summary.done).toBe(2);
    expect(fs.existsSync(path.join(outRoot, "A", "basic", "transcript.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outRoot, "B", "basic", "transcript.txt"))).toBe(true);
  });

  it("skips files that already have a transcript, so an interrupted run resumes free", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav", "basic2.wav"]);
    fs.mkdirSync(path.join(outRoot, "basic"), { recursive: true });
    fs.writeFileSync(path.join(outRoot, "basic", "transcript.txt"), "already done");

    const summary = await runTree(supervisor, store, { ...base, root, outRoot });

    expect(summary.skipped).toBe(1);
    expect(summary.done).toBe(1);
    expect(fs.readFileSync(path.join(outRoot, "basic", "transcript.txt"), "utf8")).toBe("already done");
  });

  it("reprocesses everything under --force", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav"]);
    fs.mkdirSync(path.join(outRoot, "basic"), { recursive: true });
    fs.writeFileSync(path.join(outRoot, "basic", "transcript.txt"), "stale");

    const summary = await runTree(supervisor, store, { ...base, root, outRoot, force: true });

    expect(summary.skipped).toBe(0);
    expect(summary.done).toBe(1);
    expect(fs.readFileSync(path.join(outRoot, "basic", "transcript.txt"), "utf8")).toContain("Hello there.");
  });

  it("keeps going after a failure and reports which file failed", async () => {
    // One bad file in a 43-file batch must cost one file, not the batch.
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav", "crash-silent.wav", "basic2.wav"]);

    const summary = await runTree(supervisor, store, { ...base, root, outRoot });

    expect(summary.done).toBe(2);
    expect(summary.failed).toBe(1);
    const failed = summary.outcomes.find((o) => o.status === "failed")!;
    expect(failed.relativePath).toBe("crash-silent.wav");
    expect(failed.error).toBeTruthy();
  });

  it("applies per-file hints, falling back to the CLI hint when no rule matches", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["Panels/basic.wav", "basic2.wav"]);
    const hints = parseHints("*Panels/*  --speakers 5");

    const summary = await runTree(supervisor, store, {
      ...base,
      root,
      outRoot,
      hints,
      speakerHint: { exact: null, min: 1, max: 2 },
    });

    expect(summary.done).toBe(2);
    const jobs = store.listJobs();
    const panel = jobs.find((j) => j.path.includes("Panels"))!;
    const other = jobs.find((j) => !j.path.includes("Panels"))!;
    expect(panel.speakerHint).toEqual({ exact: 5, min: null, max: null });
    expect(other.speakerHint).toEqual({ exact: null, min: 1, max: 2 });
  });

  it("writes transcripts beside the media when --out is omitted", async () => {
    const { store, supervisor } = setup();
    const root = makeSourceTree(["Nested/basic.wav"]);

    await runTree(supervisor, store, { ...base, root, outRoot: null });

    expect(fs.existsSync(path.join(root, "Nested", "basic", "transcript.txt"))).toBe(true);
  });

  it("writes a run log recording start, done, skip and failure", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav", "crash-silent.wav", "basic2.wav"]);
    fs.mkdirSync(path.join(outRoot, "basic2"), { recursive: true });
    fs.writeFileSync(path.join(outRoot, "basic2", "transcript.txt"), "done earlier");

    await runTree(supervisor, store, { ...base, root, outRoot });

    const log = fs.readFileSync(runLogPath(root, outRoot), "utf8");
    expect(log).toMatch(/run started · 3 media files/);
    expect(log).toMatch(/done {2}basic\.wav/);
    expect(log).toMatch(/skip {2}basic2\.wav \(already transcribed\)/);
    expect(log).toMatch(/FAIL {2}crash-silent\.wav/);
    expect(log).toMatch(/1 done, 1 skipped, 1 failed/);
  });

  it("ignores ._ sidecars rather than reporting them as failures", async () => {
    const { store, supervisor, outRoot } = setup();
    const root = makeSourceTree(["basic.wav", "._basic.wav"]);

    const summary = await runTree(supervisor, store, { ...base, root, outRoot });

    expect(summary.total).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("reports an empty tree without error", async () => {
    const { store, supervisor, outRoot } = setup();
    const summary = await runTree(supervisor, store, { ...base, root: makeSourceTree([]), outRoot });
    expect(summary).toMatchObject({ total: 0, done: 0, failed: 0, skipped: 0 });
  });
});
