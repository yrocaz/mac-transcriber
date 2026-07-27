# Research: Apple SpeechAnalyzer official documentation & best practices

Date: 2026-07-27. Content pulled from Apple's DocC JSON (exact content of the human-readable pages). Everything is OFFICIAL Apple unless marked THIRD-PARTY.

**Versioning caveat:** Apple's currently-served docs describe the macOS 27-beta SDK; items flagged "27 beta" are NOT available on macOS 26.5 (this machine).

---

## 1. SpeechAnalyzer core

<https://developer.apple.com/documentation/speech/speechanalyzer> — `final actor SpeechAnalyzer` (macOS 26.0+, iOS 26.0+)

Documented workflow: (1) create/configure modules; (2) ensure assets installed via AssetInventory; (3) create input sequence; (4) create analyzer with modules; (5) supply audio; (6) start analysis; (7) act on results; (8) finish analysis.

Key documented statements:

- "The analyzer can only analyze one input sequence at a time."
- Results arrive via `AsyncSequence` on the module, decoupled from input; input/output/session control "typically occur over several different tasks."
- "You can and usually should perform analysis using the `analyzeSequence(_:)` or `analyzeSequence(from:)` methods." Autonomous mode (`start(...)`) is the alternative; end it with `finalizeAndFinishThroughEndOfInput()`.
- Finishing: you MUST call a finish method or deallocate the analyzer; terminating the input `AsyncStream` alone "does not generally finish the analysis session."
- Errors: when the analyzer or result streams throw, the session becomes finished and the same error (or `CancellationError`) is thrown from all waiting methods and result streams. Recovery: "create a new analyzer to continue working on the remaining (and any additional) input."
- Concurrency limits: system limits simultaneous analyses to "a conservative number"; exceeding throws `insufficientResources`. `SpeechAnalyzer.Options(ignoresResourceLimits: true)` overrides, with unpredictable failures past hardware capacity.

Key signatures:

- `func analyzeSequence(from audioFile: AVAudioFile) async throws -> CMTime?` — <https://developer.apple.com/documentation/speech/speechanalyzer/analyzesequence(from:)> — "When this method returns, the file will have been read, but the last of the audio may still be undergoing analysis. To wait for the analysis to complete, call another method such as `finalize(through:)` and await its return." Returns last sample time-code (feed to `finalizeAndFinish(through:)`) or nil if file empty.
- `func analyzeSequence<InputSequence>(_ inputSequence:) async throws -> CMTime?` — buffer-stream variant. Cancelling the task makes it return early with the last consumed time-code, NOT throw.
- `convenience init(inputAudioFile:modules:options:analysisContext:finishAfterFile:volatileRangeChangedHandler:)` — `finishAfterFile: true` == auto-finish after file.
- `func finalizeAndFinish(through: CMTime) async throws`, `func finalizeAndFinishThroughEndOfInput() async throws`, `func cancelAndFinishNow() async`, `func setModules(...)`, `func prepareToAnalyze(in: AVAudioFormat?) async throws` (preheat; also variant with progress handler).
- `SpeechAnalyzer.Options(priority:modelRetention:)`; `ModelRetention`: `.whileInUse` / `.lingering` / `.processLifetime` — <https://developer.apple.com/documentation/speech/speechanalyzer/options/modelretention-swift.enum>.

## 2. Audio format rules

<https://developer.apple.com/documentation/speech/speechanalyzer/bestavailableaudioformat(compatiblewith:)>

