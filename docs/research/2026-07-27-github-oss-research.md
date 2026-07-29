# Research: SpeechAnalyzer OSS ecosystem on GitHub

Date: 2026-07-27. Star counts and last-push dates are live values from that day, collected via the GitHub API.

Purpose: identify the highest-rated open-source projects using Apple's SpeechAnalyzer / SpeechTranscriber API (Speech framework, macOS 26 / iOS 26) to learn documented, proven patterns before building our TypeScript media-transcription service.

---

## 1. CLI tools & apps wrapping SpeechAnalyzer (ranked by stars)

| # | Repo | URL | Stars | Last push | License | Notes |
|---|------|-----|-------|-----------|---------|-------|
| 1 | finnvoor/yap | <https://github.com/finnvoor/yap> | 1,538 | 2026-07-20 | CC0-1.0 | THE reference CLI. Audio+video files, txt/srt/vtt/json, word timestamps, MCP server mode |
| 2 | FluidInference/swift-scribe | <https://github.com/FluidInference/swift-scribe> | 320 | 2026-07-10 | MIT | SpeechAnalyzer + FoundationModels app; mic streaming path + FluidAudio diarization |
| 3 | rryam/AuralKit | <https://github.com/rryam/AuralKit> | 164 | 2026-07-11 | MIT | Reusable Swift package (SpeechSession API); file + mic + system-audio input |
| 4 | Marvinngg/ambient-voice | <https://github.com/Marvinngg/ambient-voice> | 133 | 2026-05-27 | none | Meeting transcription, SpeechAnalyzer + Vision OCR |
| 5 | Kuberwastaken/megaphone | <https://github.com/Kuberwastaken/megaphone> | 119 | 2026-07-24 | MIT | Dictation app (mic only, not file-based) |
| 6 | Arthur-Ficial/ohr | <https://github.com/Arthur-Ficial/ohr> | 32 | 2026-04-15 | MIT | CLI + OpenAI-compatible HTTP server (`POST /v1/audio/transcriptions`, json/verbose_json/text/srt/vtt). Homebrew: `brew install Arthur-Ficial/tap/ohr`. Closest existing thing to our service |
| 7 | 0Itsuki0/SwiftUI_SpeechAnalyzerDemo | <https://github.com/0Itsuki0/SwiftUI_SpeechAnalyzerDemo> | 26 | 2025-09-06 | none | Demo: file + realtime |
| 8 | simonw/speech-analyzer-cli | <https://github.com/simonw/speech-analyzer-cli> | 20 | 2026-07-14 | MIT | Simon Willison's CLI; txt/word-level JSON/JSONL/SRT/VTT, `--list-locales` |
| 9 | argmaxinc/apple-speechanalyzer-cli-example | <https://github.com/argmaxinc/apple-speechanalyzer-cli-example> | 15 | 2025-12-31 | MIT | Minimal single-file reference (~100 lines). Cleanest "hello world" |
| 10 | otaviocc/Stenographer | <https://github.com/otaviocc/Stenographer> | 15 | 2026-02-16 | MIT | macOS app for audio/video file transcription; AsyncThrowingStream event design |
| 11 | Kilo-Loco/transcription-mcp | <https://github.com/Kilo-Loco/transcription-mcp> | 2 | 2026-03-09 | MIT | MCP server claiming 76x realtime via SpeechAnalyzer |
| 12 | DravenYe/swift-speech-analyzer | <https://github.com/DravenYe/swift-speech-analyzer> | 1 | 2026-05-02 | none | Small CLI |

### Known-candidate verdicts

