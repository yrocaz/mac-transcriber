import CoreMedia
import Foundation
import Speech
import Testing

@testable import speech_helper

/// Covers the confidence and alternatives work added 2026-08-07: the mean-not-min
/// choice for a sentence's published score, the capture threshold for per-word
/// detail, and — the part most likely to go quietly wrong — matching a word back
/// to the alternatives of the `SpeechTranscriber.Result` it actually came from.
@Suite struct SentenceSegmenterTests {
    /// Builds an AttributedString the way SpeechTranscriber hands one over: one
    /// run per word, each carrying its own time range and confidence.
    private static func transcript(
        _ words: [(text: String, start: Double, end: Double, confidence: Double?)]
    ) -> AttributedString {
        var result = AttributedString("")
        for word in words {
            var piece = AttributedString(word.text)
            piece.audioTimeRange = CMTimeRange(
                start: CMTime(seconds: word.start, preferredTimescale: 1000),
                end: CMTime(seconds: word.end, preferredTimescale: 1000)
            )
            if let confidence = word.confidence {
                piece.transcriptionConfidence = confidence
            }
            result.append(piece)
        }
        return result
    }

    @Test("A sentence's published confidence is the mean of its words, not the minimum")
    func meanNotMinimum() throws {
        // Deliberately mirrors real data: one near-zero function word among
        // otherwise-clean words. Taking the minimum would publish 0.01 for a
        // sentence that is, overall, entirely trustworthy.
        let text = Self.transcript([
            ("The ", 0, 0.3, 0.01),
            ("rent ", 0.3, 0.7, 0.99),
            ("is ", 0.7, 0.9, 0.99),
            ("due.", 0.9, 1.2, 0.99),
        ])

        let segments = text.sentenceSegments()
        #expect(segments.count == 1)
        // (0.01 + 0.99 + 0.99 + 0.99) / 4 = 0.745
        #expect(segments[0].confidence == Decimal(string: "0.745"))
    }

    @Test("Words below the capture threshold are reported; words above it are not")
    func capturesOnlyLowConfidenceWords() throws {
        let text = Self.transcript([
            ("Find ", 0, 0.3, 0.274),
            ("newth ", 0.3, 0.7, 0.185),
            ("and ", 0.7, 0.9, 0.99),
            ("comb.", 0.9, 1.2, 0.95),
        ])

        let segments = text.sentenceSegments()
        #expect(segments.count == 1)
        #expect(segments[0].lowTokens.map(\.text) == ["Find", "newth"])
        #expect(segments[0].lowTokens[1].confidence == Decimal(string: "0.185"))
    }

    @Test("A word carries the alternatives of the Result covering its own timestamp")
    func alternativesComeFromTheCoveringResult() throws {
        let text = Self.transcript([
            ("Find ", 0, 0.3, 0.274),
            ("newth ", 0.3, 0.7, 0.185),
            ("later.", 5.0, 5.4, 0.2),
        ])

        // Two Results: the first covers the opening phrase, the second a much
        // later one. A word must not inherit the wrong Result's hypotheses.
        let alternatives = [
            ResultAlternatives(start: 0, end: 1.0, options: [" fine, newth", " fine, nuth"]),
            ResultAlternatives(start: 4.5, end: 6.0, options: [" ladder."]),
        ]

        let segments = text.sentenceSegments(resultAlternatives: alternatives)
        let tokens = segments.flatMap(\.lowTokens)
        let byWord = Dictionary(uniqueKeysWithValues: tokens.map { ($0.text, $0.alternatives) })

        #expect(byWord["newth"] == [" fine, newth", " fine, nuth"])
        #expect(byWord["later."] == [" ladder."])
    }

    @Test("A word outside every Result's range gets no alternatives rather than a wrong one")
    func noAlternativesWhenUncovered() throws {
        let ranges = [ResultAlternatives(start: 10, end: 20, options: [" something"])]
        #expect(alternatives(at: 5, in: ranges).isEmpty)
        #expect(alternatives(at: 25, in: ranges).isEmpty)
        // Ranges are half-open: the end boundary belongs to the next Result.
        #expect(alternatives(at: 10, in: ranges) == [" something"])
        #expect(alternatives(at: 20, in: ranges).isEmpty)
    }

    @Test("Confidence is nil when the engine reported none, rather than defaulting to zero")
    func absentConfidenceStaysAbsent() throws {
        let text = Self.transcript([
            ("No ", 0, 0.3, nil),
            ("scores.", 0.3, 0.7, nil),
        ])

        let segments = text.sentenceSegments()
        #expect(segments.count == 1)
        #expect(segments[0].confidence == nil)
        #expect(segments[0].lowTokens.isEmpty)
    }

    @Test("Whitespace runs are excluded from the confidence average")
    func whitespaceRunsDoNotSkewTheMean() throws {
        // The segmenter already filters whitespace-only runs when computing a
        // sentence's time window; the same filtered set must drive confidence,
        // or a stray separator run drags the score around.
        var text = Self.transcript([("Clean ", 0, 0.5, 0.9)])
        var separator = AttributedString(" ")
        separator.audioTimeRange = CMTimeRange(
            start: CMTime(seconds: 0.5, preferredTimescale: 1000),
            end: CMTime(seconds: 0.6, preferredTimescale: 1000)
        )
        separator.transcriptionConfidence = 0.0
        text.append(separator)
        text.append({
            var piece = AttributedString("words.")
            piece.audioTimeRange = CMTimeRange(
                start: CMTime(seconds: 0.6, preferredTimescale: 1000),
                end: CMTime(seconds: 1.0, preferredTimescale: 1000)
            )
            piece.transcriptionConfidence = 0.9
            return piece
        }())

        let segments = text.sentenceSegments()
        #expect(segments.count == 1)
        #expect(segments[0].confidence == Decimal(string: "0.9"))
    }
}