- "In order to keep `CMTime` values sample-accurate, the analyzer does not transparently upsample, downsample, or convert audio input" — applies to the BUFFER path (`AnalyzerInput`); you convert with `AVAudioConverter` (`primeMethod = .none` per Apple's sample, to avoid timestamp drift).
- Returns nil "if the specified modules require you to install additional assets" — call AFTER model install.
- The FILE path (`analyzeSequence(from:)` / `inputAudioFile:`) handles conversion for you.

## 3. SpeechTranscriber

<https://developer.apple.com/documentation/speech/speechtranscriber> — `final class SpeechTranscriber: SpeechModule` (Sendable). "Several transcriber instances can share the same backing engine instances and models, so long as the transcribers are configured similarly."

- Inits: `(locale:preset:)` and `(locale:transcriptionOptions:reportingOptions:attributeOptions:)`
- `static var isAvailable: Bool` (fall back to `DictationTranscriber` if false)
- `supportedLocales` / `installedLocales` / `supportedLocale(equivalentTo:)`
- `var results: some Sendable & AsyncSequence<Result, any Error>` — "Accessing this property does not create a new sequence."

Options:

- ReportingOption — <https://developer.apple.com/documentation/speech/speechtranscriber/reportingoption> — `.volatileResults`, `.fastResults` ("faster but also less accurate"), `.alternativeTranscriptions`.
- ResultAttributeOption — <https://developer.apple.com/documentation/speech/speechtranscriber/resultattributeoption> — `.audioTimeRange` (time-codes in the attributed string), `.transcriptionConfidence`.
- TranscriptionOption — <https://developer.apple.com/documentation/speech/speechtranscriber/transcriptionoption> — `.etiquetteReplacements` (profanity redaction).
- Presets — <https://developer.apple.com/documentation/speech/speechtranscriber/preset> — `.transcription`, `.transcriptionWithAlternatives`, `.timeIndexedTranscriptionWithAlternatives`, `.progressiveTranscription`, `.timeIndexedProgressiveTranscription`. Composable: `preset.transcriptionOptions.union([...])`. NOTE: the WWDC video's `.offlineTranscription` does not exist in the shipping SDK — use `.transcription`.
- Result — <https://developer.apple.com/documentation/speech/speechtranscriber/result> — `text: AttributedString`, `alternatives: [AttributedString]`, `range: CMTimeRange`, `isFinal: Bool`, `resultsFinalizationTime: CMTime`. "The phrases are sent in order."

## 4. AssetInventory / locale management

<https://developer.apple.com/documentation/speech/assetinventory>

- "Before using the SpeechAnalyzer class, you must install assets required by the modules you plan to use." Assets are system-managed, shared across apps, auto-updated. "The system may unsubscribe your app from assets that haven't been used in a while."
- Install flow: create modules in desired config → reservations auto-assigned (manual: `reserve(locale:)`) → `assetInstallationRequest(supporting:)` → `downloadAndInstall()`.
- "The system consolidates download and installation requests; you may obtain several of these instances and call `downloadAndInstall()` several times without causing redundant downloads" (<https://developer.apple.com/documentation/speech/assetinstallationrequest>) — i.e., always calling it is safe and idempotent.
- `status(forModules:)` → `.installed / .downloading / .supported / .unsupported` — <https://developer.apple.com/documentation/speech/assetinventory/status>
- `release(reservedLocale:)`, `reservedLocales`, `maximumReservedLocales`.
- NAMING CAVEAT: WWDC video says `allocate/deallocate/allocatedLocales`; shipping API is `reserve/release/reservedLocales`. Trust docs + sample over the video.

## 5. Progress reporting (long files)

No percent-complete API for analysis itself. Documented mechanisms:

- `Result.resultsFinalizationTime` per result vs file duration (the mechanism yap uses)
- `volatileRangeChangedHandler: (CMTimeRange, changedStart: Bool, changedEnd: Bool)` / `volatileRange` — <https://developer.apple.com/documentation/speech/speechanalyzer/volatilerange>
- `AssetInstallationRequest.progress` (a `Progress`) for model downloads
- `prepareToAnalyze(in:withProgressReadyHandler:)` for preheat progress

## 6. Official sample code

<https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app> (zip: <https://docs-assets.developer.apple.com/published/e40c20fc5641/BringingAdvancedSpeechToTextCapabilitiesToYourApp.zip>), companion to WWDC25 session 277.

Key patterns (`Transcription.swift`, `BufferConversion.swift`):

- `ensureModel`: check `supportedLocales`/`installedLocales` comparing `locale.identifier(.bcp47)`, then `assetInstallationRequest` → `downloadAndInstall()`.
- Results task started BEFORE `analyzer.start(...)`; branch on `result.isFinal`.
- Finish: `inputBuilder?.finish()` → `finalizeAndFinishThroughEndOfInput()` → cancel results task.
- Cleanup: iterate `AssetInventory.reservedLocales` calling `release(reservedLocale:)`.
- `BufferConverter`: `AVAudioConverter`, `primeMethod = .none` ("Sacrifice quality of first samples in order to avoid any timestamp drift from source").

## 7. WWDC25 Session 277

<https://developer.apple.com/videos/play/wwdc2025/277/> — "Bring advanced speech-to-text to your app with SpeechAnalyzer"

- SpeechAnalyzer replaces SFSpeechRecognizer; on-device; "especially good for long-form and distant audio"; powers Notes/Voice Memos/Journal.
- File-transcription pattern shown at 5:21: results consumer via `async let ... transcriber.results.reduce(...)`, then `analyzeSequence(from:)` → `finalizeAndFinish(through:)` (or `cancelAndFinishNow()` if nil).
- All operations scheduled by audio-timeline time-code, "predictable order independent of call timing."
- For files: no volatile results needed. For live: `.volatileResults` + `.audioTimeRange`.
- Models live in system storage (no app-bundle bloat); an app is "limited to a certain number of languages at once."

## 8. Video containers (.mp4/.mov) — the honest answer

- No official macOS-26-era statement found saying `AVAudioFile` can or cannot open video containers. All macOS 26 file-input APIs take `AVAudioFile` only.
- macOS 27 beta adds the official video path: `AssetInputSequenceProvider` ("Reads from an audio file or asset") — <https://developer.apple.com/documentation/speech/assetinputsequenceprovider> — and `AnalyzerInputConverter` — <https://developer.apple.com/documentation/speech/analyzerinputconverter>. Both 27.0+ beta, NOT usable on 26.5.
- On 26.5 the practical options are: (a) `AVAudioFile(forReading:)` directly on the video — **verified working on this machine with a real mp4 on 2026-07-27** and the approach used by yap (1.5k ⭐); (b) `AVAssetReader`/`AVAssetExportSession` extraction as fallback (general guidance: <https://developer.apple.com/forums/thread/768883>).

## 9. Concurrency facts

- `final actor SpeechAnalyzer` — all methods actor-isolated async.
- `protocol SpeechModule: AnyObject, Sendable` — <https://developer.apple.com/documentation/speech/speechmodule> — transcribers safely cross tasks.
- Docs design for: input production in one Task, result consumption in another, `analyzeSequence` awaited in a third. No extra locking needed.

## 10. Errors

<https://developer.apple.com/documentation/speech/sfspeecherror/code> — relevant `SFSpeechError.Code` cases: `.audioReadFailed`, `.audioDisordered`, `.incompatibleAudioFormats`, `.unexpectedAudioFormat`, `.assetLocaleNotAllocated`, `.cannotAllocateUnsupportedLocale`, `.tooManyAssetLocalesAllocated`, `.noModel`, `.timeout`, `.insufficientResources`, `.internalServiceError`, `.moduleOutputFailed`, `.cannotConfigureAudioSystem`.

## 11. Forum threads (load-bearing)

- <https://developer.apple.com/forums/thread/790108> — "Cannot use modules with unallocated locales". OFFICIAL Apple engineer reply (Jul 2025): locales from `supportedLocales` work, but "arbitrary locales such as `Locale.current` or `Locale(identifier: "en_US")` may not, because the exact equality of locales differ depending on how they were created" — normalize via `SpeechTranscriber.supportedLocale(equivalentTo:)`; compare `.identifier(.bcp47)` (underscore-vs-hyphen mismatch is the root cause). THIRD-PARTY in-thread: skip the installed check and always call `assetInstallationRequest` (safe; requests are consolidated).
- <https://developer.apple.com/forums/thread/818005> — `start(inputSequence:)` fails with `nilError` on macOS 26.3 while the file path succeeds (FB22149971, unresolved). Takeaway: **the AVAudioFile path is the battle-tested one on macOS 26.x** — another reason to prefer it for our service.

## 12. Third-party recaps (supplementary)

- <https://antongubarenko.substack.com/p/ios-26-speechanalyzer-guide>
- <https://appcircle.io/blog/wwdc25-bring-advanced-speech-to-text-capabilities-to-your-app-with-speechanalyzer>

---

## Bottom-line documented recipe for a macOS 26.5 file-transcription service

1. Normalize locale via `SpeechTranscriber.supportedLocale(equivalentTo:)`; compare BCP-47.
2. `SpeechTranscriber(locale:, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])` — no volatile results for files.
3. Always run `assetInstallationRequest(supporting:)` → `downloadAndInstall()` (idempotent); observe `progress`.
4. Open the video directly with `AVAudioFile(forReading:)` (verified on 26.5); `AVAssetReader`/export fallback only if needed.
5. Start the `results` consumer task FIRST, then `analyzeSequence(from:)` → `finalizeAndFinish(through:)` (or `cancelAndFinishNow()` if nil).
6. Progress = `resultsFinalizationTime / fileDuration`.
7. Map `SFSpeechError.Code` to friendly errors; on stream error, discard the analyzer and create a new one.
8. Release reserved locales when no longer needed; respect `maximumReservedLocales`.
