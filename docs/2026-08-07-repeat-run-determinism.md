# Do repeat transcription runs find errors?

**Question asked:** transcription is fast (~60× realtime), so is there value in
running the same file N times, diffing the results, and spot-checking wherever
the runs disagree?

**Answer: no.** The pipeline is deterministic end to end. N runs produce N
identical files. The measurements below establish that, and identify what does
work instead: the confidence and alternative-transcription signals that Apple's
`SpeechTranscriber` exposes and that the helper currently discards.

## Determinism measurements

All runs on this machine, `speech-helper` at commit `e7b4421`, macOS 26,
`en-US`.

| Input | Runs | Result |
|---|---|---|
| `test-fixtures/two-voice-interview.wav` (42s, 2 speakers) | 3 | segments **byte-identical**; diarization **byte-identical** |
| `Panel.wav` (43:09, 5 speakers), `--speakers 5` | 2 | 554 segments **byte-identical**; diarization **byte-identical** |
| `Panel.wav`, auto-clustering (no `--speakers`) | 2 | 177,171 bytes each, **byte-identical**; both report `"count":3` |

The third row is the important one. Auto-clustering under-segments this file —
five real speakers collapse into three clusters, the finding recorded in
`docs/2026-08-04-v1-build-record.md`. That failure reproduces **exactly** across
runs. The one known accuracy defect in this pipeline is perfectly repeatable, so
a repeat-and-diff workflow would have reported two identical outputs and found
nothing.

This is the general problem with self-consensus over a deterministic decoder:
there is no sampling temperature, no seed, no beam-search randomness to
perturb. The model makes the same mistake with the same confidence every time.
Agreement across runs measures nothing.

**Scope of the claim.** Determinism holds for a fixed model version. A macOS
update or a re-downloaded speech asset can legitimately change output; these
runs were all within one session on one machine. Determinism across model
versions was not tested and should not be assumed.

## What the model does expose

`SpeechTranscriber` accepts two options the helper does not currently pass
(`helper/Sources/speech-helper/TranscribeCommand.swift`, which constructs it
with `reportingOptions: []` and `attributeOptions: [.audioTimeRange]`):

- `ReportingOption.alternativeTranscriptions` → `Result.alternatives: [AttributedString]`
- `ResultAttributeOption.transcriptionConfidence` → a per-token `Double`

Both are populated, verified with a throwaway probe (not committed; see
"Reproducing" below). On `Panel.wav`:

- **8,220 tokens, zero nil confidences**, 724 distinct values spanning 0.001–1.0
- **1–5 alternatives per result**; of 2,131 results carrying more than one,
  955 (45%) differ beyond capitalization and punctuation

So the signal is real and dense, not a stub that returns a constant.

## Sizing the spot-check queue

Tokens below a confidence threshold, on 43:09 of audio. "Spots" merges tokens
within 3 seconds of each other into one place to listen.

| Threshold | Tokens | % of transcript | Spots |
|---|---|---|---|
| < 0.9 | 2,398 | 29.2% | 172 |
| < 0.75 | 1,309 | 15.9% | 282 |
| < 0.5 | 344 | 4.2% | 185 |
| < 0.3 | 118 | 1.4% | 96 |
| < 0.1 | 17 | 0.2% | 15 |

Spot count is not monotonic in the threshold: loosening it adds tokens that
merge into long contiguous runs, so 2,398 tokens at <0.9 form *fewer* clusters
than 1,309 tokens at <0.75. Token count is the honest measure of volume;
spot count only becomes meaningful at the tight end.

**Raw confidence over-weights filler.** The twelve lowest-confidence tokens on
this file are almost all function words and disfluencies — `" their"` (0.001),
`" the"` (0.031), `" um,"` (0.058), `" uh,"` (0.069). A misheard `"um"` does
not affect a transcript's usefulness, let alone an article derived from it.

Filtering to content words sharpens the list considerably:

| Threshold | Content tokens | Spots |
|---|---|---|
| < 0.5 | 79 | 68 |
| < 0.3 | 21 | 20 |
| < 0.15 | 3 | 3 |

**These counts are a property of the filter, not of the data.** The filter was
a throwaway inline stopword list plus a three-character minimum, written for
this measurement and not committed. It is crude enough that the two
lowest-confidence tokens on the entire file land on opposite sides of it:
`" their"` (0.001) is dropped, `" considered"` (0.029) is kept. Words like
`know`, `like`, `well`, and `now` are on the stoplist despite carrying meaning
in many sentences. Move the list and the numbers move with it.

