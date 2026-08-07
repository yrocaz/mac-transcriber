# Implementation plan — tree mode, recovery, readable errors

Spec: [`../specs/2026-08-07-tree-mode-and-recovery-design.md`](../specs/2026-08-07-tree-mode-and-recovery-design.md)

Each task is test-first: write the failing test, implement, confirm green.
Tasks 1–4 are independent leaves; 5 depends on 2; 6 depends on all.

## 1. `formatJobError` → `cliRender.ts`

- Test: populated `JobError` renders `"code: message"`; `null` renders
  `"job did not complete"`.
- Implement, then swap in at `cli.ts:301`.
- **Done when:** a failing job prints a real message instead of `[object Object]`.

## 2. `recover.ts`

- Test `isLikelyDamagedMedia`: `audioReadFailed` → true; `unknown` @ 0.62 →
  true; `unknown` @ 0 → false; `unknown` @ 1 → false;
  `cannotAllocateUnsupportedLocale` → false; non-error job → false.
- Test `reencodeToWav`: writes to `os.tmpdir()`, returns the path, removes it
  on cleanup; surfaces a clear error when `afconvert` exits non-zero.
- **Done when:** classification matches the spec table and temp files never leak.

## 3. `hints.ts`

- Test `globToRegExp`: `*`, `?`, `[Pp]`, literal dots, anchoring.
- Test `parseHints`: comments, blank lines, malformed lines rejected with line
  numbers, non-speaker flags rejected.
- Test `matchHint`: first match wins; no match → null.
- **Done when:** the spec's example `hints.txt` parses and routes each archive
  filename to the expected flags.

## 4. `tree.ts`

- Test `walkMediaTree`: extension filter, **`._*` exclusion**, nested dirs,
  sorted output, dotfile/dot-dir exclusion, empty dir → `[]`.
- Test `mirroredOutputDir`: the four-`Panel.wav` case yields four distinct
  dirs; relative nesting preserved.
- **Done when:** walking a fixture tree with AppleDouble sidecars returns only
  real media.

## 5. `runFile.ts` — `transcribeOne`

Depends on task 2.

- Extract the existing single-file lifecycle from `cli.ts:264-330` verbatim
  first; confirm the CLI still passes its tests unchanged.
- Then add the recovery branch: on failure, if `isLikelyDamagedMedia`,
  re-encode and re-run once against the temp file, forcing `metadata.source`
  back to the original path and appending a warning.
- Test with a fake helper that fails once then succeeds: exactly one re-encode,
  `source` is the original, temp removed, warning present.
- **Done when:** a deliberately damaged fixture transcribes end to end.

## 6. `cli.ts` — dispatch, flags, logging, summary

Depends on 1–5.

- New flags: `--hints <file>`, `--force`. Usage text updated.
- Dispatch: directory input → tree mode; file input → existing path.
- Tree loop: walk, resolve hints per file, skip when `transcript.txt` is
  non-empty unless `--force`, run via `transcribeOne`, catch per file.
- `_run.log` in the output root (input root when `--out` is omitted).
- Summary to stderr; `--json` emits it as JSON to stdout.
- Exit 1 if any file failed.
- Test: skip-existing, `--force`, failure isolation, exit code, log contents.
- **Done when:** `transcribe <dir> --hints h.txt --out <o>` reproduces what the
  bash driver did.

## 7. Docs

- `README.md`: tree mode section with a worked example, hints file reference,
  recovery behavior, `--force`/`--hints` in the options table.
- `docs/batch-transcription.md`: new task-shaped guide — transcribing an
  archive, writing a hints file, resuming, reading the summary.
- `docs/troubleshooting.md`: new — `[object Object]` (now fixed), damaged media
  and what recovery does, AppleDouble files, duplicate basenames, where
  `_run.log` and `data/jobs/<id>/job.json` live.
- Inline comments at each non-obvious decision, matching house style: say *why*,
  cite the evidence.

## 8. Verify

- `npm run typecheck && npm test` green.
- Rebuild, then a real tree run against a small fixture directory.
- Confirm the CLI's single-file behavior is byte-identical to before.