- **hear** (<https://github.com/sveinbjornt/hear>, 669 ⭐, BSD-3, ObjC, macOS 13+) — uses the OLD `SFSpeechRecognizer` API, NOT SpeechAnalyzer. Don't model on it.
- **FluidAudio** (<https://github.com/FluidInference/FluidAudio>, 2,528 ⭐, Apache-2.0) — does NOT use SpeechAnalyzer; runs CoreML models (Parakeet ASR, diarization, VAD). Relevant as an alternative engine or for diarization (SpeechAnalyzer has none).
- **AudioWhisper** (<https://github.com/mazdak/AudioWhisper>, 260 ⭐, MIT) — Whisper/Gemini menu-bar app, not SpeechAnalyzer-centric.
- **Slipbox** — no relevant SpeechAnalyzer repo found; dead lead.
- Apple's own sample: <https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app> (mirrored at <https://github.com/kmt901/SwiftTranscriptionSampleApp>). WWDC25 session 277: <https://developer.apple.com/videos/play/wwdc2025/277/>

## 1a. How yap uses the API (from full source)

Files under <https://github.com/finnvoor/yap/tree/main/Sources/yap>: `Transcribe.swift`, `TranscriptionEngine.swift`, `TranscriptionAudioFile.swift`, `OutputFormat.swift`.

**Video file opening: NO ffmpeg.** yap opens video files directly with `AVAudioFile(forReading:)` — CoreAudio/AVFoundation reads the audio track of mp4/mov natively:

```swift
let audioFile = preparedAudioFile.audioFile
try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
```

**No manual format conversion** for files — `analyzer.start(inputAudioFile:)` converts internally; yap never touches `bestAvailableAudioFormat`/`AVAudioConverter` on the file path. Only preprocessing: malformed MP3s reporting one extra packet cause `eofErr`, so yap probes the last ≤4096 frames and, if short, re-exports to temp M4A via `AVAssetExportSession(presetName: AVAssetExportPresetAppleM4A)`, with `defer { preparedAudioFile.removeTemporaryFile() }` cleanup.

**Locale/asset management** (exact sequence to copy):

```swift
guard SpeechTranscriber.isAvailable else { throw ... }
let supportedLocales = await SpeechTranscriber.supportedLocales
guard supportedLocales.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else { throw ... }
for locale in await AssetInventory.reservedLocales { await AssetInventory.release(reservedLocale: locale) }
try await AssetInventory.reserve(locale: locale)
let installedLocales = await SpeechTranscriber.installedLocales
if !installedLocales.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        try await request.downloadAndInstall()   // request.progress (a Progress) polled for UI
    }
}
```

Note the BCP-47 comparison (`identifier(.bcp47)`) — plain `Locale ==` comparisons are a known footgun.

**Transcriber config** — attribute options only requested when needed:

```swift
let transcriber = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: censor ? [.etiquetteReplacements] : [],
    reportingOptions: [],                       // no volatile results for file mode
    attributeOptions: outputFormat.needsAudioTimeRange ? [.audioTimeRange] : []
)
```

**Results + progress**: file mode uses final results only; progress % = `result.resultsFinalizationTime.seconds / audioFileDuration` (duration = `Double(audioFile.length) / audioFile.processingFormat.sampleRate`). Transcript accumulated as `AttributedString`.

**SRT/timestamps** (`OutputFormat.swift`): timestamps live as `.audioTimeRange` attributes (CMTimeRange) on the AttributedString. yap splits into sentences (NaturalLanguage tokenizer, `--max-length` chars, default 40), reads each sentence's `audioTimeRange`, formats `HH:MM:SS,mmm` (SRT) / `HH:MM:SS.mmm` (VTT). JSON output uses `Decimal(Int(round(t*1000)))/1000` to avoid float artifacts. Word timestamps: filter per-word ranges inside each sentence range.

**CLI design**: swift-argument-parser; positional input; `--locale`, `--censor`, `--txt/--srt/--vtt/--json`, `-o`, `--max-length`, `--word-timestamps`; `isatty` detection to suppress pretty UI when piped; distinct `LocalizedError` enums per failure.

## 1b. argmax minimal example (best "hello world")

`Sources/apple-speechanalyzer-cli/SpeechAnalyzerCLI.swift` (<https://github.com/argmaxinc/apple-speechanalyzer-cli-example>) — the `analyzeSequence` drive API:

```swift
let transcriber = SpeechTranscriber(locale: locale, preset: liveMode ? .progressiveLiveTranscription : .offlineTranscription)
if !(await SpeechTranscriber.installedLocales).contains(locale) {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }
}
let analyzer = SpeechAnalyzer(modules: [transcriber])
let audioFile = try AVAudioFile(forReading: inputURL)
async let attrTranscript: AttributedString = transcriber.results.reduce(into: AttributedString("")) { $0.append($1.text); $0.append(AttributedString(" ")) }
if let last = try await analyzer.analyzeSequence(from: audioFile) {
    try await analyzer.finalizeAndFinish(through: last)
} else {
    await analyzer.cancelAndFinishNow()
}
```

Key insights: `SpeechTranscriber.Preset` bundles sensible option sets; the results consumer (`async let`) must start **before** driving the analyzer or results are dropped.

## 1c. swift-scribe / AuralKit — the streaming-buffer path (mic input; not our path)

swift-scribe `Scribe/Transcription/Transcription.swift` (<https://github.com/FluidInference/swift-scribe/blob/main/Scribe/Transcription/Transcription.swift>): `.volatileResults` + `bestAvailableAudioFormat` + `AVAudioConverter` + `AsyncStream<AnalyzerInput>`. AuralKit `BufferConverter` (<https://github.com/rryam/AuralKit/blob/main/Sources/AuralKit/BufferConverter.swift>) is the canonical AVAudioConverter wrapper (from Apple's sample): `primeMethod = .none` to avoid timestamp drift.

**Rule of thumb across all repos: for FILE transcription you never need bestAvailableAudioFormat/AVAudioConverter — pass AVAudioFile straight in. Conversion only matters for streamed PCM buffers.**

## 1d. Stenographer — service-event pattern

`Stenographer/Service/TranscriptionService.swift` (<https://github.com/otaviocc/Stenographer/blob/main/Stenographer/Service/TranscriptionService.swift>): copies input to temp dir, `AVAudioFile(forReading:)` on video/audio alike, same release-all-then-reserve AssetInventory sequence as yap, `analyzer.start(inputAudioFile:finishAfterFile: true)`, exposes `AsyncThrowingStream<TranscriptionEvent, Error>` with events "Checking language assets…" → "Downloading language assets…" → "Transcribing audio…" → `.transcriptionUpdated(partial)` → `.completed`. This event enum maps 1:1 to our NDJSON progress events.

---

## 2. Node.js/TypeScript bridges to SpeechAnalyzer

Ecosystem is tiny. Everything bridges via a **spawned Swift helper binary + JSON-over-stdout**, not N-API addons (Swift concurrency + macOS 26 SDK makes native addons painful).

| Repo/pkg | URL | Stars/dl | License | Approach |
|---|---|---|---|---|
| mybigday/node-apple-speech | <https://github.com/mybigday/node-apple-speech> | 0 ⭐ / ~4 wk dl | MIT | TS wrapper + `native/apple-speech-helper.swift`; whisper.node-compatible API |
| @insidepics/expo-apple-intelligence | <https://github.com/InsidePics/expo-apple-intelligence> | 13 wk dl | — | Expo module (iOS, not macOS service) |
| expo-speech-transcriber | <https://github.com/DaveyEke/expo-speech-transcriber> | 1,279 wk dl | — | RN/Expo iOS on-device transcription |
| aethiopicuschan/speech-analyzer-dylib | <https://github.com/aethiopicuschan/speech-analyzer-dylib> | 2 ⭐ | MIT | SpeechAnalyzer as dylib (FFI-able) |
| blendfactory/speech-kit | <https://github.com/blendfactory/speech-kit> | 0 ⭐ | BSD-3 | Dart bindings (pattern reference) |

**node-apple-speech architecture** (`src/index.ts`, `native/apple-speech-helper.swift`, `scripts/build-helper.js`):

- TS side: `spawn(helperPath, [command, ...args], { stdio: ['ignore','pipe','pipe'] })`; commands `transcribe --file <path> --language <lang>`, `is-available`, `prepare --language`, `version`. Exit 0 + JSON on stdout = success; JSON error on stderr + exit 1 = failure. `ensureMacOS()` guard.
- Swift side: preset `timeIndexedTranscriptionWithAlternatives` minus `.alternativeTranscriptions`; `AVAudioFile` → `analyzeSequence(from:)`; `AssetInventory.status(forModules:)` then `downloadAndInstall()` if missing; final-only results as `{text, t0, t1}` ms segments; newline-delimited JSON writer.
- Verdict: validates the "TypeScript spawns a small Swift CLI, speaks NDJSON over stdio" design. 0 stars → pattern donor, not a dependency.

---

## 3. TS/Node transcription SERVICE architectures (Whisper-based; for service shape)

| Repo | URL | Stars | License | Takeaway |
|---|---|---|---|---|
| pluja/whishper | <https://github.com/pluja/whishper> | 3,049 | AGPL-3.0 | Upload → job doc with status field → worker polls → SRT/VTT/JSON. Separate worker from API; job status enum persisted |
| rishikanthc/Scriberr | <https://github.com/rishikanthc/Scriberr> | 2,860 | MIT | Queued jobs, WebSocket progress, diarization, API keys |
| amicalhq/amical | <https://github.com/amicalhq/amical> | 1,468 | MIT | TS/Electron local-first dictation; native helper pattern from TS |
| corvo007/MioSub | <https://github.com/corvo007/MioSub> | 764 | AGPL-3.0 | Full pipeline: download → transcribe → translate → subtitles |
| homelab-00/TranscriptionSuite | <https://github.com/homelab-00/TranscriptionSuite> | 616 | GPL-3.0 | Local STT + diarization |
| crafter-station/trx | <https://github.com/crafter-station/trx> | 84 | MIT | TS agent-first CLI for audio/video transcription |
| JacobLinCool/smart-whisper | <https://github.com/JacobLinCool/smart-whisper> | 76 | MIT | Node N-API addon for whisper.cpp — the "real addon" contrast |
| Eyevinn/auto-subtitles | <https://github.com/Eyevinn/auto-subtitles> | 55 | Apache-2.0 | TS/Node: video → ffmpeg extract → whisper → SRT/VTT |

Common service-shape patterns:

1. **Async job model**: POST returns job id immediately; status via polling or WS/SSE; job record persists status + progress % + error string.
2. **ffmpeg normalization** is a Whisper requirement. With SpeechAnalyzer, skip ffmpeg for most containers (AVAudioFile reads mp4/mov/m4a/mp3/wav directly, per yap); ffmpeg only as future fallback for mkv/webm.
3. **Temp file hygiene**: per-job UUID dirs, cleanup on success AND error.
4. **Progress**: derive % from `resultsFinalizationTime / fileDuration`.
5. **Output schema**: `{metadata:{duration,language,created}, segments:[{id,start,end,text}]}` with millisecond-decimal rounding.

---

## Empirical verification on this machine (2026-07-27, macOS 26.5.2)

- `SpeechTranscriber.isAvailable == true`; 30 supported locales, 9 installed (all English variants).
- File transcription of a `say`-generated AIFF: perfect transcript with punctuation, 0.27s for ~7s audio (~25× realtime).
- **`AVAudioFile(forReading:)` opened a real video mp4 (with AAC audio track) directly and ran through `analyzeSequence(from:)` without error** — confirming yap's no-ffmpeg approach on macOS 26.5. A no-audio-track mp4 fails at open with CoreAudio error 1685348671 (`dta?`), which is the fail-fast behavior we want.
- Spike code preserved in `docs/research/spikes/`.
