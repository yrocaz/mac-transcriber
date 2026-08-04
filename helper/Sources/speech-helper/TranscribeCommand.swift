import ArgumentParser
import AVFoundation
import CoreMedia
import Foundation
import Speech

/// `speech-helper transcribe --input <path> --locale <bcp47> [--no-diarize]`
/// — spec §4. Transcription (Task 1) plus diarization (spec §4 items 7-8,
/// §8): after transcription, the prepared audio is diarized via FluidAudio's
/// `OfflineDiarizerManager`, emitting `progress{stage:"diarize"}` and a
/// `speakers` event. `--no-diarize` skips the stage entirely — no diarize
/// progress, no `speakers` event. Diarization failures never fail the job:
/// any error is reported as a `warning{code:"diarizationFailed"}` and the job
/// still completes with a normal `done`.
struct TranscribeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "transcribe",
        abstract: "Transcribe a local media file, emitting NDJSON events to stdout."
    )

    @Option(name: .long, help: "Path to the input media file (video or audio).")
    var input: String

    @Option(name: .long, help: "BCP-47 locale for transcription, e.g. en-US.")
    var locale: String

    @Flag(name: .customLong("no-diarize"), help: "Skip diarization entirely: no diarize-stage progress events, no speakers event.")
    var noDiarize: Bool = false

    func run() async throws {
        let inputURL = URL(fileURLWithPath: input)
        var preparedAudio: PreparedAudio?
        // Cleanup runs exactly once at exit, on both the success and failure
        // paths, per spec §4 item 6.
        defer { preparedAudio?.cleanup() }

        // Held outside the `do` scope so the `catch` below can cancel it: if
        // analyzeSequence/finalizeAndFinish throws, this task is still live
        // and could otherwise emit a stray `progress` line after the final
        // `error` event.
        var resultsTask: Task<AttributedString, Error>?
        defer { resultsTask?.cancel() }

        do {
            guard FileManager.default.fileExists(atPath: inputURL.path) else {
                throw HelperError(code: "fileNotFound", message: "No such file: \(inputURL.path)")
            }

            guard SpeechTranscriber.isAvailable else {
                // Distinct from spec §6's `noModel` (missing model assets,
                // recoverable by downloading) — `unavailable` means the
                // SpeechTranscriber API itself isn't usable on this device at
                // all, so the server can branch on the two differently.
                throw HelperError(code: "unavailable", message: "SpeechTranscriber is not available on this device.")
            }

            let resolvedLocale = try await LocaleResolver.resolve(locale)

            // Input preparation happens once, before `ready`: the resulting
            // prepared URL (original path, or repaired temp M4A) is the single
            // input used by every stage.
            let prepared = try await PreparedAudio.prepare(inputURL)
            preparedAudio = prepared

            EventEmitter.shared.emit(.ready(durationSec: roundedToMillisecond(prepared.durationSec)))

            for reserved in await AssetInventory.reservedLocales {
                await AssetInventory.release(reservedLocale: reserved)
            }
            try await AssetInventory.reserve(locale: resolvedLocale)

            let transcriber = SpeechTranscriber(
                locale: resolvedLocale,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: [.audioTimeRange]
            )
            let modules: [any SpeechModule] = [transcriber]

            // Always call assetInstallationRequest — documented idempotent
            // and consolidated, so this is safe even when already installed.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                let progress = request.progress
                let observation = progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
                    EventEmitter.shared.emit(.modelDownload(progress: roundedToMillisecond(progress.fractionCompleted)))
                }
                defer { observation.invalidate() }
                try await request.downloadAndInstall()
            }

            let analyzer = SpeechAnalyzer(modules: modules)
            let durationSec = prepared.durationSec

            // Results consumer task MUST start before driving the analyzer,
            // or results are dropped (spec §4 item 4).
            let task = Task<AttributedString, Error> {
                var transcript = AttributedString("")
                for try await result in transcriber.results {
                    transcript.append(result.text)
                    if durationSec > 0 {
                        let pct = min(max(result.resultsFinalizationTime.seconds / durationSec, 0), 1)
                        EventEmitter.shared.emit(.progress(stage: "transcribe", pct: roundedToMillisecond(pct)))
                    }
                }
                return transcript
            }
            resultsTask = task

            let transcript: AttributedString
            if let lastSample = try await analyzer.analyzeSequence(from: prepared.audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
                transcript = try await task.value
            } else {
                // analyzeSequence returned nil: the file had no audio to feed
                // the analyzer (e.g. zero-length/empty). This is a documented,
                // expected outcome (spec's recipe explicitly calls for
                // cancelAndFinishNow() here), not a failure — it must still
                // resolve as a clean `done` with zero segments, not an
                // `error`. cancelAndFinishNow() closes the results stream via
                // cancellation, which can surface as CancellationError (or
                // simply an empty/incomplete result) from the still-running
                // results-consumer task; `try?` swallows that deliberately
                // rather than letting it propagate to the outer catch, where
                // mapToHelperError has no CancellationError case and would
                // otherwise turn this into a spurious `error{code:"unknown"}`.
                await analyzer.cancelAndFinishNow()
                task.cancel()
                transcript = (try? await task.value) ?? AttributedString("")
            }

            for segment in transcript.sentenceSegments() {
                EventEmitter.shared.emit(.segment(start: segment.start, end: segment.end, text: segment.text))
            }

            EventEmitter.shared.emit(.progress(stage: "transcribe", pct: 1.0))

            // Diarization (spec §4 items 7-8, §8): non-fatal by design. Any
            // failure here — model download, decode, processing — degrades to
            // a `warning` rather than failing the job; the transcript
            // produced above is delivered intact either way.
            if !noDiarize {
                do {
                    // KEEPALIVE (spec §6, Critical 1): unlike Apple's
                    // AssetInventory path above (KVO-driven, reports its own
                    // `model_download` progress), FluidAudio's diarization
                    // model download + `prepareModels()` emits nothing on
                    // stdout at all — that silent window can exceed the
                    // server's 120s inactivity budget on a slow/first-run
                    // connection and kill an otherwise-healthy job. Emit a
                    // diarize-stage tick immediately, then keep ticking every
                    // 20s (well under the 120s budget) until diarize's own
                    // progress callback reports real activity. `pct: 0` is a
                    // MonotonicProgress no-op (server/src/progress.ts) once
                    // transcribe has already reached 1.0, so this never moves
                    // overall progress. Scoped to this `do` block and stopped
                    // via `defer` so the ticker provably cannot emit after
                    // the terminal `done` below (spec's "exactly one terminal
                    // event, always last" guarantee) — EventEmitter's own
                    // post-terminal guard is a backstop, not relied on alone.
                    EventEmitter.shared.emit(.progress(stage: "diarize", pct: 0))
                    let keepAlive = KeepAliveTicker(intervalSec: 20) {
                        EventEmitter.shared.emit(.progress(stage: "diarize", pct: 0))
                    }
                    keepAlive.start()
                    defer { keepAlive.stop() }

                    let turns = try await SpeakerDiarizer.diarize(prepared.url) { chunksProcessed, totalChunks in
                        // Real progress has started arriving: the silent
                        // window is over, so stop ticking.
                        keepAlive.stop()
                        let pct = totalChunks > 0 ? Double(chunksProcessed) / Double(totalChunks) : 1.0
                        EventEmitter.shared.emit(.progress(stage: "diarize", pct: roundedToMillisecond(min(max(pct, 0), 1))))
                    }
                    EventEmitter.shared.emit(.progress(stage: "diarize", pct: 1.0))

                    let payload = turns.map { SpeakerTurnPayload(start: $0.start, end: $0.end, speaker: $0.speaker) }
                    let speakerCount = Set(turns.map(\.speaker)).count
                    EventEmitter.shared.emit(.speakers(segments: payload, count: speakerCount))
                } catch {
                    // Deliberately not `mapToHelperError`'s code taxonomy
                    // (noModel/unavailable/etc. are for the transcription
                    // engine) — every diarization failure collapses to the
                    // single `diarizationFailed` warning code per spec §8,
                    // reusing only its message-extraction behavior.
                    let message = mapToHelperError(error).message
                    logStderr("Diarization failed, degrading to warning: \(message)")
                    EventEmitter.shared.emit(.warning(code: "diarizationFailed", message: message))
                }
            }

            EventEmitter.shared.emit(.done(durationSec: roundedToMillisecond(prepared.durationSec)))
        } catch {
            let helperError = mapToHelperError(error)
            EventEmitter.shared.emit(.error(code: helperError.code, message: helperError.message))
            throw ExitCode.failure
        }
    }
}
