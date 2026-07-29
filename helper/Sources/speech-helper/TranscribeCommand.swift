import ArgumentParser
import AVFoundation
import CoreMedia
import Foundation
import Speech

/// `speech-helper transcribe --input <path> --locale <bcp47> [--no-diarize]`
/// — spec §4. Implements the transcription core only (Task 1); diarization
/// (spec §4 items 7-8, §8) arrives in Task 2. `--no-diarize` is accepted here
/// as a no-op beyond suppressing nothing yet, since no diarize-stage events
/// are emitted regardless.
struct TranscribeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "transcribe",
        abstract: "Transcribe a local media file, emitting NDJSON events to stdout."
    )

    @Option(name: .long, help: "Path to the input media file (video or audio).")
    var input: String

    @Option(name: .long, help: "BCP-47 locale for transcription, e.g. en-US.")
    var locale: String

    @Flag(name: .customLong("no-diarize"), help: "Skip diarization. No-op in this build (diarization ships in Task 2).")
    var noDiarize: Bool = false

    func run() async throws {
        if noDiarize {
            logStderr("--no-diarize passed; diarization is not implemented in this build, so this has no additional effect.")
        }

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
                throw HelperError(code: "noModel", message: "SpeechTranscriber is not available on this device.")
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

            if let lastSample = try await analyzer.analyzeSequence(from: prepared.audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }

            let transcript = try await task.value

            for segment in transcript.sentenceSegments() {
                EventEmitter.shared.emit(.segment(start: segment.start, end: segment.end, text: segment.text))
            }

            EventEmitter.shared.emit(.progress(stage: "transcribe", pct: 1.0))
            EventEmitter.shared.emit(.done(durationSec: roundedToMillisecond(prepared.durationSec)))
        } catch {
            let helperError = mapToHelperError(error)
            EventEmitter.shared.emit(.error(code: helperError.code, message: helperError.message))
            throw ExitCode.failure
        }
    }
}
