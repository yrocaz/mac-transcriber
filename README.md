# mac-transcriber

Local-first media transcription for macOS. Point it at a video or audio file
on disk and get back a structured, punctuated transcript with anonymous
speaker labels (`S1`, `S2`, …) — powered entirely by Apple's on-device
[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer)
for transcription and [FluidAudio](https://github.com/FluidInference/FluidAudio)
for speaker diarization. Nothing leaves the machine except a one-time model
download.

The transcript schema is designed as the input to a future "turn this into
a blog article/guide" step (not built here) — a flat, clean `text` field for
prose quality, plus timestamped `segments` for citing the source media.

> **Status:** a personal project, shared in case it's useful. It works and it's
> tested, but it's built for one person's workflow on one Mac. No support,
> roadmap, or backwards-compatibility promises. Issues and forks welcome.

## Quick start

```sh
git clone https://github.com/yrocaz/mac-transcriber.git
cd mac-transcriber
./transcribe /path/to/recording.wav
```

The wrapper builds both components on first run, then asks how many speakers
are in the recording (answer it — see below), shows a live progress bar, and
writes the transcript to a folder beside your media file:

```
recordings/
├── Panel.wav
└── Panel/
    ├── transcript.txt    ← readable, speaker-labelled prose
    ├── transcript.json   ← timestamped segments + metadata
    └── transcript.srt    ← subtitles
```

Roughly **60× realtime** on Apple silicon: a 43-minute recording finishes in
about 45 seconds.

### Tell it how many speakers there are

This is the single highest-impact thing you can do for transcript quality.
Automatic clustering under-clusters real multi-party audio: a measured
5-person panel came back as **3 speakers**, with one merged cluster absorbing
27 of its 41 talking minutes. Supplying the count fixes it.

```sh
./transcribe Panel.wav --speakers 5              # exact count, when known
./transcribe Panel.wav --min-speakers 3 --max-speakers 6   # a range
./transcribe Panel.wav --no-diarize              # skip speakers entirely, faster
```

Run `./transcribe --help` for the rest. Interactive runs prompt for the count;
piped or scripted runs never block, and `--no-prompt` disables the question.

The HTTP API takes the same hints as `speakers` / `minSpeakers` /
`maxSpeakers` on `POST /jobs`.

## What it is

Two components in one repo:

- **`helper/`** — a Swift command-line tool (`speech-helper`) that opens a
  media file, transcribes its audio via SpeechAnalyzer, diarizes speakers
  via FluidAudio, and streams NDJSON progress/result events on stdout.
- **`server/`** — a TypeScript/Fastify HTTP API (Node 22+) that accepts
  transcription jobs, spawns `speech-helper` per job, supervises it (three
  independent timeouts, stderr capture, restart recovery), assembles the
  final transcript (merging diarization onto sentence segments by maximum
  time overlap), and serves it back as JSON or SRT.

No database — job records live as JSON files under `data/jobs/<id>/`. No
authentication — the API binds to `127.0.0.1` only and is meant to run
alongside you on your own Mac, not be exposed to a network.

Full design rationale, API contract, and the research this was built from:

- [Design spec](docs/superpowers/specs/2026-07-27-media-transcriber-design.md)
- [Apple SpeechAnalyzer research](docs/research/2026-07-27-apple-speechanalyzer-docs.md)
- [FluidAudio evaluation notes](docs/research/2026-07-27-fluidaudio-notes.md)
- [GitHub OSS ecosystem research](docs/research/2026-07-27-github-oss-research.md)
- [Verification spikes](docs/research/spikes/README.md)

## Requirements

- **macOS 26+** — SpeechAnalyzer is a macOS 26 system framework; there is no
  Linux/Docker path, by design (verified against macOS 26.5.2 on this
  machine).
- **Xcode or Xcode Command Line Tools with a Swift 6.2+ toolchain**, on the
  macOS 26 SDK. Verified on this machine with Command Line Tools alone
  (`xcode-select -p` → `/Library/Developer/CommandLineTools`), `swift-driver
  version: 1.148.6`, `Apple Swift version 6.3.3`. See
  [Development notes](#development-notes) below for a caveat if your Mac
  also has a full Xcode.app installed.
- **Node.js 22+** (verified with Node 25.9.0 / npm 11.12.1 here — anything
  ≥22 per `server/package.json`'s `engines` field should work).
- Network access **once**, the first time diarization runs on a fresh
  machine (FluidAudio's CoreML models download from HuggingFace; fully
  offline afterward). SpeechAnalyzer's own language models are managed by
  the OS and download automatically as needed the first time a locale is
  used.

## Build

```bash
# 1. Swift helper (release build; ~68s clean, seconds when cached)
cd helper
swift build -c release
# Build complete! (67.73s)

# 2. TypeScript server
cd ../server
npm install
npm run build   # tsc -p tsconfig.json
```

The helper binary lands at `helper/.build/release/speech-helper`; the
server's compiled output at `server/dist/`. The server locates the helper
binary at that default path automatically (override with
`TRANSCRIBER_HELPER_PATH` — see [Configuration](#configuration)).

Verify the helper on its own before wiring up the server:

```bash
$ helper/.build/release/speech-helper status
{"available":true,"installedLocales":["en-AU","en-CA","en-GB","en-IE","en-IN","en-NZ","en-SG","en-US","en-ZA"],"supportedLocales":["de-AT","de-CH","de-DE","en-AU","en-CA","en-GB","en-IE","en-IN","en-NZ","en-SG","en-US","en-ZA","es-CL","es-ES","es-MX","es-US","fr-BE","fr-CA","fr-CH","fr-FR","it-CH","it-IT","ja-JP","ko-KR","pt-BR","pt-PT","yue-CN","zh-CN","zh-HK","zh-TW"]}
```

## Run

```bash
cd server
npm run build && npm start   # node dist/index.js
# or, for development (no build step, TS run directly via tsx):
npm run dev
```

```
$ npm start
media-transcriber server listening on http://127.0.0.1:4173
```

The server binds `127.0.0.1` only — never `0.0.0.0` — and that binding is
hardcoded, not configurable, since the API has no authentication of its
own. Confirmed on this machine:

```
$ lsof -nP -iTCP:4173 -sTCP:LISTEN
COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    84589 studio   12u  IPv4 0xe32a4db2d71c03b5      0t0  TCP 127.0.0.1:4173 (LISTEN)
```

### Configuration

All optional, read from the environment at startup (`server/src/config.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | HTTP port (loopback only) |
| `TRANSCRIBER_DATA_DIR` | `<repo>/data` | Where `jobs/<id>/{job.json,transcript.json,transcript.srt}` are written |
| `TRANSCRIBER_HELPER_PATH` | `<repo>/helper/.build/release/speech-helper` | Path to the helper binary |

## API

Base URL: `http://127.0.0.1:4173` (use `127.0.0.1` literally — the server
does not bind `::1`/`localhost`'s IPv6 resolution).

### `POST /jobs` — submit a job

Body: `{ "path": "<local file path>", "locale"?: "en-US", "diarize"?: true }`.
`diarize` defaults to `true`; both `transcript.json` and `transcript.srt`
are always produced.

```
$ curl -sS -i -X POST http://127.0.0.1:4173/jobs \
    -H 'Content-Type: application/json' \
    -d '{"path":"/Users/you/media-transcriber/test-fixtures/speech-short.aiff"}'
HTTP/1.1 202 Accepted
content-type: application/json; charset=utf-8

{"id":"5nsnpxn90pj3","status":"queued"}
```

Validation errors return `400` before any job is created:

```
$ curl -sS -i -X POST http://127.0.0.1:4173/jobs -H 'Content-Type: application/json' \
    -d '{"path":"/nonexistent/file.mp3"}'
HTTP/1.1 400 Bad Request
{"error":"File does not exist: /nonexistent/file.mp3"}

$ curl -sS -i -X POST http://127.0.0.1:4173/jobs -H 'Content-Type: application/json' \
    -d '{"path":"/etc/hosts"}'
HTTP/1.1 400 Bad Request
{"error":"Unsupported file extension \"(none)\". Supported: mp4, mov, m4v, mp3, m4a, wav, aiff, aif, caf"}
```

### `GET /jobs/:id` — poll status

```
$ curl -sS http://127.0.0.1:4173/jobs/5nsnpxn90pj3
{"id":"5nsnpxn90pj3","path":"/Users/you/media-transcriber/test-fixtures/speech-short.aiff","locale":"en-US","diarize":true,"status":"done","progress":1,"warnings":[],"error":null,"timings":{"createdAt":"2026-08-04T12:44:25.373Z","startedAt":"2026-08-04T12:44:25.373Z","finishedAt":"2026-08-04T12:44:26.304Z"},"durationSec":6.571}
```

`status` is one of `queued` / `running` / `done` / `error`. There is no
push/SSE channel — poll this endpoint (by design, YAGNI for a
single-machine tool).

### `GET /jobs` — list jobs, newest first

```
$ curl -sS http://127.0.0.1:4173/jobs
[{"id":"5nsnpxn90pj3","path":"...","status":"done", ...}]
```

### `GET /jobs/:id/transcript.json` — structured transcript

```
$ curl -sS http://127.0.0.1:4173/jobs/5nsnpxn90pj3/transcript.json
{"metadata":{"source":"/Users/you/media-transcriber/test-fixtures/speech-short.aiff","durationSec":6.571,"locale":"en-US","engine":"apple-speechanalyzer","diarization":"ok","speakerCount":1,"createdAt":"2026-08-04T12:44:25.373Z"},"text":"The quick brown fox jumps over the lazy dog. Apple's speech analyzer runs entirely on device.","segments":[{"id":0,"start":0,"end":2.88,"text":"The quick brown fox jumps over the lazy dog.","speaker":"S1"},{"id":1,"start":2.94,"end":6.571,"text":"Apple's speech analyzer runs entirely on device.","speaker":"S1"}]}
```

A two-speaker interview (`test-fixtures/two-voice-interview.wav`) produces
`speakerCount: 2` and alternating `S1`/`S2` labels by maximum time overlap
between each sentence and the diarizer's speaker turns:

```json
{
  "metadata": { "diarization": "ok", "speakerCount": 2, "durationSec": 41.698, "...": "..." },
  "segments": [
    { "id": 0, "start": 0,    "end": 1.5,  "text": "Thanks for joining me today.", "speaker": "S1" },
    { "id": 2, "start": 5.82, "end": 6.96, "text": "Sure.", "speaker": "S2" }
  ]
}
```

404 if the job doesn't exist or hasn't reached `done` yet.

### `GET /jobs/:id/transcript.srt` — subtitles

```
$ curl -sS http://127.0.0.1:4173/jobs/5nsnpxn90pj3/transcript.srt
1
00:00:00,000 --> 00:00:02,880
The quick brown fox jumps over the lazy dog.

2
00:00:02,940 --> 00:00:06,571
Apple's speech analyzer runs entirely on device.
```

`Content-Type: text/plain; charset=utf-8`. Same 404 rules as above.

### `GET /health`

```
$ curl -sS http://127.0.0.1:4173/health
{"status":"ok","helper":{"available":true,"supportedLocales":["de-AT","de-CH","de-DE","en-AU","en-CA","en-GB","en-IE","en-IN","en-NZ","en-SG","en-US","en-ZA","es-CL","es-ES","es-MX","es-US","fr-BE","fr-CA","fr-CH","fr-FR","it-CH","it-IT","ja-JP","ko-KR","pt-BR","pt-PT","yue-CN","zh-CN","zh-HK","zh-TW"],"installedLocales":["en-AU","en-CA","en-GB","en-IE","en-IN","en-NZ","en-SG","en-US","en-ZA"]}}
```

Always returns `200`; `status` is `"degraded"` (with `helper: null`) if the
binary is missing, not executable, or its `status` subcommand fails —
never a `503`.

## Output format

`transcript.json` (spec-designed for a future article-generation step):

```jsonc
{
  "metadata": {
    "source": "/path/to/input",
    "durationSec": 41.698,
    "locale": "en-US",
    "engine": "apple-speechanalyzer",
    "diarization": "ok",        // "ok" | "failed" | "disabled"
    "speakerCount": 2,          // null unless diarization == "ok"
    "createdAt": "2026-08-04T12:44:25.373Z"
  },
  "text": "Full transcript as clean, punctuated prose...",
  "segments": [
    { "id": 0, "start": 0.0, "end": 1.5, "text": "Sentence-level segment.", "speaker": "S1" }
  ]
}
```

`speaker` is an anonymous id (`S1`, `S2`, …, ordered by first appearance)
when diarization succeeds, `null` when it's disabled or failed —
`metadata.diarization` says which. `diarization: "failed"` (e.g. music with
no detectable speech) is not an error: the job still completes, the
transcript is delivered (possibly empty), and the reason lands in the job's
`warnings[]`.

Supported input extensions: `mp4 mov m4v mp3 m4a wav aiff aif caf`. Video
containers work directly through `AVAudioFile` on macOS 26 — no ffmpeg.
`mkv`/`webm`/`ogg` are out of scope (unsupported by AVFoundation).

## Testing

Two separate suites, matching the spec's split between fast fake-helper
unit tests and a real, slower end-to-end suite:

```bash
cd server
npm test          # unit suite: fake helper, no real Swift binary, no network
npm run test:e2e  # E2E suite: real speech-helper, real media, macOS only
```

**Before running `npm run test:e2e` on a fresh clone, generate the required
fixtures first:**

```bash
./scripts/make-fixtures.sh
```

This is a required prerequisite, not an optional extra — `test-fixtures/malformed.mp3`
(and its `.json` sidecar) are gitignored and only exist after running this
script. Without them, the MP3-repair E2E case (`malformed MP3 fixture: the
tail-probe/repair path produces a correct transcript`) silently skips rather
than failing loudly, and it is the *only* coverage of `AudioPreparer.swift`'s
tail-probe/repair branch — the same branch whose ~90s
`AVAssetExportSession` cost drove the startup timeout from 60s to 180s (see
[Development notes](#development-notes)). Skipping it means that regression
has no test coverage at all. See [Fixtures](#fixtures) below for what else
the script generates and why the malformed MP3 isn't committed.

```
$ npm test
 ✓ test/unit/progress.test.ts (7 tests)
 ✓ test/unit/config.test.ts (3 tests)
 ✓ test/unit/transcript.test.ts (25 tests)
 ✓ test/unit/jobStore.test.ts (6 tests)
 ✓ test/unit/routes.test.ts (23 tests)
 ✓ test/unit/supervisor.test.ts (14 tests)
 Test Files  6 passed (6)
      Tests  78 passed (78)
```

`npm run test:e2e` builds `speech-helper` automatically if the release
binary is missing, and skips cleanly (with a console warning, exit 0) on
non-macOS or if the Swift toolchain/build isn't available. It runs a
warm-up job first so a first-run FluidAudio model download (from
HuggingFace, one-time, network required) lands there rather than inside a
timed test:

```
$ npm run test:e2e
[e2e] Warm-up run (first-run model download can take a while; subsequent runs are fast)...
[e2e] Warm-up job ... finished with status done.
 ✓ test/e2e/e2e.test.ts (6 tests) 96925ms
   ✓ single-voice fixture: POST -> poll -> transcript text matches known content
   ✓ two-voice fixture: speakerCount is 2 and segments carry S1/S2
   ✓ sample-5s.mp4 (music, no speech): completes done with an empty transcript and a diarization warning
   ✓ transcript.srt route returns well-formed SRT
   ✓ malformed MP3 fixture: the tail-probe/repair path produces a correct transcript
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### Fixtures

`test-fixtures/` (repo root):

| File | Source | Committed? |
|---|---|---|
| `speech-short.aiff` | `say`-generated, single voice | yes |
| `two-voice-interview.wav` | `say`-generated, two alternating voices (Samantha/Daniel) | yes |
| `sample-5s.mp4` | downloaded from [samplelib.com](https://samplelib.com/sample-mp4.html) (music, no speech — verifies container handling) | yes |
| `malformed.mp3` | generated locally from a macOS system resource (see below) | **no** |
| `malformed.mp3.json` | sidecar: the fixture's true/declared duration (see below) | **no** |

`scripts/make-fixtures.sh` regenerates the `say`-based fixtures and the
malformed MP3:

```bash
./scripts/make-fixtures.sh
```

It does **not** touch `sample-5s.mp4` (external, re-download manually if
ever lost) and, per the note in the script, a full re-run of the `say`
fixtures produces functionally-equivalent but not byte-identical audio
(SpeechAnalyzer's exact segmentation/punctuation can shift very slightly
across macOS/model versions) — verified while writing it, documented
inline, and the E2E suite's assertions are written to tolerate it.

**The malformed-MP3 fixture** exercises a real, previously-unverified code
path: `AudioPreparer.swift`'s tail-probe/repair branch (an MP3 that
misreports its packet count triggers a re-export to a temp M4A via
`AVAssetExportSession`). This was a carried gap from Task 1 — no MP3
encoder was available to construct one. It's now built by taking a real,
well-formed MP3 macOS ships as a system voice-enrollment prompt
(`PersonalAudio.framework`) and prepending one synthetic MPEG frame with a
lying `Xing`/VBR header (correct frame syntax, inflated frame-count field).
It's **not committed to git** — the output is ~99.9% byte-identical to
Apple's shipped audio resource, which isn't ours to redistribute — so it
only exists after running `scripts/make-fixtures.sh`, and the E2E case that
needs it skips with a clear message (naming the script) if it's absent.

The script also writes `malformed.mp3.json`, a small sidecar recording the
fixture's true (real, decodable) and declared (Xing-header lie) durations
in seconds — e.g. `{"trueDurationSec": 32.731, "declaredDurationSec":
130.926, ...}`. The E2E test reads this rather than asserting against a
hardcoded number, so the assertion states the actual invariant ("repair
recovers a duration near the true value, far below the declared one") and
keeps working if the script's frame-count math or the source system MP3
changes on a future macOS. Both files are written atomically (temp path +
`mv`) and regenerated together — the E2E case treats either one missing
as "fixture not ready" and skips.

## Development notes

- **Command Line Tools only, no Xcode.app, on this machine.** `xcode-select -p`
  → `/Library/Developer/CommandLineTools`; `xcodebuild -version` fails with
  "requires Xcode, but active developer directory ... is a command line
  tools instance". `swift build -c release` works fine on this toolchain. If
  you switch toolchains (e.g. install a full Xcode.app), re-verify it still
  picks up the macOS 26 SDK (`.macOS(.v26)` in `helper/Package.swift`
  requires it).
- **Run Swift tests via `helper/scripts/swift-test.sh`, not bare `swift test`.**
  On this Command Line Tools-only toolchain, `swift-testing` (`import Testing`,
  used by `helper/Tests/speech-helperTests/`) needs help in two independent
  ways, both fixed, one at the manifest level and one at the invocation
  level:
  - *Compiling and linking* (`helper/Package.swift`): `Testing.framework`
    isn't on the default search/runtime-load path outside a full Xcode.app
    install. `swift build`/bare `swift test` used to fail to even compile
    the test target (`no such module 'Testing'`). `Package.swift` now
    probes `DEVELOPER_DIR`/the fixed Command Line Tools path at manifest
    evaluation time and, if `Testing.framework` is found there, bakes a
    framework search path and rpath into the test target's build settings
    (`swiftSettings`/`linkerSettings`) — this makes the target compile,
    link, and (if invoked directly) run correctly.
  - *Actually running the suite*: even with the manifest fix, **bare
    `swift test` on this toolchain silently does nothing** — confirmed by
    temporarily adding a deliberately-failing test and running bare
    `swift test`: exit 0, zero output, even with a guaranteed failure
    present. That's not a display quirk (a quirk can't turn a failing test
    into a clean exit) — SwiftPM's own decision to invoke the test runner
    apparently keys off top-level `-Xswiftc`/`-Xlinker` CLI flags, not a
    target's own build settings, so without those flags on `swift test`'s
    own command line it skips running the suite entirely, silently. Passing
    the same search-path flags directly on `swift test`'s CLI (rather than
    only via the manifest) makes it run correctly, with proper pass/fail
    reporting and exit codes. `helper/scripts/swift-test.sh` does exactly
    that (same directory-probing logic as the manifest); run it instead of
    bare `swift test`:
    ```
    $ helper/scripts/swift-test.sh
    ...
    ✔ Test run with 8 tests in 2 suites passed after 0.004 seconds.
    ```
  This is a SwiftPM/toolchain limitation on a Command Line Tools-only
  install, not a code defect, and the wrapper degrades to a thin `swift
  test` passthrough on a toolchain where the framework is already found
  normally (e.g. a full Xcode.app install) — see the wrapper script's header
  comment for the full writeup.
- **Model downloads.** The first diarized job on a fresh machine downloads
  FluidAudio's CoreML models from HuggingFace (network required once, then
  fully offline; `ModelHub.offlineMode`/`REGISTRY_URL` exist for control).
  SpeechAnalyzer's own locale models are OS-managed and download
  automatically the first time a locale is used. Budget for this in any
  timeout you set around a first run — the E2E suite's warm-up step exists
  specifically for this.
- **`AVAssetExportSession` has a fixed ~90-second overhead in this
  environment, unrelated to file size or format — the startup timeout was
  raised from 60s to 180s (spec §6, `server/src/config.ts`) to
  accommodate it.** While building the malformed-MP3 E2E case,
  `AudioPreparer.repair()`'s `AVAssetExportSession(presetName: .appleM4A)`
  call was measured taking **~90 seconds** to re-export a 32.7-second MP3 —
  reproducibly, and for a *well-formed* MP3 too (isolated with a standalone
  Swift script calling only `AVAssetExportSession`, outside the helper
  entirely; not an artifact of the fabricated test fixture). To narrow down
  whether this was an MP3-decode cost or something broader, the same
  isolated script was run against a completely different input — the
  6.6-second `speech-short.aiff` fixture (AIFF, not MP3) — and it *also*
  took ~90 seconds. A 6.6s AIFF and a 32.7s MP3 costing the same ~90s to
  export rules out "proportional to audio length" or "MP3-decode-specific"
  and points at a fixed, per-call overhead in `AVAssetExportSession` itself
  on this machine — plausibly a hardware media-encode session negotiation
  timeout falling back to software in a sandboxed/virtualized environment,
  though this is a hypothesis, not confirmed. This exceeded the original
  60-second startup timeout, which meant the MP3-repair path the timeout
  is meant to accommodate would always be killed before finishing — dead on
  arrival for the exact case it exists to handle. Fixed by raising
  `DEFAULT_TIMEOUTS.startupTimeoutMs` to 180s (comfortable margin over the
  ~90s measurement, while still catching a genuinely hung/missing helper);
  see `server/src/config.ts` for the rationale comment and
  `server/test/unit/config.test.ts` for a pinning test. The measurement
  itself is environment-dependent and worth re-confirming on non-sandboxed
  hardware — if `speech-short.aiff` exports in ~2s there, this was
  specific to this sandboxed environment — but the larger timeout budget
  is harmless regardless of where the ~90s came from.

## Known limitations

- **Diarization decodes the whole prepared audio file into memory at once.**
  `DiarizationAudioDecoder.swift` reads the entire input into a single
  `AVAudioPCMBuffer` and converts it in one pass, rather than streaming/
  chunking. Memory use scales with media length (and, more precisely, with
  the *decoded* PCM size, so format/duration both matter — e.g. roughly
  ~645MB for 30 minutes of 16 kHz mono Float32, ~2.5GB for 2 hours) — fine
  for this v1's personal-pipeline scale, but something to budget for on very
  long recordings. Switching to FluidAudio's own URL-based `process()`
  entry point would avoid this, but it doesn't allow setting
  `primeMethod = .none` on its internal `AVAudioConverter`, which spec §4
  item 7 mandates (the BufferConverter pattern's rationale: avoiding
  timestamp drift from source). Chunked decode that keeps `primeMethod =
  .none` is a real option but a larger change than a fix-review pass
  should make — left as a v2 item. In the meantime, diarization failure
  (including an out-of-memory condition) degrades gracefully by design: any
  error there is non-fatal (spec §8), reported as a `diarizationFailed`
  warning, and the transcript from transcription is still delivered intact.
- **Per-event synchronous whole-record disk write.** `JobStore.persist()`
  (in `jobStore.ts`) rewrites the entire `job.json` on every single job
  update, synchronously. Fine at this project's scale (single-user,
  concurrency-1 queue, small JSON records); not something this pass changed.

## Out of scope (v1)

Article/guide generation, named speakers (voice enrollment), file upload,
auth, SSE/WebSocket progress, and `mkv`/`webm`/`ogg` via ffmpeg. See the
[design spec](docs/superpowers/specs/2026-07-27-media-transcriber-design.md#out-of-scope-v1)
for the full list and rationale.

## Contributing

This is a personal project, so there's no roadmap to align with — but bug
reports and pull requests are welcome. If you're changing behaviour, please
run `cd server && npm test` (unit, fast, offline) and, when your change
touches the helper or the job pipeline, `npm run test:e2e` after generating
fixtures with `scripts/make-fixtures.sh`. Note the `swift test` caveat in
[Development notes](#development-notes) — use `helper/scripts/swift-test.sh`,
not bare `swift test`, or you'll get a green suite that ran nothing.

## Credits

Built by studying existing work rather than designing from scratch. The Swift
helper owes most of its shape to [yap](https://github.com/finnvoor/yap);
speaker diarization is [FluidAudio](https://github.com/FluidInference/FluidAudio);
the hybrid architecture follows the precedent set by
[swift-scribe](https://github.com/FluidInference/swift-scribe).

Full attribution — dependencies, borrowed patterns, model licensing, and the
primary sources the design was written against — is in [CREDITS.md](CREDITS.md).

## License

[MIT](LICENSE) — free to use, copy, modify, and distribute.
