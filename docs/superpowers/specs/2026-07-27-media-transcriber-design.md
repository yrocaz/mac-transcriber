# Design: media-transcriber

Date: 2026-07-27 · Status: awaiting user approval

A local-first transcription service for macOS: give it a path to any local media file — video or audio — and get back a structured transcript powered by Apple's on-device SpeechAnalyzer. The transcripts are the foundation for a future "transcript → blog article/guide" step, which is out of scope for this build but shapes the output format.

Supporting research (in-repo, with links to all sources):

- [GitHub OSS ecosystem research](../../research/2026-07-27-github-oss-research.md)
- [Apple SpeechAnalyzer documentation research](../../research/2026-07-27-apple-speechanalyzer-docs.md)
- [FluidAudio evaluation notes](../../research/2026-07-27-fluidaudio-notes.md)
- [Verification spikes run on this machine](../../research/spikes/README.md)

## Requirements (from user)

- TypeScript service; input is any local media file — video (mp4/mov/m4v) or audio (mp3/m4a/wav/aiff/caf); output is a transcript. The service is media-agnostic: it only cares about the audio track Apple's frameworks can decode.
- Local HTTP API on this Mac; media referenced by local path; async jobs (POST → job id → poll).
- Outputs stored on local disk. JSON with timestamps is the required format; SRT is nice-to-have.
- End goal: transcripts good enough to be turned into blog articles/guides — clean prose quality matters more than subtitle timing precision.
- Speaker identification in v1: segments labeled with anonymous speaker ids (S1, S2, …) so interviews can become Q&A-style articles. Naming known voices (enrollment) is a future addition.
- Leverage existing OSS patterns and Apple's documented best practices; do not design from scratch.

## Constraints discovered in research

