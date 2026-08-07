import AVFoundation
import Foundation
import Speech

/// A helper-level error carrying the friendly `code`/`message` pair emitted in
/// the final `error` NDJSON event (spec §6). Thrown deliberately by our own
/// checks (bad locale, missing file, no audio track) as well as produced by
/// mapping caught `SFSpeechError`s.
struct HelperError: Error {
    let code: String
    let message: String
}

/// Maps any error thrown during transcription to a `(code, message)` pair for
/// the `error` NDJSON event. `SFSpeechError.Code` cases map to spec §6's named
/// codes; CoreAudio's "no audio track" NSError (verified empirically in
/// docs/research/spikes) maps to `audioReadFailed`; everything else falls back
/// to a generic code carrying the underlying description so failures are
/// never silently swallowed.
func mapToHelperError(_ error: Error) -> HelperError {
    if let helperError = error as? HelperError {
        return helperError
    }

    if let speechError = error as? SFSpeechError {
        return HelperError(
            code: code(for: speechError.code), message: speechError.localizedDescription)
    }

    let nsError = error as NSError
    // CoreAudio reports "no audio track"/unreadable format as an OSStatus
    // packed into an NSError rather than as SFSpeechError. Verified on this
    // machine: a video with no audio track fails AVAudioFile(forReading:) with
    // domain "com.apple.coreaudio.avfaudio", code 1685348671 ('dta?'). Also
    // catch the NSOSStatusErrorDomain/AVFoundationErrorDomain spellings some
    // AVFoundation call sites use for the same class of failure.
    let domainIndicatesAudioOpenFailure =
        nsError.domain == NSOSStatusErrorDomain
        || nsError.domain == AVFoundationErrorDomain
        || nsError.domain.localizedCaseInsensitiveContains("coreaudio")
    if domainIndicatesAudioOpenFailure {
        return HelperError(
            code: "audioReadFailed",
            message:
                "Could not read an audio track from the input file: \(nsError.localizedDescription)"
        )
    }

    return HelperError(code: "unknown", message: nsError.localizedDescription)
}

private func code(for speechErrorCode: SFSpeechError.Code) -> String {
    switch speechErrorCode {
    case .internalServiceError: return "internalServiceError"
    case .audioReadFailed: return "audioReadFailed"
    case .timeout: return "timeout"
    case .noModel: return "noModel"
    case .cannotAllocateUnsupportedLocale: return "cannotAllocateUnsupportedLocale"
    case .insufficientResources: return "insufficientResources"
    case .assetLocaleNotAllocated: return "assetLocaleNotAllocated"
    case .tooManyAssetLocalesAllocated: return "tooManyAssetLocalesAllocated"
    case .incompatibleAudioFormats: return "incompatibleAudioFormats"
    case .unexpectedAudioFormat: return "unexpectedAudioFormat"
    case .audioDisordered: return "audioDisordered"
    case .moduleOutputFailed: return "moduleOutputFailed"
    default: return "speechError"
    }
}
