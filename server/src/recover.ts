/**
 * Recovery for damaged source media.
 *
 * Motivating case, from a 43-file archive run: one 56-minute MP3 aborted
 * transcription at *exactly* `progress 0.6227` on two independent attempts —
 * identical to four decimals — with `Foundation._GenericObjCError error 0`.
 * That reproducibility is the tell: a retry re-reads the same damaged frame
 * and dies at the same offset, forever. Re-encoding the file with `afconvert`
 * rewrites the stream and transcribed all 56:09 cleanly.
 *
 * So this module is deliberately *not* a retry. It changes the input before
 * trying again, which is the only thing that helps a deterministic fault.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JobRecord } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Whether a failed job looks like damaged media rather than a configuration
 * or environment problem.
 *
 * `audioReadFailed` means the container or codec never opened. `unknown`
 * strictly between 0 and 1 means decoding started and then aborted partway —
 * the observed signature above; `unknown` is also what `supervisor.ts`
 * assigns to an unexpected helper exit, and a helper that dies mid-file is
 * equally worth re-encoding.
 *
 * `progress === 0` is excluded on purpose. Nothing decoded, so the fault is
 * upstream of the audio data (missing model, bad locale, helper never
 * started), and re-encoding would spend minutes to fail in exactly the same
 * way. Same reasoning for `progress === 1`: the audio was fully read.
 */
export function isLikelyDamagedMedia(job: JobRecord): boolean {
  if (job.status !== "error" || !job.error) return false;
  if (job.error.code === "audioReadFailed") return true;
  return job.error.code === "unknown" && job.progress > 0 && job.progress < 1;
}

/**
 * Re-encodes any supported input to 16-bit mono 44.1kHz WAV via `afconvert`,
 * which ships with macOS — no ffmpeg dependency, and no new package.
 *
 * Mono is intentional: the diarizer downmixes anyway, and it halves a temp
 * file that is already large. Size is worth stating plainly — a 56-minute MP3
 * becomes roughly 300MB of WAV, so callers must clean up. `withReencoded`
 * below does that for you; prefer it to calling this directly.
 */
export async function reencodeToWav(source: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-recover-"));
  // "recovered-" prefix so a stray temp file left by a hard kill is
  // self-explanatory to whoever finds it in $TMPDIR.
  const target = path.join(dir, `recovered-${path.basename(source, path.extname(source))}.wav`);
  try {
    await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "1", source, target]);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`afconvert could not re-encode ${path.basename(source)}: ${detail}`);
  }
  return target;
}

/**
 * Runs `body` against a re-encoded copy of `source`, removing the temp file
 * (and its directory) afterwards no matter how `body` ends. The `finally` is
 * the point: an interrupted batch would otherwise strand hundreds of megabytes
 * per recovered file in the temp directory.
 */
export async function withReencoded<T>(
  source: string,
  body: (wavPath: string) => Promise<T>,
): Promise<T> {
  const wavPath = await reencodeToWav(source);
  try {
    return await body(wavPath);
  } finally {
    fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
  }
}
