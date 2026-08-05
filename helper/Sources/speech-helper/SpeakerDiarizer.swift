import FluidAudio
import Foundation

/// Wraps FluidAudio's offline diarization pipeline (spec §4 item 7, §8):
/// Pyannote Community-1 (powerset segmentation + WeSpeaker embeddings + VBx
/// clustering) via `OfflineDiarizerManager`, the batch-appropriate offline
/// pipeline — NOT the streaming diarizers (LS-EEND, Sortformer, legacy
/// Pyannote 3.1).
///
/// Emits raw speaker turn segments only. The helper does NOT merge these with
/// transcript sentences — that maximum-overlap merge is the server's job
/// (spec §7 lists "speaker-overlap merge logic" as a separate TS unit test;
/// the NDJSON contract in spec §4 emits `segment` and `speakers` as two
/// distinct event types with no speaker field on `segment`).
enum SpeakerDiarizer {
    struct SpeakerTurn {
        let start: Decimal
        let end: Decimal
        let speaker: String
    }

    /// Decodes `url` to 16 kHz mono Float32 (`DiarizationAudioDecoder`), then
    /// runs `prepareModels()` → `process(audio:)`. Progress is reported via
    /// FluidAudio's own `(chunksProcessed, totalChunks)` callback.
    ///
    /// Empty decoded audio returns `[]` rather than throwing — mirrors Task
    /// 1's "empty file produces a clean `done` with zero segments" rule for
    /// transcription. The caller (`TranscribeCommand`) still emits a
    /// `speakers` event in this case, just with `count: 0` and no `warning` —
    /// a legitimate "nothing to diarize" outcome, not a degraded/failed one.
    /// Consumers of the NDJSON stream should not assume `count >= 1`
    /// whenever a `speakers` event is present.
    /// Optional caller-supplied bounds on the speaker count. FluidAudio's
    /// defaults are all nil (fully automatic clustering), which under-clusters
    /// on real multi-party audio: a 5-person panel measured 2026-08-05 came
    /// back as 3 speakers, one merged cluster absorbing 27 of 41 talking
    /// minutes. Telling the clusterer how many voices to expect is the
    /// remedy FluidAudio exposes; `exact` overrides `min`/`max` in its own
    /// implementation, so it is passed through unchanged rather than
    /// reconciled here.
    struct SpeakerHint {
        var exact: Int?
        var min: Int?
        var max: Int?

        var isEmpty: Bool { exact == nil && min == nil && max == nil }
    }

    static func diarize(
        _ url: URL,
        hint: SpeakerHint = SpeakerHint(),
        progress: @escaping @Sendable (Int, Int) -> Void
    ) async throws -> [SpeakerTurn] {
        let samples = try DiarizationAudioDecoder.decode(url)
        guard !samples.isEmpty else { return [] }

        var config = OfflineDiarizerConfig.default
        if !hint.isEmpty {
            config.clustering.numSpeakers = hint.exact
            config.clustering.minSpeakers = hint.min
            config.clustering.maxSpeakers = hint.max
        }
        let manager = OfflineDiarizerManager(config: config)
        try await manager.prepareModels()
        let result = try await manager.process(audio: samples, progressCallback: progress)

        return relabelByFirstAppearance(result.segments)
    }

    /// FluidAudio's own `speakerId` strings already look like "S1", "S2", …
    /// but the numbering follows internal cluster indices (derived from
    /// clustering order), which is not guaranteed to match temporal first
    /// appearance. Spec §8 requires "anonymous labels (S1, S2) ordered by
    /// first appearance", so segments are sorted by start time and relabeled
    /// here, independent of whatever FluidAudio's cluster index happened to
    /// be.
    /// Not `private`: exercised directly by a unit test (via `@testable
    /// import`) as a pure function, since it's the one piece of diarization
    /// logic that doesn't require the real FluidAudio pipeline to test.
    static func relabelByFirstAppearance(_ segments: [TimedSpeakerSegment]) -> [SpeakerTurn] {
        let ordered = segments.sorted { $0.startTimeSeconds < $1.startTimeSeconds }

        var relabeled: [String: String] = [:]
        var nextIndex = 1

        return ordered.map { segment in
            let label: String
            if let existing = relabeled[segment.speakerId] {
                label = existing
            } else {
                label = "S\(nextIndex)"
                relabeled[segment.speakerId] = label
                nextIndex += 1
            }
            return SpeakerTurn(
                start: roundedToMillisecond(Double(segment.startTimeSeconds)),
                end: roundedToMillisecond(Double(segment.endTimeSeconds)),
                speaker: label
            )
        }
    }
}
