import CoreMedia
import Foundation
import NaturalLanguage

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
}

extension AttributedString {
    /// Splits this attributed string into sentences and reads each sentence's
    /// audio time range from its `.audioTimeRange` runs. Sentences with no
    /// timed runs at all (shouldn't happen given `.audioTimeRange` is always
    /// requested, but defensively) are skipped rather than crashing.
    func sentenceSegments() -> [TranscriptSegment] {
        let tokenizer = NLTokenizer(unit: .sentence)
        let string = String(characters)
        tokenizer.string = string

        return tokenizer.tokens(for: string.startIndex..<string.endIndex).compactMap { stringRange in
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
            let timeRanges = slice.runs.filter {
                !String(slice[$0.range].characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }.compactMap(\.audioTimeRange)
            guard let first = timeRanges.first, let last = timeRanges.last else { return nil }

            return TranscriptSegment(
                start: roundedToMillisecond(first.start.seconds),
                end: roundedToMillisecond(last.end.seconds),
                text: text
            )
        }
    }
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
