import AVFoundation
import Foundation

/// The single input file used by every stage (transcription today, diarization
/// in Task 2): either the original path, or a repaired temp M4A when the
/// original was a malformed MP3. Prepared once, before the `ready` event;
/// cleaned up once, after all stages finish (success or failure) — spec §4
/// item 6.
///
/// MP3 repair sequence is yap's `TranscriptionAudioFile` (CC0-1.0), copied
/// verbatim in approach: <https://github.com/finnvoor/yap/blob/main/Sources/yap/TranscriptionAudioFile.swift>
/// — some MP3s misreport their packet count, which makes `SpeechAnalyzer` fail
/// with `eofErr`; probing whether the last ≤4096 frames actually read detects
/// this before it becomes a hard-to-diagnose analyzer failure.
struct PreparedAudio {
    let url: URL
    let audioFile: AVAudioFile
    private let temporaryURL: URL?

    var durationSec: Double {
        Double(audioFile.length) / audioFile.processingFormat.sampleRate
    }

    static func prepare(_ inputURL: URL) async throws -> PreparedAudio {
        let audioFile: AVAudioFile
        do {
            audioFile = try AVAudioFile(forReading: inputURL)
        } catch {
            throw mapToHelperError(error)
        }

        guard audioFile.fileFormat.streamDescription.pointee.mFormatID == kAudioFormatMPEGLayer3,
              (try? hasMissingFrames(at: inputURL, expectedLength: audioFile.length)) == true
        else {
            return PreparedAudio(url: inputURL, audioFile: audioFile, temporaryURL: nil)
        }

        logStderr("MP3 tail-probe detected a misreported packet count; repairing via M4A re-export")
        return try await repair(inputURL)
    }

    /// Removes the temp M4A if one was created. Safe to call multiple times.
    func cleanup() {
        guard let temporaryURL else { return }
        try? FileManager.default.removeItem(at: temporaryURL)
    }

    private static func repair(_ inputURL: URL) async throws -> PreparedAudio {
        let temporaryURL = FileManager.default.temporaryDirectory
            .appending(path: "speech-helper-\(UUID().uuidString)")
            .appendingPathExtension("m4a")

        do {
            let asset = AVURLAsset(url: inputURL)
            guard let exportSession = AVAssetExportSession(
                asset: asset,
                presetName: AVAssetExportPresetAppleM4A
            ) else {
                throw HelperError(code: "audioReadFailed", message: "Could not create an export session to repair the MP3 input.")
            }
            try await exportSession.export(to: temporaryURL, as: .m4a)
            let repairedFile = try AVAudioFile(forReading: temporaryURL)
            return PreparedAudio(url: temporaryURL, audioFile: repairedFile, temporaryURL: temporaryURL)
        } catch {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw mapToHelperError(error)
        }
    }

    /// Probing changes the decoder's position, so a fresh `AVAudioFile` handle
    /// is used purely for the probe (yap's approach) — the caller's own handle
    /// is left untouched.
    private static func hasMissingFrames(at url: URL, expectedLength: AVAudioFramePosition) throws -> Bool {
        let frameCount = AVAudioFrameCount(min(expectedLength, 4_096))
        guard frameCount > 0 else { return false }

        let probe = try AVAudioFile(forReading: url)
        probe.framePosition = expectedLength - AVAudioFramePosition(frameCount)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: probe.processingFormat, frameCapacity: frameCount) else {
            return false
        }

        do {
            try probe.read(into: buffer, frameCount: frameCount)
            return buffer.frameLength < frameCount
        } catch {
            return true
        }
    }
}
