# Design: video-transcriber

Date: 2026-07-27 · Status: awaiting user approval

A local-first transcription service for macOS: give it a path to a video file, get back a structured transcript powered by Apple's on-device SpeechAnalyzer. The transcripts are the foundation for a future "transcript → blog article/guide" step, which is out of scope for this build but shapes the output format.

Supporting research (in-repo, with links to all sources):

- [GitHub OSS ecosystem research](../../research/2026-07-27-github-oss-research.md)
- [Apple SpeechAnalyzer documentation research](../../research/2026-07-27-apple-speechanalyzer-docs.md)
- [Verification spikes run on this machine](../../research/spikes/README.md)

## Requirements (from user)

- TypeScript service; input is a video file; output is a transcript.
- Local HTTP API on this Mac; videos referenced by local path; async jobs (POST → job id → poll).
- Outputs stored on local disk. JSON with timestamps is the required format; SRT is nice-to-have.
- End goal: transcripts good enough to be turned into blog articles/guides — clean prose quality matters more than subtitle timing precision.
- Leverage existing OSS patterns and Apple's documented best practices; do not design from scratch.

## Constraints discovered in research

- SpeechAnalyzer is a macOS 26+ system framework: **no Docker, no Linux** — the service runs natively on this Mac only.
- No native Node binding exists; every ecosystem project bridges TypeScript → Swift by spawning a helper binary speaking JSON over stdio (validated by [node-apple-speech](https://github.com/mybigday/node-apple-speech)).
- Video containers (mp4/mov) with audio tracks open directly via `AVAudioFile` on macOS 26.5 — verified on this machine; no ffmpeg required (yap's approach). mkv/webm are unsupported by AVFoundation and out of scope for v1.
- Only English locale models are installed today; other locales are downloadable on demand and the helper handles that automatically.
- Apple limits concurrent analyses ("conservative number", `insufficientResources` beyond it) → serial job processing.

## 1. Architecture

Two components in one repo, mirroring [node-apple-speech](https://github.com/mybigday/node-apple-speech) (stdio bridge) and [whishper](https://github.com/pluja/whishper)/[Scriberr](https://github.com/rishikanthc/Scriberr) (API separate from transcription worker, persisted job records):

```
video-transcriber/
├── server/          TypeScript Fastify API (Node 22+, zod, vitest)
├── helper/          Swift SPM executable: speech-helper (~200 lines)
├── data/jobs/<id>/  job.json, transcript.json, transcript.srt
└── docs/            specs + research (this doc)
```

The server spawns `helper/.build/release/speech-helper` per job and consumes NDJSON events from its stdout. No database — job records are JSON files on disk.

## 2. HTTP API

| Endpoint | Behavior |
|---|---|
| `POST /jobs` | Body `{ path, locale? }` → validate file exists/readable → `202 { id, status: "queued" }` (both output formats are always produced) |
| `GET /jobs/:id` | Job record: `status` (queued/running/done/error), `progress` (0–1), timings, error message |
| `GET /jobs` | List jobs, newest first |
| `GET /jobs/:id/transcript.json` | Structured transcript |
| `GET /jobs/:id/transcript.srt` | Subtitles |
| `GET /health` | Helper binary present, `SpeechTranscriber.isAvailable`, installed locales |

Progress via polling `GET /jobs/:id` — no SSE/WebSocket in v1 (YAGNI; the job record's `progress` field updates live as helper events stream in).

## 3. Transcript schema (designed for the article goal)

```jsonc
{
  "metadata": {
    "source": "/path/video.mp4",
    "durationSec": 1830.2,
    "locale": "en-US",
    "engine": "apple-speechanalyzer",
    "createdAt": "2026-07-27T18:00:00Z"
  },
  "text": "Full transcript as clean punctuated prose...",
  "segments": [
    { "id": 0, "start": 0.0, "end": 6.44, "text": "Sentence-level segment." }
  ]
}
```

- Sentence-level segments: yap's approach — split finalized `AttributedString` on sentence boundaries (NaturalLanguage tokenizer), read each sentence's `.audioTimeRange` attribute.
- Millisecond-rounded decimals (yap's `Decimal` trick) to avoid float artifacts.
- The flat `text` field is directly consumable by a future LLM article step; `segments` preserve the ability to cite video timestamps.

## 4. Swift helper — `speech-helper`

Assembled from proven sources, not designed from scratch:

**CLI contract**

- `speech-helper transcribe --input <path> --locale <bcp47>` → NDJSON events on stdout:
  `{"type":"ready"}` · `{"type":"model_download","progress":0.42}` · `{"type":"progress","pct":0.42}` · `{"type":"segment","start":1.2,"end":4.5,"text":"..."}` · `{"type":"done","durationSec":1830.2}` · `{"type":"error","code":"noModel","message":"..."}`
- `speech-helper status` → JSON: availability + supported/installed locales (backs `/health`).
- Exit 0 on success; nonzero with a final `error` event on failure.

**Implementation recipe** (each point traced to research):

1. Normalize locale via `supportedLocale(equivalentTo:)`, compare `.identifier(.bcp47)` — official Apple engineer guidance ([forum 790108](https://developer.apple.com/forums/thread/790108)); avoids the `en_US`/`en-US` footgun.
2. Always call `AssetInventory.assetInstallationRequest(supporting:)` → `downloadAndInstall()` — documented idempotent/consolidated ([AssetInventory](https://developer.apple.com/documentation/speech/assetinventory)); report its `Progress` as `model_download` events.
3. `SpeechTranscriber(locale:, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])` — file transcription needs no volatile results ([WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)).
4. Start the `results` consumer task FIRST (results dropped otherwise), then `AVAudioFile(forReading:)` → `analyzeSequence(from:)` → `finalizeAndFinish(through:)`, or `cancelAndFinishNow()` on nil — the [argmax example](https://github.com/argmaxinc/apple-speechanalyzer-cli-example) pattern; the file path is the battle-tested one on 26.x ([forum 818005](https://developer.apple.com/forums/thread/818005)).
5. Progress = `result.resultsFinalizationTime.seconds / fileDuration` where duration = `Double(audioFile.length) / processingFormat.sampleRate` (yap's method).
6. No `modelRetention` tuning in v1 — the helper is a stateless per-job process; observed model spin-up is ~0.3s.

## 5. Job handling & concurrency

- In-process FIFO queue, **concurrency 1** (sidesteps Apple's documented `insufficientResources` limit; fine for a personal pipeline).
- Per-job flow: write `job.json` (queued) → spawn helper → stream events, update `job.json` progress → write `transcript.json` + `transcript.srt` → mark done.
- On server restart: jobs found in queued/running state are marked `error: "interrupted"`; re-POST to retry.
- Job IDs: short random IDs (nanoid-style); job directory is the unit of storage and cleanup.

## 6. Error handling

- Request validation with zod: path exists, is a file, readable.
- Helper maps [`SFSpeechError.Code`](https://developer.apple.com/documentation/speech/sfspeecherror/code) to friendly codes/messages: `noModel`, `cannotAllocateUnsupportedLocale`, `insufficientResources`, `audioReadFailed`, etc.
- No-audio-track or unsupported container (mkv/webm) fails fast at `AVAudioFile` open with a clear message. ffmpeg fallback = documented future option, not built now.
- Helper crash / nonzero exit / stall (timeout = max(2× realtime, 5 min)) → job marked error, stderr captured into the job record.

## 7. Testing

- **TS unit tests (vitest):** SRT rendering, NDJSON event parsing, job store/state machine, route validation — against a fake helper (shell script echoing canned NDJSON), so tests run fast anywhere.
- **E2E smoke test (macOS only):** `say`-generated speech fixture through the real helper + API; assert transcript content. The verified sample mp4 covers container handling.
- **Swift helper:** thin enough (~200 lines) that E2E covers it; no separate Swift test target in v1.

## Out of scope (v1)

- Article/guide generation (the transcript schema is designed for it; the step itself is a future project)
- File upload, auth, SSE/WebSocket progress, diarization (FluidAudio is the ecosystem answer if ever needed), mkv/webm via ffmpeg, Docker (impossible for this framework)

## Reference material

**Apple (official):** [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) · [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) · [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory) · [Preset](https://developer.apple.com/documentation/speech/speechtranscriber/preset) · [Result](https://developer.apple.com/documentation/speech/speechtranscriber/result) · [SFSpeechError.Code](https://developer.apple.com/documentation/speech/sfspeecherror/code) · [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/) · [Official sample app](https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app) · [Locale forum answer (790108)](https://developer.apple.com/forums/thread/790108) · [File-path reliability thread (818005)](https://developer.apple.com/forums/thread/818005)

**OSS studied:** [yap](https://github.com/finnvoor/yap) (1.5k⭐, CC0 — primary pattern source) · [argmax minimal example](https://github.com/argmaxinc/apple-speechanalyzer-cli-example) · [node-apple-speech](https://github.com/mybigday/node-apple-speech) (stdio bridge) · [Stenographer](https://github.com/otaviocc/Stenographer) (event design) · [whishper](https://github.com/pluja/whishper) / [Scriberr](https://github.com/rishikanthc/Scriberr) (job model) · [ohr](https://github.com/Arthur-Ficial/ohr) (HTTP shape)
