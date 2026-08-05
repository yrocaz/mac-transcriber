# Credits and attribution

This project was deliberately built by studying existing work rather than designing from scratch. Some of it is a dependency; some of it is a pattern we read and reimplemented. Both are listed here, because a borrowed approach deserves credit even when its license doesn't demand it.

## Runtime dependencies

| Project | License | How it's used |
|---|---|---|
| [FluidAudio](https://github.com/FluidInference/FluidAudio) (pinned v0.15.5) | Apache-2.0 | Speaker diarization — the Pyannote Community-1 offline pipeline via `OfflineDiarizerManager`. Linked as a Swift package; not modified or vendored. |
| [swift-argument-parser](https://github.com/apple/swift-argument-parser) | Apache-2.0 | CLI parsing in the Swift helper |
| [Fastify](https://github.com/fastify/fastify) | MIT | HTTP server |
| [zod](https://github.com/colinhacks/zod) | MIT | Request and job-record validation |
| [vitest](https://github.com/vitest-dev/vitest) | MIT | Test runner (dev only) |
| [tsx](https://github.com/privatenumber/tsx) | MIT | TypeScript execution in development (dev only) |

Apple's **Speech** framework (`SpeechAnalyzer`, `SpeechTranscriber`), **AVFoundation**, and **NaturalLanguage** are macOS system frameworks used under the OS's own terms. Speech recognition models are managed and downloaded by macOS itself.

## Models downloaded at runtime

FluidAudio fetches its CoreML diarization models from Hugging Face on first use. Per FluidAudio's README, the open-source models it distributes are MIT/Apache-2.0 licensed. The offline pipeline this project uses is **Pyannote Community-1** (powerset segmentation + WeSpeaker embeddings + VBx clustering); their upstream terms apply to the model weights themselves.

## Patterns and approaches we learned from

None of these are dependencies. We read their source, understood how they solved a problem, and implemented our own version — which is exactly what they're valuable for.

**[yap](https://github.com/finnvoor/yap) by finnvoor** (CC0-1.0) — the reference SpeechAnalyzer CLI, and the single largest influence on the Swift helper. CC0 places it in the public domain and requires no attribution; we're crediting it because it earned it. Specifically:

- Reading video containers directly with `AVAudioFile` rather than shelling out to ffmpeg
- The `AssetInventory` release-then-reserve sequence, and BCP-47 (`identifier(.bcp47)`) locale comparison, which avoids a real `en_US`/`en-US` footgun
- The malformed-MP3 workaround: probing the file tail and re-exporting to M4A via `AVAssetExportSession` when a file misreports its packet count
- Deriving progress from `resultsFinalizationTime` against file duration
- Using `Decimal` for millisecond rounding so timestamps don't acquire float artifacts
- Sentence-level segmentation via `NaturalLanguage` against `.audioTimeRange` attributes

**[apple-speechanalyzer-cli-example](https://github.com/argmaxinc/apple-speechanalyzer-cli-example) by Argmax** (MIT) — the clearest minimal example of driving `SpeechAnalyzer`: start the results consumer *before* `analyzeSequence`, then `finalizeAndFinish(through:)`, or `cancelAndFinishNow()` when the file is empty.

**[Apple's SpeechAnalyzer sample project](https://developer.apple.com/documentation/speech/bringing-advanced-speech-to-text-capabilities-to-your-app)** — the `AVAudioConverter` buffer-conversion approach, including `primeMethod = .none` to avoid timestamp drift, and the asset-installation flow.

**[node-apple-speech](https://github.com/mybigday/node-apple-speech) by MyBigday** (MIT) — established that the practical way to reach Apple's Speech framework from Node is a spawned Swift helper speaking newline-delimited JSON over stdio, rather than a native addon.

**[Stenographer](https://github.com/otaviocc/Stenographer) by otaviocc** (MIT) — its transcription event stream shaped our NDJSON event vocabulary.

**[whishper](https://github.com/pluja/whishper)** (AGPL-3.0) and **[Scriberr](https://github.com/rishikanthc/Scriberr)** (MIT) — the async job model this service uses: submit, get an id, persist status/progress to a record, poll. Neither project's code is included here; we followed the shape.

**[swift-scribe](https://github.com/FluidInference/swift-scribe) by FluidInference** (MIT) — precedent for the hybrid architecture: Apple's SpeechAnalyzer for words, FluidAudio for speakers.

**[ohr](https://github.com/Arthur-Ficial/ohr)** (MIT) — an existing HTTP wrapper around SpeechAnalyzer, useful as a reference for API shape.

## Research sources

The design was written against primary documentation, recorded in `docs/research/` with links to every source: Apple's [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) and [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) documentation, [WWDC25 session 277](https://developer.apple.com/videos/play/wwdc2025/277/), and Apple Developer Forums threads [790108](https://developer.apple.com/forums/thread/790108) (locale normalization, answered by an Apple engineer) and [818005](https://developer.apple.com/forums/thread/818005) (file-input reliability on macOS 26.x).

## Test fixtures

Speech fixtures are generated locally by `scripts/make-fixtures.sh` using macOS's built-in `say` command. No third-party media is committed to this repository — anything else the tests need is fetched or synthesized by that script, so nothing is redistributed here.
