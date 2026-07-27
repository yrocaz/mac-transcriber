# Spikes — 2026-07-27

Throwaway verification code run on this machine (macOS 26.5.2, Swift 6.3.3) before designing the service. Compile with `swiftc -parse-as-library <file>.swift -o <name>`.

- `probe.swift` — confirms `SpeechTranscriber.isAvailable`, lists supported (30) and installed (9, all English) locales.
- `transcribe.swift` — minimal file transcription via `AVAudioFile` → `SpeechAnalyzer.analyzeSequence(from:)` → `finalizeAndFinish(through:)`.

Results:

| Input | Result |
|---|---|
| `say`-generated AIFF (~7s speech) | Perfect transcript incl. punctuation, 0.27s (~25× realtime) |
| Real mp4 with AAC audio track (sample-5s.mp4 from samplelib.com) | Opened and analyzed without error (empty transcript — clip contains music, no speech) |
| mp4 with NO audio track (Adobe onboarding video) | Fails fast at `AVAudioFile(forReading:)` with CoreAudio error 1685348671 |

Conclusion: video containers with audio tracks work directly through `AVAudioFile` on macOS 26.5 — no ffmpeg needed for mp4/mov.
