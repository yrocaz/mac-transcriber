# Tree mode, damaged-media recovery, and readable job errors

**Status:** approved · **Date:** 2026-08-07

## Why

Transcribing a 43-file, 33.5-hour meetup archive exposed three gaps. Each item
below is grounded in something that actually happened during that run, not in
anticipated need.

| # | Gap | Evidence from the archive run |
|---|---|---|
| 1 | Job errors print as `[object Object]` | `cli.ts:301` interpolates a `JobError` object into a template string. Diagnosing the one failure meant reading `data/jobs/<id>/job.json` by hand. |
| 2 | A damaged source frame aborts the whole file | One MP3 aborted at exactly `progress 0.6227` on two independent attempts. An `afconvert` re-encode transcribed all 56:09 cleanly. |
| 3 | No way to transcribe a directory | The run needed a 60-line bash driver to walk the tree, mirror output paths, skip completed files, and isolate failures. |

**Explicitly rejected: automatic retry of transient failures.** It was
considered and dropped. Across 43 files and 33.5 hours there were zero
transient failures, and `queue.ts` already runs at concurrency 1 specifically
to prevent `insufficientResources` — the failure mode a retry would target.
Retrying the one real failure would have burned three attempts on a
deterministic fault. If a genuine transient failure is ever observed, item 1
is what will make it identifiable.

## 1. Readable job errors

`formatJobError(error: JobError | null): string` in `cliRender.ts`, beside the
other rendering helpers. Returns `"<code>: <message>"`, or
`"job did not complete"` for null. `cli.ts:301` uses it. `cli.ts:339` already
handles `Error` correctly and is unchanged.

## 2. Damaged-media recovery

New module `server/src/recover.ts`.

### When it triggers

`isLikelyDamagedMedia(job)` returns true when a failed job matches either:

- `error.code === "audioReadFailed"` — the container or codec would not open.
- `error.code === "unknown"` **and** `0 < progress < 1` — decoding began and
  then aborted partway. This is the observed signature: a `_GenericObjCError`
  at a reproducible offset.

`progress === 0` is deliberately excluded. A failure before any audio was
decoded is a startup or configuration problem, and re-encoding a file that
never opened just spends minutes to fail identically.

### What it does

Re-encode with the macOS built-in `afconvert`:

```
afconvert -f WAVE -d LEI16@44100 -c 1 <source> <temp>.wav
```

Then run the job **once** more against the temp file. Strictly one attempt —
no loop. On success or failure the temp file is removed in a `finally`.

### Constraints learned the hard way

- **Provenance points at the original.** The recovered transcript's
  `metadata.source` must be the original media path, never the temp file.
  During manual recovery the transcript recorded a scratch path that was
  deleted moments later, leaving a transcript describing a file that no longer
  existed.
- **Temp space is not free.** A 56-minute MP3 became a 297MB WAV. Temp files
  go in `os.tmpdir()` and are cleaned up even when the run throws, so an
  interrupted batch cannot strand gigabytes.
- **A `warnings` entry records the re-encode**, so a recovered transcript is
  self-describing rather than silently different from its siblings.

## 3. Tree mode

`transcribe <dir>` walks the directory recursively. `transcribe <file>` is
unchanged.

### Walking

`walkMediaTree(root)` in `server/src/tree.ts` returns absolute paths, sorted,
filtered to `SUPPORTED_EXTENSIONS`, excluding:

- **`._*` AppleDouble sidecars.** Non-negotiable: the archive contained 21 of
  them. They carry media extensions and a naive walk reports 21 failures.
- Dotfiles and dot-directories.

Sorted order makes an interrupted run resume predictably.

### Output layout

With `--out <root>`, output mirrors the source tree:

```
Recordings/Next Deal Edit/Panel.wav  →  <root>/Next Deal Edit/Panel/
```

`mirroredOutputDir(inputRoot, mediaPath, outRoot)` computes this. The mirror is
load-bearing, not cosmetic: the archive had `Panel.wav` in four different event
folders and `RR.wav` in two. Flattening silently overwrites, producing 36 files
from 43 inputs with no error.

Without `--out`, each file's transcripts land beside it — today's single-file
default, applied per file.

### Per-file speaker hints

