import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasTranscript, mirroredOutputDir, relativeKey, walkMediaTree } from "../../src/tree";

function makeTree(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-test-"));
  for (const [relative, contents] of Object.entries(layout)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

describe("walkMediaTree", () => {
  it("finds media at the top level and nested, sorted", () => {
    const root = makeTree({
      "2023 Year in Review.mp3": "",
      "3rd State of Econ/panel.wav": "",
      "3rd State of Econ/report.wav": "",
    });
    expect(walkMediaTree(root).map((p) => relativeKey(root, p))).toEqual([
      "2023 Year in Review.mp3",
      "3rd State of Econ/panel.wav",
      "3rd State of Econ/report.wav",
    ]);
  });

  it("excludes ._ AppleDouble sidecars", () => {
    // The archive this was built for held 21 of these against 43 real
    // recordings. They carry a media extension, so an extension filter alone
    // reports 21 failures and buries the one that mattered.
    const root = makeTree({
      "Panel.wav": "",
      "._Panel.wav": "",
      "Sub/._Nested.mp3": "",
      "Sub/Nested.mp3": "",
    });
    expect(walkMediaTree(root).map((p) => path.basename(p))).toEqual(["Panel.wav", "Nested.mp3"]);
  });

  it("excludes non-media files and unsupported extensions", () => {
    const root = makeTree({ "Panel.wav": "", "notes.txt": "", "clip.mkv": "", "art.jpg": "" });
    expect(walkMediaTree(root).map((p) => path.basename(p))).toEqual(["Panel.wav"]);
  });

  it("does not descend into dot-directories", () => {
    // .Spotlight-V100 and .Trashes on an external volume are full of junk.
    const root = makeTree({ "Panel.wav": "", ".Trashes/Old.wav": "", ".git/objects/x.mp3": "" });
    expect(walkMediaTree(root).map((p) => path.basename(p))).toEqual(["Panel.wav"]);
  });

  it("returns an empty list for a directory with no media", () => {
    expect(walkMediaTree(makeTree({ "readme.md": "" }))).toEqual([]);
  });
});

describe("mirroredOutputDir", () => {
  it("keeps identically-named files in different folders apart", () => {
    // The collision that silently loses work: Panel.wav appeared in four event
    // folders. Flattened into one --out, 43 inputs produce 36 outputs with no
    // error raised anywhere.
    const root = "/Recordings";
    const out = "/Transcripts";
    const dirs = [
      "4th affordable edit/Panel.wav",
      "Mastering Leads/Panel.wav",
      "Next Deal Edit/Panel.wav",
      "Secrets of Effective Landlording Edit/Panel.wav",
    ].map((relative) => mirroredOutputDir(root, path.join(root, relative), out));

    expect(new Set(dirs).size).toBe(4);
    expect(dirs[0]).toBe("/Transcripts/4th affordable edit/Panel");
  });

  it("strips only the extension, preserving dots in the name", () => {
    expect(mirroredOutputDir("/r", "/r/Sept 2023 - Edit 2.mp3", "/o")).toBe("/o/Sept 2023 - Edit 2");
  });

  it("handles a file directly at the root", () => {
    expect(mirroredOutputDir("/r", "/r/Luxury.mp3", "/o")).toBe("/o/Luxury");
  });
});

describe("hasTranscript", () => {
  it("is false when the directory or file is absent", () => {
    expect(hasTranscript(path.join(os.tmpdir(), "definitely-not-here-xyz"))).toBe(false);
  });

  it("is true only for a non-empty transcript", () => {
    // A run killed mid-write leaves a zero-byte file; treating that as done
    // would skip exactly the file the interruption damaged.
    const dir = makeTree({ "empty/transcript.txt": "", "full/transcript.txt": "words" });
    expect(hasTranscript(path.join(dir, "empty"))).toBe(false);
    expect(hasTranscript(path.join(dir, "full"))).toBe(true);
  });
});
