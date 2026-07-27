# Research: FluidAudio (diarization engine for v1)

Date: 2026-07-27. Source: [FluidAudio README](https://github.com/FluidInference/FluidAudio) (fetched raw from `main`). License Apache-2.0.

Evaluated when the user asked whether FluidAudio could replace the whole build. Conclusion: it competes only for the engine slot inside the Swift helper — the TypeScript service layer is needed regardless. Chosen role: **diarization only**, alongside SpeechAnalyzer transcription (the hybrid FluidInference's own [swift-scribe](https://github.com/FluidInference/swift-scribe) uses).

## Capabilities (verbatim-based)

- ASR: "Parakeet TDT v3 (0.6b) and other TDT/CTC models for batch transcription supporting 25 European languages and Japanese"; ~190× realtime on M4 Pro. (Not used — SpeechAnalyzer covers this, OS-managed, more locales incl. CJK, verified locally.)
- Diarization: three implementations — Pyannote 3.1 pipeline (offline), LS-EEND (streaming, ≤10 speakers), Sortformer (streaming, ≤4 speakers). **Pyannote offline is our fit (batch files).**
- Speaker embeddings: "Generate speaker embeddings for voice comparison and clustering" → future path to naming known/recurring voices.
- Also: Silero VAD, TTS (not needed).

## Diarization API (verbatim from README)

```swift
let config = OfflineDiarizerConfig()
let manager = OfflineDiarizerManager(config: config)
try await manager.prepareModels()
let result = try await manager.process(audio: samples)
for segment in result.segments {
    print("\(segment.speakerId) \(segment.startTimeSeconds)s → \(segment.endTimeSeconds)s")
}
```

- Input: 16 kHz mono samples (Float32 or Int16) → we decode via AVAudioFile + AVAudioConverter (`primeMethod = .none`, Apple-sample BufferConverter pattern).
- Output: segments with `speakerId`, `startTimeSeconds`, `endTimeSeconds`.

## Operational facts

- Models download from HuggingFace (FluidInference org) on first use; offline afterward. Controls: `ModelHub.offlineMode`, `ModelRegistry.baseURL` / `REGISTRY_URL` env var, `https_proxy` honored.
- Swift 6.0+, macOS/iOS; CLI (`fluidaudiocli`) is macOS-only (benchmark-oriented — not suitable as our helper).
- Pyannote models MIT/Apache-2.0; Sortformer under NVIDIA Open Model License (unused).
- No headline DER/WER numbers in README; their CI reports DER/JER/RTFx per PR.

## Decision & downsides accepted

- Hybrid engine (SpeechAnalyzer words + FluidAudio speakers): keeps the OS-native zero-download verified transcription engine; adds the one capability Apple lacks from the library best at it; diarization failure degrades gracefully (speaker: null) instead of failing jobs.
- Accepted downsides: one-time HF model download (network + disk), a third-party SDK dependency for the speaker feature only, anonymous labels (S1/S2) rather than names in v1.