`--hints <file>`. One rule per line, `<glob>` whitespace `<flags>`, `#`
comments, blank lines ignored. **First match wins.**

```
# hints.txt
*[Pp]anel*        --speakers 5
*Market Update*   --min-speakers 1 --max-speakers 2
*Intro*           --min-speakers 1 --max-speakers 2
*/RR.wav          --min-speakers 1 --max-speakers 2
*                 --speakers 5
```

Globs match the path **relative to the input root**, so rules can be
folder-aware. Supported syntax is `*`, `?`, and `[...]` character classes,
converted to a `RegExp` by a local `globToRegExp` — no dependency, and no
reliance on the experimental `path.matchesGlob`. A file matching no rule falls
back to the CLI's own `--speakers`/`--min-speakers`/`--max-speakers`.

Only speaker flags are accepted in a rules file. Allowing `--out` or `--locale`
per rule invites conflicts with the mirrored layout for no known use case.

### Resume, isolation, logging

- **Skip** any file whose output already has a non-empty `transcript.txt`.
  `--force` reprocesses everything.
- **Failure isolation:** one file failing never stops the run. Exit code is 1
  if any file failed, 0 otherwise.
- **`_run.log`** in the output root (or the input root when `--out` is
  omitted): timestamped `start` / `done` / `skip` / `fail` lines.
- **Summary** on stderr at the end: total, done, skipped, failed, recovered,
  plus the failing paths. `--json` emits the same summary as JSON on stdout.
  Printed regardless of whether stderr is a TTY — a scripted batch run is the
  primary use case, and the summary is its deliverable; only the live progress
  bar requires a terminal.
- **`--dry-run`** resolves the whole plan — which files, which hint rule each
  matched, where output would go — and stops. `planTree` produces the plan and
  `runTree` consumes it, so a preview cannot drift from the real run. Without
  this, checking a hints file means starting a multi-hour run to discover that
  rule 3 never matched.

### Concurrency

Unchanged at 1, reusing the existing queue semantics. That serialization is
what keeps `insufficientResources` from occurring.

## Module boundaries

| Module | Responsibility |
|---|---|
| `cliRender.ts` | + `formatJobError` |
| `recover.ts` | `isLikelyDamagedMedia`, `reencodeToWav` |
| `hints.ts` | `parseHints`, `matchHint`, `globToRegExp` |
| `tree.ts` | `walkMediaTree`, `mirroredOutputDir` |
| `runFile.ts` | `transcribeOne` — one file end to end, incl. recovery |
| `cli.ts` | arg parsing, single-vs-tree dispatch, logging, summary |

`runFile.ts` exists so `cli.ts` does not grow a second copy of the job
lifecycle for tree mode. Both paths run the identical code.

## Testing

- `formatJobError`: populated error, null error.
- `globToRegExp` / `parseHints`: `*`, `?`, `[Pp]`, comments, blanks, malformed
  lines, first-match-wins, no-match fallback.
- `walkMediaTree`: extension filter, **`._*` exclusion**, nesting, sort order,
  dotfile exclusion.
- `mirroredOutputDir`: the four-`Panel.wav` collision case yields four distinct
  directories.
- `isLikelyDamagedMedia`: `audioReadFailed` → true; `unknown` at 0.62 → true;
  `unknown` at 0 → false; `cannotAllocateUnsupportedLocale` → false.
- Recovery with a fake helper that fails once then succeeds: asserts one
  re-encode, `metadata.source` is the original, temp file removed, warning
  present.
- Tree run: skip-existing, `--force`, failure isolation, `_run.log` contents.
- `main()` boundary: exit 0 all-success, 1 any-failure, 2 malformed hints (and
  nothing transcribed), 2 missing path; summary printed on a non-TTY stderr.
  `TreeSummary.failed` is not the same assertion as the process exit code, and
  only the latter is what `transcribe dir/ && next-step` depends on.
- `--dry-run`: transcribes nothing, exits 0, reports the matched glob per file,
  marks already-done files as skip, and emits the plan as JSON under `--json`.

## Out of scope

Retry of transient failures (rejected above); parallelism; resume from partial
progress; hint rules beyond globs; recovery formats other than WAV.
