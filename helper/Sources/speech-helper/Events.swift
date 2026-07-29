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
        case let .warning(code, message):
            return ["type": "warning", "code": code, "message": message]
        case let .done(durationSec):
            return ["type": "done", "durationSec": durationSec]
        case let .error(code, message):
            return ["type": "error", "code": code, "message": message]
        }
    }
}

/// Writes NDJSON events to stdout, unbuffered (a direct `write(2)` per line via
/// `FileHandle`, bypassing C stdio buffering), serialized so concurrent emitters
/// (the main analysis task and the AssetInstallationRequest progress KVO
/// callback, which fires on an arbitrary thread) never interleave a line.
final class EventEmitter: @unchecked Sendable {
    static let shared = EventEmitter()

    private let lock = NSLock()
    private let stdout = FileHandle.standardOutput

    func emit(_ event: Event) {
        guard let data = try? JSONSerialization.data(withJSONObject: event.json, options: [.sortedKeys]) else {
            return
        }
        var line = data
        line.append(0x0A) // '\n'
        lock.lock()
        defer { lock.unlock() }
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
