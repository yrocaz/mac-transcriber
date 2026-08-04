import Foundation

/// NDJSON events emitted on stdout, one JSON object per line, per spec §4.
///
/// Field sets vary by event type, so each case encodes its own dictionary
/// rather than sharing one Codable struct with a pile of optionals.
enum Event {
    case ready(durationSec: Decimal)
    case modelDownload(progress: Decimal)
    case progress(stage: String, pct: Decimal)
    case segment(start: Decimal, end: Decimal, text: String)
    case speakers(segments: [SpeakerTurnPayload], count: Int)
    case warning(code: String, message: String)
    case done(durationSec: Decimal)
    case error(code: String, message: String)

    var json: [String: Any] {
        switch self {
        case let .ready(durationSec):
            return ["type": "ready", "durationSec": durationSec]
        case let .modelDownload(progress):
            return ["type": "model_download", "progress": progress]
        case let .progress(stage, pct):
            return ["type": "progress", "stage": stage, "pct": pct]
        case let .segment(start, end, text):
            return ["type": "segment", "start": start, "end": end, "text": text]
        case let .speakers(segments, count):
            return ["type": "speakers", "segments": segments.map(\.json), "count": count]
        case let .warning(code, message):
            return ["type": "warning", "code": code, "message": message]
        case let .done(durationSec):
            return ["type": "done", "durationSec": durationSec]
        case let .error(code, message):
            return ["type": "error", "code": code, "message": message]
        }
    }
}

/// One diarized speaker turn, as carried in the `speakers` event's `segments`
/// array (spec §4: `{"start":0.0,"end":12.3,"speaker":"S1"}`). Raw diarization
/// output — NOT merged with transcript sentences; that overlap merge is the
/// server's job (spec §7's "speaker-overlap merge logic" TS unit test).
struct SpeakerTurnPayload {
    let start: Decimal
    let end: Decimal
    let speaker: String

    var json: [String: Any] {
        ["start": start, "end": end, "speaker": speaker]
    }
}

/// Writes NDJSON events to stdout, unbuffered (a direct `write(2)` per line via
/// `FileHandle`, bypassing C stdio buffering), serialized so concurrent emitters
/// (the main analysis task and the AssetInstallationRequest progress KVO
/// callback, which fires on an arbitrary thread) never interleave a line.
///
/// Also enforces "exactly one terminal event, always last" as a structural
/// invariant rather than a probabilistic one: once a `.done` or `.error` has
/// been emitted, every subsequent `emit` call is dropped, under the same lock
/// that serializes the writes. This closes the window where a results-consumer
/// task that's still mid-iteration when the main task throws could otherwise
/// land a stray `progress` line after the terminal `error` line — cooperative
/// cancellation (`Task.cancel()`) does not preempt an already-running
/// iteration, so relying on cancellation alone to prevent this is not
/// sufficient. Task 3's server relies on "error/done is always the last
/// line," so the guarantee is made real here, at the single choke point all
/// events pass through.
final class EventEmitter: @unchecked Sendable {
    static let shared = EventEmitter()

    private let lock = NSLock()
    private let stdout = FileHandle.standardOutput
    private var hasEmittedTerminal = false

    func emit(_ event: Event) {
        lock.lock()
        defer { lock.unlock() }

        guard !hasEmittedTerminal else { return }

        switch event {
        case .done, .error:
            hasEmittedTerminal = true
        default:
            break
        }

        guard let data = try? JSONSerialization.data(withJSONObject: event.json, options: [.sortedKeys]) else {
            return
        }
        var line = data
        line.append(0x0A) // '\n'
        stdout.write(line)
    }
}

/// Human-readable diagnostic noise goes to stderr only — never stdout, which is
/// reserved exclusively for NDJSON events.
func logStderr(_ message: String) {
    let line = message + "\n"
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}