The durable claim is directional: **raw confidence ranking surfaces
disfluencies, so any real implementation needs a content filter, and designing
that filter is a design decision rather than a lookup.** The order of magnitude
— tens of spots per hour, not hundreds — is what should be carried forward.

### Verifying that flagged spans are real errors

Low confidence in a noisy passage would be unsurprising and not very useful.
The question is whether it marks genuine transcription errors. Two flagged
spans were checked against the audio's context and against the model's own
alternatives at those timestamps. Both are real errors.

**24:27 — `" newth"` (conf 0.185), `" find"` (conf 0.274).** The transcript
reads:

> …where they do document everything. They do look at everything, **find newth
> and comb**. Is that the saying? I forgot it.

The speaker is reaching for "**fine-tooth comb**" — and says so in the next
breath. The alternatives captured at this timestamp include `" fine, newth"`
and `" fine, nuth"`: the model's runner-up hypothesis has the correct first
word. Confidence flagged the error and the alternatives carry part of the fix.

**38:28 — `" Crom"` (conf 0.276).** The transcript reads:

> …what **Crom** said, or sorry, what Michael said is good…

A misheard proper noun, in a passage where the speaker is already
self-correcting about a name. The only alternative offered is `" Chrome"`,
also wrong. Confidence caught the error; the alternatives did not fix it.

Taken together: confidence is an effective error *detector*, and alternatives
are a partial and inconsistent error *corrector*. Both are worth surfacing, but
the alternatives should be presented as hints to a human, never applied
automatically. Garbled proper nouns and terms of art are the failure mode that
most damages a derived article and that a reader most notices — and it is
exactly what these flags found.

## Recommendation — implemented 2026-08-07

Repeat-run comparison was not built. Uncertainty-guided review was, in three
parts:

1. `SpeechTranscriber` now requests `.transcriptionConfidence` and
   `.alternativeTranscriptions`. Verified output-neutral before enabling: the
   transcript text is byte-identical with and without them (44,242 characters
   both ways on `Panel.wav`), so they are on unconditionally rather than behind
   a flag.
2. Per-sentence mean confidence flows through the NDJSON bridge into
   `transcript.json`; per-word detail and alternatives ride along on the
   `segment` event as `lowTokens`.
3. `review.md` is written beside the other transcript files, ranking
   low-confidence content words worst-first with timestamps, speaker, containing
   sentence, and the engine's alternatives.

On this file the result is **93 spots across 43 minutes** — a real review pass.
Design decisions and the NDJSON schema are recorded in the spec's
"Addendum 2026-08-07"; the review policy (threshold, filler filter, alternative
presentation) lives in `server/src/review.ts` with unit coverage in
`server/test/unit/review.test.ts`.

This serves the project's stated end goal directly: an article-generation step
can be handed the uncertainty list and told not to assert anything resting on a
flagged span.

A representative entry from the real run, showing why the alternatives are worth
carrying:

```markdown
### 28:36 · S2 — `then` (0.159)

> Like, a contract is only as good as it is enforceable, and if it costs you
> more to sue someone, **then** you hope to get back.

Also considered: `someone than`, `someone, than`
```

The correct word is "than", and it is sitting in the runner-up.

**Not pursued, recorded for completeness:** genuine output diversity would
require either perturbing the input (resampling, gain, locale variant) or
running a second independent engine such as `whisper.cpp` as a diverse voter.
Both add real cost and a dependency; the confidence signal is already present
and free.

## Reproducing

The probe used here was a standalone `swiftc` program in a scratch directory,
deliberately not committed — it duplicates helper logic and would rot. To
rebuild it, construct `SpeechTranscriber` with:

```swift
SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [.alternativeTranscriptions],
    attributeOptions: [.audioTimeRange, .transcriptionConfidence]
)
```

then read `run.transcriptionConfidence` over `result.text.runs` and
`result.alternatives` per result.

One practical note: two processes cannot hold the same reserved locale at once.
`AssetInventory.reserve(locale:)` contention causes a concurrent run to produce
**zero bytes and exit 0** — silent, and it briefly produced a false "identical"
result here by comparing two empty files. Run comparisons serially, and assert
outputs are non-empty before diffing them.
