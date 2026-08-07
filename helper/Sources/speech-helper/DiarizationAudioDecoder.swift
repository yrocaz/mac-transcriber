@preconcurrency import AVFoundation
import Foundation

/// Decodes the prepared audio URL to 16 kHz mono Float32 samples for
/// FluidAudio's `OfflineDiarizerManager.process(audio:)` — spec §4 item 7.
///
/// Deliberately hand-rolled with `AVAudioConverter` directly, rather than
/// FluidAudio's own bundled `AudioConverter` helper (which does the same
/// 16kHz/mono/Float32 conversion but never sets `primeMethod`): the spec's
/// recipe calls for `primeMethod = .none` explicitly — "Apple-sample
/// BufferConverter pattern" (docs/research/2026-07-27-apple-speechanalyzer-docs.md),
/// the same one AuralKit's `BufferConverter` and swift-scribe's
/// `Transcription.swift` use for buffer-based conversion — "sacrifice quality
/// of the first samples in order to avoid any timestamp drift from source".
///
/// Reads the whole prepared file into a single `AVAudioPCMBuffer` up front
/// (jobs here are personal-pipeline scale per the design doc, not hours-long
/// broadcasts) and converts it in one pass, draining the converter in a loop
/// until it reports `.endOfStream` — the standard `AVAudioConverter`
/// single-buffer-source pattern.
///
/// Errors thrown here carry `HelperError(code: "diarizationDecodeFailed", ...)`
/// — deliberately distinct from the wire-level `diarizationFailed` warning
/// code (spec §8), which every caller currently normalizes to via `.message`
/// only (`TranscribeCommand`'s diarization `catch` block). Keeping the codes
/// distinct means a future caller that surfaces `HelperError.code` directly
/// won't accidentally emit an out-of-taxonomy `diarizationFailed` in the
/// `error` event's `code` slot (spec §6 doesn't list it there).
enum DiarizationAudioDecoder {
    static let targetSampleRate: Double = 16_000

    static func decode(_ url: URL) throws -> [Float] {
        let audioFile = try AVAudioFile(forReading: url)
        let sourceFormat = audioFile.processingFormat

        guard audioFile.length > 0 else { return [] }

        guard
            let inputBuffer = AVAudioPCMBuffer(
                pcmFormat: sourceFormat,
                frameCapacity: AVAudioFrameCount(audioFile.length)
            )
        else {
            throw HelperError(
                code: "diarizationDecodeFailed",
                message: "Could not allocate an input buffer to decode audio for diarization.")
        }
        try audioFile.read(into: inputBuffer)

        guard
            let targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: targetSampleRate,
                channels: 1,
                interleaved: false
            )
        else {
            throw HelperError(
                code: "diarizationDecodeFailed",
                message: "Could not construct the 16 kHz mono target audio format.")
        }

        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw HelperError(
                code: "diarizationDecodeFailed",
                message: "Could not create an audio converter for diarization input.")
        }
        converter.primeMethod = .none

        // `AVAudioConverterInputBlock` is `@Sendable`, so a plain `var` flag
        // trips the compiler's concurrency checks even though `convert(to:)`
        // invokes it synchronously on the calling thread. `NSLock`-guarded,
        // matching `EventEmitter`'s pattern elsewhere in this target, rather
        // than reasoning about whether that synchronity is guaranteed to
        // hold across `AVAudioConverter` versions.
        let inputConsumed = Locked(false)
        var samples: [Float] = []
        let estimatedCount =
            Int(Double(inputBuffer.frameLength) * (targetSampleRate / sourceFormat.sampleRate))
            + 4096
        samples.reserveCapacity(estimatedCount)

        while true {
            guard
                let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 32_768)
            else {
                throw HelperError(
                    code: "diarizationDecodeFailed",
                    message: "Could not allocate a conversion output buffer.")
            }

            var conversionError: NSError?
            let status = converter.convert(to: outputBuffer, error: &conversionError) {
                _, inputStatus in
                let alreadyConsumed = inputConsumed.exchange(true)
                if alreadyConsumed {
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                inputStatus.pointee = .haveData
                return inputBuffer
            }

            if let channelData = outputBuffer.floatChannelData, outputBuffer.frameLength > 0 {
                samples.append(
                    contentsOf: UnsafeBufferPointer(
                        start: channelData[0], count: Int(outputBuffer.frameLength)))
            }

            switch status {
            case .error:
                throw conversionError
                    ?? HelperError(
                        code: "diarizationDecodeFailed",
                        message: "Audio conversion failed while decoding for diarization.")
            case .endOfStream:
                return samples
            case .haveData, .inputRanDry:
                continue
            @unknown default:
                return samples
            }
        }
    }
}

/// Minimal `NSLock`-guarded box, used above only to satisfy Swift 6's
/// `@Sendable` closure checking for a flag mutated inside
/// `AVAudioConverterInputBlock`.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    /// Atomically sets `value` to `newValue`, returning what it was before.
    func exchange(_ newValue: Value) -> Value {
        lock.lock()
        defer { lock.unlock() }
        let old = value
        value = newValue
        return old
    }
}
