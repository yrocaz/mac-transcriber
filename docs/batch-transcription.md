# Transcribing an archive

A worked example of tree mode, from the run it was built for: **43 recordings,
33.5 hours of audio, mixed panels and solo segments, on an external drive.**
It finished in 31 minutes.

## TL;DR

```sh
./transcribe "/Volumes/Drive/Recordings" \
  --out ~/Documents/Transcripts \
  --hints hints.txt \
  --no-prompt
```

Re-run the identical command to retry failures — completed files are skipped.

---

## 1. See what you're about to process

```sh
find "/Volumes/Drive/Recordings" -type f \
  \( -iname '*.mp3' -o -iname '*.wav' \) ! -name '._*' | wc -l
```

The `! -name '._*'` is not optional. macOS writes `._Name.wav` AppleDouble
sidecars beside real files on non-HFS volumes (USB drives, SMB shares, SD
cards). They carry a media extension and look exactly like recordings to a
naive filter. The archive above had **21 of them against 43 real files**.

Tree mode excludes them for you; the point of running the count yourself is to
know the number you should see at the end.

Durations, to estimate the run (no ffmpeg needed):

```sh
afinfo "file.wav" | grep 'estimated duration'
```

Budget roughly **60× realtime**, diarization included.

## 2. Write a hints file

Speaker count is the highest-impact quality knob, and one value rarely fits a
whole archive. Group your files by shape, then write one glob per shape:

```
# hints.txt — first match wins, top to bottom
*[Pp]anel*        --speakers 5
*Market Update*   --min-speakers 1 --max-speakers 2
*Intro*           --min-speakers 1 --max-speakers 2
*/RR.wav          --min-speakers 1 --max-speakers 2
*                 --speakers 5
```

Reading order is the whole design: **specific patterns first, a `*` catch-all
last**, like a routing table.

- Globs match the path **relative to the walk root**, so `*/RR.wav` matches
  `Next Deal Edit/RR.wav` — folder-aware rules without naming every folder.
- Supported syntax: `*`, `?`, `[...]` classes. `[Pp]anel` catches both cases.
- **Spaces in globs are fine.** The glob ends at the first flag, not the first
  space, so `*Market Update*` works as written.
- Use a range when you're unsure — `--min-speakers 2 --max-speakers 5` is an
  honest hint; a wrong exact count is worse than an honest range.
- Only `--speakers`, `--min-speakers`, `--max-speakers` are allowed. An
  unknown flag fails the run with the line number rather than being ignored.

Check your rules route correctly **before** committing hours to a run.
`--dry-run` walks the tree, resolves every hint, and stops — seconds, not
hours:

```sh
./transcribe "/Volumes/Drive/Recordings" --hints hints.txt --out ~/Transcripts --dry-run
```

```
  43 media files under /Volumes/Drive/Recordings

    →  2023 Year in Review.mp3                      5 speakers via "*"
    →  24 Year In Review - Edit/Zac.wav             1–2 speakers via "*Intro*"
    →  3rd State of Econ/3rd state of econ - panel.wav   5 speakers via "*[Pp]anel*"
   skip Finding Money Edit/happy birthday.wav       1–2 speakers via "*Intro*"

  would transcribe 42, skip 1 (already done)
```

Read the middle column: that is the count each file will actually be
diarized with. A rule that never appears is a rule that never matched.
`--dry-run --json` emits the same plan machine-readably.

The real run executes this exact plan — `runTree` consumes what `planTree`
produced — so the preview cannot disagree with what happens.

## 3. Run it

```sh
./transcribe "/Volumes/Drive/Recordings" \
  --out ~/Documents/Transcripts \
  --hints hints.txt \
  --no-prompt
```

**Why `--out` on a local disk?** Two reasons. Transcripts are small and you
probably want them backed up with your documents; and if the external drive
disconnects mid-run, you keep everything finished so far. Copy to the drive
afterwards:

```sh
rsync -rtv ~/Documents/Transcripts/ "/Volumes/Drive/Transcripts/"
```

Use `-rtv`, **not** `-a`, when the destination is exFAT — the usual format for
a cross-platform external drive. `-a` tries to preserve ownership and
permissions the filesystem cannot represent, and spews an error per file.

Watch it from another terminal:

```sh
tail -f ~/Documents/Transcripts/_run.log
```

## 4. Read the result

```
  43 media files · 42 transcribed · 0 skipped · 1 failed
  1 recovered from damaged source media

  failed:
    Coliving With Sam Wegger.mp3 — unknown: The operation couldn't be completed.
```

Exit status is non-zero if anything failed, so this composes:

```sh
./transcribe "$SRC" --out "$DST" --hints hints.txt && rsync -rtv "$DST/" "$EXT/"
```

**The check that matters is count in == count out.** Verify against disk, not
against the summary:

```sh
find "$SRC" -type f \( -iname '*.mp3' -o -iname '*.wav' \) ! -name '._*' | wc -l
find "$DST" -name transcript.txt -size +0 | wc -l
```

Also worth a look: requested vs. actual speaker count, which is where a hint
quietly failed to take.

```sh
find "$DST" -name transcript.json -exec python3 -c "
import json,sys
for p in sys.argv[1:]:
    m = json.load(open(p))['metadata']
    print(f\"{m['speakerCount']}  {p}\")
" {} +
```

A panel you hinted at 5 that returns 2 is the documented under-clustering
failure — worth re-running that file with a firmer hint.

## 5. Retry failures

Re-run the same command. Files with a non-empty `transcript.txt` are skipped,
so only failures are attempted:

```sh
./transcribe "$SRC" --out "$DST" --hints hints.txt --no-prompt
```

`--force` reprocesses everything, e.g. after changing a hint.

## Notes

- **Concurrency is 1, deliberately.** Apple's SpeechAnalyzer limits concurrent
  sessions; serializing avoids `insufficientResources` entirely. Running two
  copies of the tool at once reintroduces exactly that failure.
- **Duplicate basenames are safe** under `--out` because the source layout is
  mirrored. Four `Panel.wav` files in four event folders produce four separate
  transcript folders.
- **A run killed mid-write** leaves a zero-byte `transcript.txt`. That counts
  as *not done*, so a resume redoes it rather than skipping a damaged file.

See [troubleshooting.md](troubleshooting.md) when something goes wrong.