- SpeechAnalyzer is a macOS 26+ system framework: **no Docker, no Linux** — the service runs natively on this Mac only.
- No native Node binding exists; every ecosystem project bridges TypeScript → Swift by spawning a helper binary speaking JSON over stdio (validated by [node-apple-speech](https://github.com/mybigday/node-apple-speech)).
- Video containers (mp4/mov) with audio tracks AND plain audio files (mp3/m4a/wav/aiff/caf) open directly via `AVAudioFile` on macOS 26.5 — verified on this machine; no ffmpeg required (yap's approach). mkv/webm/ogg are unsupported by AVFoundation and out of scope for v1.
- SpeechAnalyzer has **no speaker diarization** — speaker labels come from a second engine, [FluidAudio](https://github.com/FluidInference/FluidAudio) (2.5k⭐, Apache-2.0, CoreML/ANE), following the hybrid proven by [swift-scribe](https://github.com/FluidInference/swift-scribe) (see §8).
- FluidAudio diarization models download from HuggingFace on first use (network required once, then fully offline; `ModelHub.offlineMode` / `REGISTRY_URL` exist for control). SpeechAnalyzer models are OS-managed; requested locales are downloaded as needed.
- Known MP3 edge case (from yap): malformed MP3s that misreport packet count cause `eofErr`; yap's remedy (probe the file tail, re-export to temp M4A via `AVAssetExportSession` when short) is CC0 and adopted in the helper.
- Only English locale models are installed today; other locales are downloadable on demand and the helper handles that automatically.
- Apple limits concurrent analyses ("conservative number", `insufficientResources` beyond it) → serial job processing.

## 1. Architecture

Two components in one repo, mirroring [node-apple-speech](https://github.com/mybigday/node-apple-speech) (stdio bridge) and [whishper](https://github.com/pluja/whishper)/[Scriberr](https://github.com/rishikanthc/Scriberr) (API separate from transcription worker, persisted job records):

```
media-transcriber/
├── server/          TypeScript Fastify API (Node 22+, zod, vitest)
├── helper/          Swift SPM executable: speech-helper (~400 lines; deps: swift-argument-parser, FluidAudio)
├── data/jobs/<id>/  job.json, transcript.json, transcript.srt
└── docs/            specs + research (this doc)
```

The server spawns `helper/.build/release/speech-helper` per job and consumes NDJSON events from its stdout. No database — job records are JSON files on disk.

**Network exposure:** Fastify binds to loopback only (`127.0.0.1`, and `::1` if IPv6 is enabled) — never `0.0.0.0`. The API has no authentication, can list jobs, read transcripts, and submit arbitrary readable local paths; loopback-only binding is the security boundary and is hardcoded, not configurable, in v1.

## 2. HTTP API

| Endpoint | Behavior |
|---|---|
| `POST /jobs` | Body `{ path, locale?, diarize? }` (`diarize` defaults `true`) → validate file exists/readable → `202 { id, status: "queued" }` (both output formats are always produced) |
| `GET /jobs/:id` | Job record: `status` (queued/running/done/error), `progress` (0–1, overall), `warnings[]` (persisted, e.g. `diarizationFailed`), timings, error message |
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
    "diarization": "ok",              // "ok" | "failed" | "disabled"
    "speakerCount": 2,                 // null unless diarization == "ok"
    "createdAt": "2026-07-27T18:00:00Z"
  },
  "text": "Full transcript as clean punctuated prose...",
  "segments": [
    { "id": 0, "start": 0.0, "end": 6.44, "text": "Sentence-level segment.", "speaker": "S1" }
  ]
}
```

- Sentence-level segments: yap's approach — split finalized `AttributedString` on sentence boundaries (NaturalLanguage tokenizer), read each sentence's `.audioTimeRange` attribute.
- Millisecond-rounded decimals (yap's `Decimal` trick) to avoid float artifacts.
- The flat `text` field is directly consumable by a future LLM article step; `segments` preserve the ability to cite media timestamps.
- `speaker` holds an anonymous id (`"S1"`, `"S2"`, …) when diarization succeeds, `null` when it is disabled or failed — `metadata.diarization` says which. Downstream article generation can rely on the shape either way.

## 4. Swift helper — `speech-helper`

Assembled from proven sources, not designed from scratch:

**CLI contract**

- `speech-helper transcribe --input <path> --locale <bcp47> [--no-diarize]` → NDJSON events on stdout:
  `{"type":"ready","durationSec":1830.2}` · `{"type":"model_download","progress":0.42}` · `{"type":"progress","stage":"transcribe"|"diarize","pct":0.42}` · `{"type":"segment","start":1.2,"end":4.5,"text":"..."}` · `{"type":"speakers","segments":[{"start":0.0,"end":12.3,"speaker":"S1"}],"count":2}` · `{"type":"warning","code":"diarizationFailed","message":"..."}` · `{"type":"done","durationSec":1830.2}` · `{"type":"error","code":"noModel","message":"..."}`
- `ready` fires after the input file is opened (duration = `Double(audioFile.length) / processingFormat.sampleRate`), giving the server `durationSec` up front for timeout budgeting (§6).
- `speech-helper status` → JSON: availability + supported/installed locales (backs `/health`).
- Exit 0 on success; nonzero with a final `error` event on failure.

**Implementation recipe** (each point traced to research):

1. Normalize locale via `supportedLocale(equivalentTo:)`, compare `.identifier(.bcp47)` — official Apple engineer guidance ([forum 790108](https://developer.apple.com/forums/thread/790108)); avoids the `en_US`/`en-US` footgun.
2. Always call `AssetInventory.assetInstallationRequest(supporting:)` → `downloadAndInstall()` — documented idempotent/consolidated ([AssetInventory](https://developer.apple.com/documentation/speech/assetinventory)); report its `Progress` as `model_download` events.
3. `SpeechTranscriber(locale:, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])` — file transcription needs no volatile results ([WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/)).
4. Start the `results` consumer task FIRST (results dropped otherwise), then `AVAudioFile(forReading:)` → `analyzeSequence(from:)` → `finalizeAndFinish(through:)`, or `cancelAndFinishNow()` on nil — the [argmax example](https://github.com/argmaxinc/apple-speechanalyzer-cli-example) pattern; the file path is the battle-tested one on 26.x ([forum 818005](https://developer.apple.com/forums/thread/818005)).
5. Progress = `result.resultsFinalizationTime.seconds / fileDuration` where duration = `Double(audioFile.length) / processingFormat.sampleRate` (yap's method).
6. MP3 edge case: adopt yap's `TranscriptionAudioFile` fix (CC0) — probe the last ≤4096 frames; if the file reads short (`eofErr` from misreported packet count), re-export to a temp M4A via `AVAssetExportSession(presetName: AVAssetExportPresetAppleM4A)`. Input preparation happens ONCE, before `ready`: the resulting "prepared URL" (original path, or repaired temp M4A) is the single input for BOTH transcription and diarization, and temp cleanup runs only after both stages finish (success or failure).
7. Diarization (unless `--no-diarize`): after transcription, decode the prepared URL to 16 kHz mono Float32 (AVAudioFile + `AVAudioConverter` with `primeMethod = .none` — the BufferConverter pattern from Apple's official sample), then FluidAudio `OfflineDiarizerManager` (Pyannote Community-1 offline pipeline: powerset segmentation + WeSpeaker embeddings + VBx clustering; FluidAudio pinned at v0.15.5): `prepareModels()` → `process(audio:)` → speaker segments `{speakerId, startTimeSeconds, endTimeSeconds}` ([FluidAudio README](https://github.com/FluidInference/FluidAudio)). Each sentence segment gets the speaker with maximum time overlap; sentences with no overlapping speaker turn keep `null`.
8. Diarization failures are non-fatal by design: any error (model download, processing) emits a `warning` event and the job completes with `metadata.diarization: "failed"`, transcript intact.
9. No `modelRetention` tuning in v1 — the helper is a stateless per-job process; observed model spin-up is ~0.3s.

## 5. Job handling & concurrency

- In-process FIFO queue, **concurrency 1** (sidesteps Apple's documented `insufficientResources` limit; fine for a personal pipeline).
- Per-job flow: write `job.json` (queued) → spawn helper → stream events, update `job.json` progress → write `transcript.json` + `transcript.srt` → mark done.
- On server restart: jobs found in queued/running state are marked `error: "interrupted"`; re-POST to retry.
- Job IDs: short random IDs (nanoid-style); job directory is the unit of storage and cleanup.

## 6. Error handling

- Request validation with zod: path exists, is a file, readable, extension in the supported set (`mp4 mov m4v mp3 m4a wav aiff aif caf`) — unsupported extensions rejected at POST time with a message listing supported formats, rather than failing later in the helper.
- Helper maps [`SFSpeechError.Code`](https://developer.apple.com/documentation/speech/sfspeecherror/code) to friendly codes/messages: `noModel`, `cannotAllocateUnsupportedLocale`, `insufficientResources`, `audioReadFailed`, etc.
- No-audio-track or unsupported container (mkv/webm) fails fast at `AVAudioFile` open with a clear message. ffmpeg fallback = documented future option, not built now.
- Helper supervision uses three distinct timeouts, all resulting in kill + job error with stderr captured:
  - **Startup:** 180s from spawn to the `ready` event (covers file-open and MP3 repair — the `AVAssetExportSession` re-export a malformed MP3 triggers was measured taking up to ~90s in verification; raised from an initial 60s once Task 5's E2E testing showed that budget killed the repair path it was meant to accommodate).
  - **Inactivity:** 120s with no NDJSON event of any type. Both model-download paths keep the job alive across this window, but by different mechanisms: Apple's `AssetInventory` download is KVO-driven and reports its own `model_download` progress events natively; FluidAudio's diarization model download and `prepareModels()` call emit nothing on their own, so the helper emits a synthetic `progress{stage:"diarize",pct:0}` keepalive immediately before diarization starts and then periodically (every ~20s) until diarization's own progress callback reports real activity (`KeepAliveTicker`, `TranscribeCommand.swift`). `pct:0` is a no-op for the server's monotonic progress mapping once transcription has already reached 1.0, so this never advances or misreports overall progress — it exists purely to reset the inactivity timer.
  - **Total runtime:** `max(2 × durationSec, 10 min)`, armed once `ready` supplies `durationSec`.
- **Overall job progress** is a monotonic mapping of stage progress: with diarization enabled, `transcribe` maps to 0–0.9 and `diarize` to 0.9–1.0; with `diarize: false`, `transcribe` maps to 0–1.0. The server clamps updates so reported progress never decreases.
- Diarization `warning` events are appended to `warnings[]` in `job.json` (persisted, returned by `GET /jobs/:id`) so degradation remains observable after the fact.

## 7. Testing

- **TS unit tests (vitest):** SRT rendering, NDJSON event parsing (including `speakers`/`warning` events), speaker-overlap merge logic, job store/state machine, route validation — against a fake helper (shell script echoing canned NDJSON), so tests run fast anywhere.
- **E2E smoke test (macOS only):** single-voice `say` fixture through the real helper + API; assert transcript content. A two-voice fixture (two different `say` voices concatenated) sanity-checks that diarization yields two speakers. The verified sample mp4 covers container handling.
- **Swift helper:** kept thin; correctness primarily covered by E2E. A Swift test target (`helper/Tests/speech-helperTests/`) was added during the fix-review rounds for logic that doesn't need the real FluidAudio/SpeechAnalyzer pipeline to verify — the `EventEmitter` terminal-event guarantee and `SpeakerDiarizer.relabelByFirstAppearance`'s first-appearance ordering. Run it via `helper/scripts/swift-test.sh`, not bare `swift test` — see that script's header comment and the README's Development notes for why a wrapper is needed on a Command Line Tools-only toolchain.

## 8. Speaker identification (in scope, v1)

SpeechAnalyzer has no diarization module, so speaker labels come from a second, purpose-built engine — the hybrid used in practice by [swift-scribe](https://github.com/FluidInference/swift-scribe) (FluidInference's own app pairs Apple's SpeechAnalyzer for words with their FluidAudio for speakers):

- **Engine:** [FluidAudio](https://github.com/FluidInference/FluidAudio) (2.5k⭐, Apache-2.0, pinned at v0.15.5), Pyannote **Community-1** offline pipeline via `OfflineDiarizerManager` (powerset segmentation + WeSpeaker embeddings + VBx clustering) — the batch-appropriate choice; its streaming diarizers (LS-EEND, Sortformer, legacy Pyannote 3.1) are not used. CoreML on the Neural Engine; fully local after a one-time model download from HuggingFace.
- **Merge strategy:** maximum time-overlap between each transcript sentence and diarized speaker turns. Anonymous labels (`S1`, `S2`) ordered by first appearance.
- **Degradation:** diarization failure never fails the job — `metadata.diarization: "failed"`, `speaker: null`, transcript delivered.
- **Accuracy realism:** diarization is imperfect on crosstalk-heavy audio; labels are an editing aid for article writing, not ground truth.
- **Future (not v1):** naming known voices via FluidAudio's speaker-embedding support (enroll a reference sample of a recurring host, label them by name across episodes).

## Out of scope (v1)

- Article/guide generation (the transcript schema is designed for it; the step itself is a future project)
- Named speakers via voice enrollment (anonymous S1/S2 labels only; see §8)
- File upload, auth, SSE/WebSocket progress, mkv/webm/ogg via ffmpeg, Docker (impossible for this framework)

## Reference material

**Apple (official):** [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) · [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) · [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory) · [Preset](https://developer.apple.com/documentation/speech/speechtranscriber/preset) · [Result](https://developer.apple.com/documentation/speech/speechtranscriber/result) · [SFSpeechError.Code](https://developer.apple.com/documentation/speech/sfspeecherror/code) · [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/) · [Official sample app](https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app) · [Locale forum answer (790108)](https://developer.apple.com/forums/thread/790108) · [File-path reliability thread (818005)](https://developer.apple.com/forums/thread/818005)

**OSS studied:** [yap](https://github.com/finnvoor/yap) (1.5k⭐, CC0 — primary pattern source) · [argmax minimal example](https://github.com/argmaxinc/apple-speechanalyzer-cli-example) · [node-apple-speech](https://github.com/mybigday/node-apple-speech) (stdio bridge) · [Stenographer](https://github.com/otaviocc/Stenographer) (event design) · [whishper](https://github.com/pluja/whishper) / [Scriberr](https://github.com/rishikanthc/Scriberr) (job model) · [ohr](https://github.com/Arthur-Ficial/ohr) (HTTP shape) · [FluidAudio](https://github.com/FluidInference/FluidAudio) (diarization engine) · [swift-scribe](https://github.com/FluidInference/swift-scribe) (hybrid precedent)
