import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_EXTENSIONS } from "./types";

const SUPPORTED_EXTENSIONS_LIST = SUPPORTED_EXTENSIONS.join(", ");

/**
 * Input validation shared by the HTTP route and the CLI, so both reject the
 * same things with the same wording. Extracted from routes/jobs.ts when the
 * CLI landed — duplicating it would let the two surfaces drift.
 *
 * Order matters and is deliberate: extension before existence, so a user who
 * passes an .mkv gets told the format is unsupported rather than being sent
 * hunting for a file that is right there.
 */
export function validateMediaPath(target: string): string | null {
  const ext = path.extname(target).slice(1).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported file extension "${ext || "(none)"}". Supported: ${SUPPORTED_EXTENSIONS_LIST}`;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return `File does not exist: ${target}`;
  }
  if (!stat.isFile()) {
    return `Not a file: ${target}`;
  }
  try {
    fs.accessSync(target, fs.constants.R_OK);
  } catch {
    return `File is not readable: ${target}`;
  }
  return null;
}

/**
 * Where a media file's transcripts go for humans: a folder beside the source,
 * named after it. `/recordings/Panel.wav` → `/recordings/Panel/`. The job
 * directory keeps its own opaque-id copy for the service's bookkeeping, but
 * that path is unguessable, which is exactly the problem this solves.
 */
export function defaultOutputDir(mediaPath: string): string {
  const resolved = path.resolve(mediaPath);
  return path.join(path.dirname(resolved), path.basename(resolved, path.extname(resolved)));
}
