import CoreMedia
import Foundation
import NaturalLanguage

/// One low-confidence word inside a sentence, carried on the `segment` event so
/// the server can build a review list without a second pass over the audio.
///
/// `alternatives` are the runner-up hypotheses for the `SpeechTranscriber.Result`
/// this word came from — NOT for the sentence. A `Result` is a phrase-sized
/// chunk that need not align with sentence boundaries, so attaching alternatives
/// to the sentence would misattribute them. Verified on a real recording: at
/// 24:27 the transcript reads "find newth and comb" (the speaker is reaching for
/// "fine-tooth comb") and that Result's alternatives are "fine, newth" /
/// "fine, nuth" — a phrase-level hypothesis, meaningless attached to anything
/// wider.
struct LowConfidenceToken {
    let text: String
    let start: Decimal
    let confidence: Decimal
    let alternatives: [String]

    var json: [String: Any] {
        ["text": text, "start": start, "confidence": confidence, "alternatives": alternatives]
    }
}

/// Confidence at or above which a word is not worth capturing at all.
///
/// This is a DATA-VOLUME cutoff, not a review policy. Capturing every token
/// would put ~8,200 entries on a 43-minute recording into the event stream;
/// capturing below 0.9 keeps ~29% of them, which is a generous superset of
/// anything a review pass would surface. The actual review threshold and the
/// content-word filtering live server-side in `server/src/review.ts`, so that
/// policy can be tuned without rebuilding the helper. Raise this only if the
/// server ever wants to review at a threshold above 0.9.
let lowConfidenceCaptureThreshold = 0.9

/// Alternatives for one `SpeechTranscriber.Result`, kept with the time range
/// they belong to so a token can be matched back to its own Result.
struct ResultAlternatives {
    let start: Double
    let end: Double
    let options: [String]
}

/// A sentence-level segment ready to become a `segment` NDJSON event: sentence
/// boundaries from NaturalLanguage's tokenizer, with a `[start, end]` window
/// spanning the `.audioTimeRange` attribute of that sentence's timed runs
/// (spec §4 item — "sentence segmentation via NaturalLanguage with
/// `.audioTimeRange` per sentence"; approach follows yap's `sentences(maxLength:)`,
/// simplified here since the transcript schema (spec §3) has no line-length cap).
struct TranscriptSegment {
    let start: Decimal
    let end: Decimal
    let text: String
    /// Mean of this sentence's per-word confidences, or nil if the engine
    /// reported none.
    ///
    /// Deliberately the mean and not the minimum. On real audio the minimum is
    /// held by function words and disfluencies — measured on a 43-minute panel,
    /// the floor tokens were " their" (0.001) and " the" (0.031) — so a
    /// min-based score would render nearly every sentence as near-zero and read
    /// as broken. The mean answers "how clean is this sentence overall"; the
    /// worst-word detail lives in `lowTokens`, which is what the review list
    /// actually ranks on.
    let confidence: Decimal?
    let lowTokens: [LowConfidenceToken]
}

extension AttributedString {
    /// Splits this attributed string into sentences and reads each sentence's
    /// audio time range from its `.audioTimeRange` runs. Sentences with no
    /// timed runs at all (shouldn't happen given `.audioTimeRange` is always
    /// requested, but defensively) are skipped rather than crashing.
    ///
    /// `resultAlternatives` maps time ranges back to the alternatives of the
    /// `Result` they came from; pass an empty array when alternatives weren't
    /// requested.
    func sentenceSegments(resultAlternatives: [ResultAlternatives] = []) -> [TranscriptSegment] {
        let tokenizer = NLTokenizer(unit: .sentence)
        let string = String(characters)
        tokenizer.string = string

        return tokenizer.tokens(for: string.startIndex..<string.endIndex).compactMap {
            stringRange in
            guard let start = AttributedString.Index(stringRange.lowerBound, within: self),
                let end = AttributedString.Index(stringRange.upperBound, within: self)
            else { return nil }

            let slice = self[start..<end]
            let text = String(slice.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }

            // Whitespace-only runs at a sentence slice's boundary (e.g. the
            // leading space carried over from the previous sentence) still
            // carry an `.audioTimeRange` attribute value — but it's the
            // *previous* phrase's time range, not this sentence's. Unfiltered,
            // this pulls `first`/`last` from the wrong run and produces
            // systematically-too-early starts that overlap the prior segment
            // (caught empirically: sentence 2 started before sentence 1 ended).
            // yap filters these out before taking first/last; do the same.
            // The same filtered set is what confidence is averaged over, so a
            // whitespace run can't drag a sentence's score around either.
            let wordRuns = slice.runs.filter {
                !String(slice[$0.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    .isEmpty
            }
            let timeRanges = wordRuns.compactMap(\.audioTimeRange)
            guard let first = timeRanges.first, let last = timeRanges.last else { return nil }

            let confidences = wordRuns.compactMap(\.transcriptionConfidence)
            let meanConfidence: Decimal? =
                confidences.isEmpty
                ? nil
                : roundedToMillisecond(confidences.reduce(0, +) / Double(confidences.count))

            let lowTokens: [LowConfidenceToken] = wordRuns.compactMap { run in
                guard let confidence = run.transcriptionConfidence,
                    confidence < lowConfidenceCaptureThreshold
                else { return nil }
                let word = String(slice[run.range].characters)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !word.isEmpty else { return nil }
                let tokenStart = run.audioTimeRange?.start.seconds ?? first.start.seconds
                return LowConfidenceToken(
                    text: word,
                    start: roundedToMillisecond(tokenStart),
                    confidence: roundedToMillisecond(confidence),
                    alternatives: alternatives(at: tokenStart, in: resultAlternatives)
                )
            }

            return TranscriptSegment(
                start: roundedToMillisecond(first.start.seconds),
                end: roundedToMillisecond(last.end.seconds),
                text: text,
                confidence: meanConfidence,
                lowTokens: lowTokens
            )
        }
    }
}

/// The alternatives of whichever `Result` covers `time`. Ranges are disjoint and
/// ordered in practice, but a linear scan is used rather than a binary search:
/// this runs only for captured low-confidence tokens (hundreds, not thousands),
/// and correctness under an unexpected ordering matters more than the constant.
func alternatives(at time: Double, in ranges: [ResultAlternatives]) -> [String] {
    for range in ranges where time >= range.start && time < range.end {
        return range.options
    }
    return []
}

/// Rounds to millisecond precision using yap's `Decimal` trick — converting
/// through `Int` and back via `Decimal` rather than plain `Double` division —
/// to avoid float artifacts like `2.2200000000000002` in the emitted JSON.
/// (Rounding a `Double` and dividing by 1000 in `Double` arithmetic does NOT
/// fix this: the nearest representable `Double` to a value like `6.571` is
/// itself `6.5709999999999997`, so `JSONSerialization` prints the long tail
/// regardless of the rounding done beforehand. `Decimal` stores `6.571`
/// exactly in base 10, so it serializes as `6.571`.)
func roundedToMillisecond(_ value: Double) -> Decimal {
    Decimal(Int(round(value * 1000))) / 1000
}
