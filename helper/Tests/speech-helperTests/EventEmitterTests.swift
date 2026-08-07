import Foundation
import Testing

@testable import speech_helper

/// Covers review Finding 1: "exactly one terminal event, always last" must be
/// a structural guarantee, not a probabilistic one. These tests exercise
/// `EventEmitter.emit` directly — the single choke point all NDJSON events
/// pass through in production — rather than trying to force the underlying
/// race (a results-consumer task still mid-iteration when the main task
/// throws) from outside the black-box CLI, which isn't reliably reproducible
/// on demand.
///
/// Each test builds its own `EventEmitter()` instance (its initializer isn't
/// private) rather than using `EventEmitter.shared`, so tests don't leak
/// `hasEmittedTerminal` state into one another — matches production usage,
/// where exactly one `EventEmitter` lives for the lifetime of one `transcribe`
/// process.
/// `.serialized`: each test redirects the real process-wide `STDOUT_FILENO`
/// for its duration, which is unsafe under swift-testing's default parallel
/// execution (two tests could dup2 fd 1 concurrently and corrupt each
/// other's capture). Serializing avoids that without complicating the
/// capture helper for a test-only concern.
@Suite(.serialized) struct EventEmitterTests {
    /// Captures everything written to real fd 1 (`STDOUT_FILENO`) during
    /// `body`, by redirecting it to a pipe for the duration of the call.
    /// `EventEmitter` writes via `FileHandle.standardOutput`, which is a
    /// direct wrapper around fd 1, so this observes exactly what a consumer
    /// spawning the helper as a subprocess would see on its stdout pipe.
    private static func capturingStdout(_ body: () throws -> Void) rethrows -> [String] {
        let pipe = Pipe()
        let savedStdout = dup(STDOUT_FILENO)
        dup2(pipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO)

        do {
            try body()
        } catch {
            pipe.fileHandleForWriting.closeFile()
            dup2(savedStdout, STDOUT_FILENO)
            close(savedStdout)
            throw error
        }

        pipe.fileHandleForWriting.closeFile()
        dup2(savedStdout, STDOUT_FILENO)
        close(savedStdout)

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8) ?? ""
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    @Test func errorIsTerminalAndDropsEventsEmittedAfterIt() throws {
        let emitter = EventEmitter()

        let lines = Self.capturingStdout {
            emitter.emit(.ready(durationSec: 6.571))
            emitter.emit(.error(code: "boom", message: "simulated failure"))
            // Simulates the exact race from Finding 1: a results-consumer
            // task that was still mid-iteration when the main task threw and
            // the catch block emitted `.error`, landing one more `progress`
            // event afterwards. Cooperative cancellation does not preempt
            // this, so the guarantee must live in the emitter, not the
            // cancellation call.
            emitter.emit(.progress(stage: "transcribe", pct: 0.9))
            emitter.emit(
                .segment(
                    start: 0, end: 1, text: "should never appear", confidence: nil, lowTokens: []))
            emitter.emit(.done(durationSec: 6.571))
        }

        #expect(lines.count == 2)
        #expect(lines[0].contains("\"type\":\"ready\""))
        #expect(lines[1].contains("\"type\":\"error\""))
        #expect(lines[1].contains("\"code\":\"boom\""))
        // Nothing after the terminal error leaked through, not even another
        // terminal-looking event.
        #expect(!lines.contains { $0.contains("\"type\":\"progress\"") })
        #expect(!lines.contains { $0.contains("\"type\":\"segment\"") })
        #expect(!lines.contains { $0.contains("\"type\":\"done\"") })
    }

    @Test func doneIsTerminalAndDropsEventsEmittedAfterIt() throws {
        let emitter = EventEmitter()

        let lines = Self.capturingStdout {
            emitter.emit(.ready(durationSec: 0))
            emitter.emit(.progress(stage: "transcribe", pct: 1))
            emitter.emit(.done(durationSec: 0))
            // A stray late event after done should also be dropped.
            emitter.emit(.progress(stage: "transcribe", pct: 1))
        }

        #expect(lines.count == 3)
        #expect(lines.last?.contains("\"type\":\"done\"") == true)
    }

    @Test func normalSequenceWithoutATerminalRaceIsUnaffected() throws {
        let emitter = EventEmitter()

        let lines = Self.capturingStdout {
            emitter.emit(.ready(durationSec: 6.571))
            emitter.emit(.modelDownload(progress: 1))
            emitter.emit(.progress(stage: "transcribe", pct: 0.447))
            emitter.emit(
                .segment(
                    start: 0, end: 2.88, text: "The quick brown fox jumps over the lazy dog.",
                    confidence: nil, lowTokens: []))
            emitter.emit(.done(durationSec: 6.571))
        }

        #expect(lines.count == 5)
        #expect(lines.last?.contains("\"type\":\"done\"") == true)
    }

    /// Task 2: diarization's `speakers` and `warning` events must land BEFORE
    /// the terminal `done`/`error`, per the interface note in the task brief
    /// ("emit your warning and speakers events BEFORE the terminal event").
    /// This exercises the wire shape of `.speakers` (segments array + count)
    /// and confirms it composes with the existing terminal-event guarantee
    /// rather than special-casing it.
    @Test func speakersAndWarningAreNotTerminalAndPrecedeDone() throws {
        let emitter = EventEmitter()

        let lines = Self.capturingStdout {
            emitter.emit(.ready(durationSec: 41.698))
            emitter.emit(.progress(stage: "transcribe", pct: 1))
            emitter.emit(.progress(stage: "diarize", pct: 1))
            emitter.emit(
                .speakers(
                    segments: [
                        SpeakerTurnPayload(start: 0.0, end: 5.8, speaker: "S1"),
                        SpeakerTurnPayload(start: 6.4, end: 12.1, speaker: "S2"),
                    ],
                    count: 2
                ))
            emitter.emit(.done(durationSec: 41.698))
            // A stray post-terminal speakers event should also be dropped.
            emitter.emit(.speakers(segments: [], count: 0))
        }

        #expect(lines.count == 5)
        #expect(lines[3].contains("\"type\":\"speakers\""))
        #expect(lines[3].contains("\"count\":2"))
        #expect(lines[3].contains("\"speaker\":\"S1\""))
        #expect(lines[3].contains("\"speaker\":\"S2\""))
        #expect(lines.last?.contains("\"type\":\"done\"") == true)
    }

    @Test func warningIsNotTerminalAndPrecedesDone() throws {
        let emitter = EventEmitter()

        let lines = Self.capturingStdout {
            emitter.emit(.ready(durationSec: 10))
            emitter.emit(
                .warning(code: "diarizationFailed", message: "simulated model download failure"))
            emitter.emit(.done(durationSec: 10))
        }

        #expect(lines.count == 3)
        #expect(lines[1].contains("\"type\":\"warning\""))
        #expect(lines[1].contains("\"code\":\"diarizationFailed\""))
        #expect(lines.last?.contains("\"type\":\"done\"") == true)
    }
}
