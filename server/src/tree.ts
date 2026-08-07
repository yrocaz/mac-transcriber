/**
 * Directory walking and output-path mirroring for tree mode.
 *
 * Both functions here encode a lesson from transcribing a real 43-file meetup
 * archive, and both failures they prevent are silent ones — which is why they
 * are separate, tested functions rather than a few lines inlined in cli.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_EXTENSIONS } from "./types";

const EXTENSIONS = new Set<string>(SUPPORTED_EXTENSIONS);

/**
 * Recursively collects media files under `root`, sorted, absolute.
 *
 * Two exclusions matter more than they look:
 *
 *  - **`._*` AppleDouble sidecars.** macOS writes these next to real files on
 *    non-HFS volumes (USB drives, SMB shares, SD cards). They carry the same
 *    extension as the file they shadow, so `._Panel.wav` looks exactly like
 *    media to an extension filter. The archive this was built for held 21 of
 *    them against 43 real recordings — a naive walk reports 21 failures and
 *    buries the one that mattered.
 *  - **dot-directories**, so `.git`, `.Trashes` and `.Spotlight-V100` don't
 *    get crawled on an external volume.
 *
 * Sorted output makes an interrupted run resume in a predictable order, which
 * matters when you are watching a log to see how far a multi-hour batch got.
 */
export function walkMediaTree(root: string): string[] {
  const found: string[] = [];

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdirectory: skip it rather than abort the walk
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (EXTENSIONS.has(ext)) found.push(full);
      }
    }
  };

  visit(path.resolve(root));
  return found;
}

/**
 * Where one file's transcripts go when the whole tree is written under a
 * single `--out` root: the source's path relative to the walk root, minus the
 * extension.
 *
 *   Recordings/Next Deal Edit/Panel.wav
 *     → <out>/Next Deal Edit/Panel/
 *
 * The mirroring is load-bearing, not tidiness. `cli.ts` writes the four
 * transcript files *flat* into `--out`, so pointing every file at one
 * directory makes each recording overwrite the last. The archive held
 * `Panel.wav` in four different event folders and `RR.wav` in two: flattened,
 * 43 inputs produce 36 surviving outputs, with no error raised and nothing in
 * the log to suggest anything was lost.
 */
export function mirroredOutputDir(inputRoot: string, mediaPath: string, outRoot: string): string {
  const relative = path.relative(path.resolve(inputRoot), path.resolve(mediaPath));
  const withoutExt = relative.slice(0, relative.length - path.extname(relative).length);
  return path.join(path.resolve(outRoot), withoutExt);
}

/** Path relative to the walk root, `/`-separated, for matching hint globs. */
export function relativeKey(inputRoot: string, mediaPath: string): string {
  return path.relative(path.resolve(inputRoot), path.resolve(mediaPath)).split(path.sep).join("/");
}

/**
 * A file is "already transcribed" when its output holds a non-empty
 * transcript.txt. Emptiness is checked, not just existence: a run killed
 * mid-write leaves a zero-byte file, and treating that as done would silently
 * skip the very file the interruption damaged.
 */
export function hasTranscript(outputDir: string): boolean {
  try {
    return fs.statSync(path.join(outputDir, "transcript.txt")).size > 0;
  } catch {
    return false;
  }
}
