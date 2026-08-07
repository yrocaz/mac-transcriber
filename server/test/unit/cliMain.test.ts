/**
 * Exit-code and dry-run coverage at the `main()` boundary.
 *
 * The other suites assert on `TreeSummary`, which is not the same thing as
 * what the process returns — `transcribe dir/ && next-step` composes on the
 * exit code, and nothing below `main()` decides it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, renderTreePlan } from "../../src/cli";
import { planTree } from "../../src/runTree";
import { parseHints } from "../../src/hints";
import { FAKE_HELPER_PATH, makeTempDataDir } from "../helpers/testApp";

function makeSourceTree(relatives: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "climain-src-"));
  for (const relative of relatives) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }
  return root;
}

let stderr: string;
let stdout: string;

beforeEach(() => {
  process.env.TRANSCRIBER_HELPER_PATH = FAKE_HELPER_PATH;
  process.env.TRANSCRIBER_DATA_DIR = makeTempDataDir();
  stderr = "";
  stdout = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRANSCRIBER_HELPER_PATH;
  delete process.env.TRANSCRIBER_DATA_DIR;
});

describe("main: tree-mode exit codes", () => {
  it("returns 0 when every file succeeds", async () => {
    const root = makeSourceTree(["basic.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));
    expect(await main([root, "--out", out, "--no-prompt"])).toBe(0);
  });

  it("returns 1 when any file fails, so `transcribe dir/ && next` short-circuits", async () => {
    const root = makeSourceTree(["basic.wav", "crash-silent.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));
    expect(await main([root, "--out", out, "--no-prompt"])).toBe(1);
  });

  it("returns 2 for a malformed hints file, before transcribing anything", async () => {
    const root = makeSourceTree(["basic.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));
    const hints = path.join(os.tmpdir(), `bad-hints-${process.pid}.txt`);
    fs.writeFileSync(hints, "*Panel*  --speaker 5\n"); // typo: --speaker

    expect(await main([root, "--out", out, "--hints", hints, "--no-prompt"])).toBe(2);
    expect(stderr).toMatch(/hints line 1/);
    expect(fs.existsSync(path.join(out, "basic", "transcript.txt"))).toBe(false);
  });

  it("returns 2 for a path that does not exist", async () => {
    expect(await main([path.join(os.tmpdir(), "no-such-dir-xyz"), "--no-prompt"])).toBe(2);
  });

  it("prints the summary even when stderr is not a TTY", async () => {
    // The scripted batch case. The summary — counts plus which files failed —
    // is the deliverable of a run; only the live bar needs a terminal.
    const root = makeSourceTree(["basic.wav", "crash-silent.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));

    await main([root, "--out", out, "--no-prompt"]);

    expect(stderr).toMatch(/2 media files · 1 transcribed/);
    expect(stderr).toMatch(/failed:/);
    expect(stderr).toMatch(/crash-silent\.wav/);
  });
});

describe("main: --dry-run", () => {
  it("transcribes nothing and exits 0", async () => {
    const root = makeSourceTree(["basic.wav", "Nested/basic2.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));

    expect(await main([root, "--out", out, "--dry-run", "--no-prompt"])).toBe(0);

    expect(fs.existsSync(path.join(out, "basic", "transcript.txt"))).toBe(false);
    expect(fs.existsSync(path.join(out, "Nested", "basic2", "transcript.txt"))).toBe(false);
    expect(stderr).toMatch(/2 media files/);
    expect(stderr).toMatch(/would transcribe 2, skip 0/);
  });

  it("reports which hint rule each file matched", async () => {
    const root = makeSourceTree(["Panels/basic.wav", "solo.wav"]);
    const hints = path.join(os.tmpdir(), `hints-${process.pid}.txt`);
    fs.writeFileSync(hints, "*Panels/*  --speakers 5\n");

    await main([root, "--dry-run", "--hints", hints, "--min-speakers", "1", "--max-speakers", "2"]);

    expect(stderr).toMatch(/Panels\/basic\.wav\s+5 speakers via "\*Panels\/\*"/);
    expect(stderr).toMatch(/solo\.wav\s+1–2 speakers via CLI flags/);
  });

  it("emits the plan as JSON with --json", async () => {
    const root = makeSourceTree(["basic.wav"]);
    expect(await main([root, "--dry-run", "--json"])).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ relativePath: "basic.wav", action: "transcribe" });
  });

  it("marks already-transcribed files as skip", async () => {
    const root = makeSourceTree(["basic.wav"]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "climain-out-"));
    fs.mkdirSync(path.join(out, "basic"), { recursive: true });
    fs.writeFileSync(path.join(out, "basic", "transcript.txt"), "done");

    await main([root, "--out", out, "--dry-run"]);
    expect(stderr).toMatch(/would transcribe 0, skip 1/);
  });
});

describe("renderTreePlan", () => {
  it("says so plainly when a tree holds no media", () => {
    const plan = planTree({
      root: makeSourceTree(["notes.txt"]),
      outRoot: null,
      hints: [],
      speakerHint: null,
      force: false,
    });
    expect(renderTreePlan(plan)).toMatch(/no media files found/);
  });

  it("matches what a real run would do, since both read the same plan", () => {
    const root = makeSourceTree(["Panels/basic.wav", "solo.wav"]);
    const plan = planTree({
      root,
      outRoot: "/out",
      hints: parseHints("*Panels/*  --speakers 5"),
      speakerHint: null,
      force: false,
    });
    expect(plan.files.map((f) => f.matchedGlob)).toEqual(["*Panels/*", null]);
    expect(plan.files[0]!.outputDir).toBe("/out/Panels/basic");
  });
});
