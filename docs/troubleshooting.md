# Troubleshooting

Symptom first. Every entry here comes from something that actually happened.

## Where to look

| What | Where |
|---|---|
| Per-file batch history | `<out>/_run.log` (or `<input>/_run.log` without `--out`) |
| Full record of one job | `data/jobs/<id>/job.json` — status, error, progress, `stderrTail` |
| What the transcript claims | `<out>/<name>/transcript.json` → `metadata` |
| Uncertain passages | `<out>/<name>/review.md` |

The single most useful field when a job fails is `progress` in `job.json`: it
tells you *how far it got*, which separates "never started" from "died
partway".

---

## A file fails at the same point every time

```
error: unknown: The operation couldn't be completed.
       (Foundation._GenericObjCError error 0.)
```

Check `progress` across two attempts. **Identical values mean damaged media**,
not a transient fault — a damaged frame is read at the same offset every run.
Real example: two attempts both stopped at `progress 0.6227`, matching to four
decimals, ~34:55 into a 56-minute MP3.

The tool now handles this automatically: it re-encodes with `afconvert` and
retries once, emitting

```
warning: recoveredByReencode: Source media failed at 62.3% (unknown);
         transcribed from an afconvert WAV re-encode.
```

To do it by hand — for an unsupported container, say:

```sh
afconvert -f WAVE -d LEI16@44100 -c 1 broken.mp3 /tmp/fixed.wav
./transcribe /tmp/fixed.wav --speakers 5 --out ./output
```

If you do this manually, note that the transcript will record `/tmp/fixed.wav`
as its source and title. Fix `metadata.source` in `transcript.json` and the
first line of `transcript.txt`, or the transcript ends up naming a temp file
you're about to delete.

**A 56-minute MP3 becomes ~300MB of WAV.** Automatic recovery cleans up after
itself; manual conversions are yours to remove.

### It fails at progress 0

Not damaged media — nothing was decoded. Look upstream: missing model, an
unsupported `--locale`, a helper that never started. Re-encoding won't help,
which is why recovery deliberately skips this case.

## `error: [object Object]`

Fixed. If you see it, you're on a build before the fix — rebuild:

```sh
cd server && npm run build
```

The real message was always in `data/jobs/<id>/job.json` under `error`.

## A batch reported more files than I have

Almost certainly `._*` AppleDouble sidecars. macOS writes them beside real
files on non-HFS volumes (USB, SMB, SD cards); they carry the same extension
as the file they shadow. One archive had 21 against 43 real recordings.

Tree mode skips them. A hand-rolled `find` needs `! -name '._*'`.

```sh
find . -name '._*' | wc -l      # count them
dot_clean .                      # merge and remove them (macOS built-in)
```

## Transcripts are missing and no error was reported

Check for **duplicate basenames**. `--out` on a *single file* writes the four
transcript files flat into that directory, so two runs pointed at the same
`--out` silently overwrite:

```sh
find . -name '*.wav' -exec basename {} \; | sort | uniq -d
```

Tree mode mirrors the source layout under `--out` specifically to prevent this.
If you're scripting single-file runs, give each one its own output directory.

Verify by content, not by count — identical sizes across folders is the tell:

```sh
find "$DST" -name transcript.txt -exec md5 -q {} \; | sort | uniq -d
```

## A panel came back with too few speakers

Expected without a hint: automatic clustering under-clusters multi-party audio.
A measured 5-person panel returned **3 speakers**, one cluster absorbing 27 of
41 talking minutes.

```sh
./transcribe Panel.wav --speakers 5
```

If it still under-clusters with an exact count, the recording likely has one
speaker on a markedly different mic or volume. A range sometimes does better
than a wrong exact value:

```sh
./transcribe Panel.wav --min-speakers 4 --max-speakers 6
```

Diarization returning **fewer** speakers than `--min-speakers` is possible —
the hint guides clustering, it does not constrain the output.

## Hints file isn't matching

- Globs match the path **relative to the walk root**, not the absolute path
  and not the bare filename. `*/RR.wav` matches `Next Deal Edit/RR.wav`;
  `RR.wav` alone matches only a file at the root.
- **First match wins.** A leading `*` catch-all swallows everything below it.
- Patterns are anchored: `Panel` does *not* match `Panel + QA.wav`. Use
  `*Panel*`.
- Spaces in globs are fine — the glob ends at the first flag.

Print what each file resolved to, without transcribing anything:

```sh
./transcribe "$SRC" --hints hints.txt --out "$DST" --dry-run
```

The middle column is the speaker count that file will actually get. A rule
that never appears never matched.

## The run stopped partway

Just re-run the same command. Completed files are skipped, so it resumes where
it left off. `_run.log` is appended to, not truncated, so the earlier history
survives.

A zero-byte `transcript.txt` from a kill mid-write counts as *not done* and
gets redone.

## `insufficientResources`

Apple limits concurrent SpeechAnalyzer sessions. The queue runs at concurrency
1 to avoid this — so if you see it, something else is competing: a second copy
of the tool, or another app using SpeechAnalyzer. Run one at a time.

## rsync errors copying to an external drive

```
rsync: chgrp "..." failed: Operation not permitted (1)
```

The drive is exFAT and has no ownership model. Use `-rtv`, not `-a`:

```sh
rsync -rtv ~/Documents/Transcripts/ "/Volumes/Drive/Transcripts/"
```

## Checking a finished batch

Count in must equal count out:

```sh
find "$SRC" -type f \( -iname '*.mp3' -o -iname '*.wav' \) ! -name '._*' | wc -l
find "$DST" -name transcript.txt -size +0 | wc -l
```

Then the things a count won't catch — empty transcripts, failed diarization,
and hints that didn't take:

```sh
find "$DST" -name transcript.json -exec python3 -c "
import json,sys
for p in sys.argv[1:]:
    d = json.load(open(p)); m = d['metadata']
    flag = '  <-- check' if not d['segments'] or m['diarization'] != 'ok' else ''
    print(f\"{m['speakerCount']}  {len(d['segments']):>5} segs  {p}{flag}\")
" {} +
```
