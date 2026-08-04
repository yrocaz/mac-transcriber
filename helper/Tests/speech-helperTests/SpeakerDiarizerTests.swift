import FluidAudio
import Foundation
import Testing

@testable import speech_helper

/// Task 2 deferred coverage, added during the final review pass: pins
/// `relabelByFirstAppearance`'s contract from spec §8 — "anonymous labels
/// (S1, S2) ordered by first appearance" — as a pure-function unit test
/// rather than relying solely on the E2E suite (which can't force a specific
/// FluidAudio cluster-id ordering). FluidAudio's own `speakerId` strings
/// already look like "S1"/"S2" but follow internal cluster indices, which
/// are not guaranteed to match temporal order; this test constructs turns
/// whose cluster id order is the OPPOSITE of their temporal order, so it
/// would fail if `relabelByFirstAppearance` were a passthrough.
@Suite struct SpeakerDiarizerTests {
    private static func turn(
        clusterId: String,
        start: Float,
        end: Float
    ) -> TimedSpeakerSegment {
        TimedSpeakerSegment(
            speakerId: clusterId,
            embedding: [],
            startTimeSeconds: start,
            endTimeSeconds: end,
            qualityScore: 1.0
        )
    }

    @Test func relabelsByFirstTemporalAppearanceNotClusterOrder() throws {
        // Cluster ids sort/arrive in the OPPOSITE order of temporal
        // appearance: "clusterZ" speaks first (t=0) but "clusterA" has the
        // lexically/clustering-earlier id. A passthrough (or a naive sort by
        // speakerId) would label "clusterA" as S1; the spec requires the
        // speaker heard FIRST in time to be S1 regardless of cluster id.
        let segments = [
            Self.turn(clusterId: "clusterZ", start: 0.0, end: 2.0),
            Self.turn(clusterId: "clusterA", start: 5.0, end: 7.0),
            Self.turn(clusterId: "clusterZ", start: 8.0, end: 9.5),
        ]

        let relabeled = SpeakerDiarizer.relabelByFirstAppearance(segments)

        #expect(relabeled.count == 3)
        // First appearance (t=0, clusterZ) -> S1.
        #expect(relabeled[0].speaker == "S1")
        #expect(relabeled[0].start == 0)
        #expect(relabeled[0].end == 2)
        // Second distinct speaker to appear (t=5, clusterA) -> S2.
        #expect(relabeled[1].speaker == "S2")
        #expect(relabeled[1].start == 5)
        #expect(relabeled[1].end == 7)
        // clusterZ's second turn is still S1, not a new label.
        #expect(relabeled[2].speaker == "S1")
        #expect(relabeled[2].start == 8)
        #expect(relabeled[2].end == 9.5)
    }

    @Test func handlesUnorderedInputBySortingOnStartTime() throws {
        // Input segments arrive out of temporal order (as FluidAudio's own
        // result ordering isn't guaranteed to be chronological); the output
        // must still be sorted by start time with labels assigned in that
        // sorted order.
        let segments = [
            Self.turn(clusterId: "clusterB", start: 10.0, end: 12.0),
            Self.turn(clusterId: "clusterA", start: 0.0, end: 3.0),
        ]

        let relabeled = SpeakerDiarizer.relabelByFirstAppearance(segments)

        #expect(relabeled.count == 2)
        #expect(relabeled[0].start == 0)
        #expect(relabeled[0].speaker == "S1")
        #expect(relabeled[1].start == 10)
        #expect(relabeled[1].speaker == "S2")
    }

    @Test func emptyInputProducesEmptyOutput() throws {
        #expect(SpeakerDiarizer.relabelByFirstAppearance([]).isEmpty)
    }
}
