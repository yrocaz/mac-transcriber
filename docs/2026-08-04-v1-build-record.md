# v1 build record — decisions, rulings, and disclosed gaps

Date: 2026-08-04. Merged to `main` as `254f6c4` (branch `v1`, 17 commits).

Built with a subagent-per-task workflow: five implementation tasks, each with an independent code review and fix rounds until clean, then a whole-branch review. This document preserves the decisions and known gaps that don't live in the code or the spec. The spec (`docs/superpowers/specs/2026-07-27-media-transcriber-design.md`) remains the contract; the research notes in `docs/research/` remain the sourcing.

## What shipped

| Component | Contents |
|---|---|
| `helper/` | Swift executable `speech-helper` — Apple SpeechAnalyzer transcription, FluidAudio (pinned v0.15.5) Pyannote Community-1 offline diarization, NDJSON events on stdout |
| `server/` | Fastify service (loopback-only) — job store, FIFO queue at concurrency 1, helper supervision, transcript assembly, SRT, `/health` |
| `scripts/`, `test-fixtures/` | Deterministic fixture generation; committed `say`-based and mp4 fixtures |

Verification at merge: 78 server unit tests, 8 Swift tests (via `helper/scripts/swift-test.sh`), 6 real end-to-end tests against the built helper.

## Controller rulings (decisions made during the build)

**Helper emits raw speaker turns; the merge is server-side.** Spec §4 lists max-overlap merging under the helper recipe, but the NDJSON contract emits raw turns and the server owns assembly. Server-side merge is correct and is what shipped.

**`unavailable` is a distinct error code.** `SpeechTranscriber.isAvailable == false` originally mapped to `noModel`, which spec §6 reserves for missing model assets. Split so the server can branch unambiguously.

**Loopback bind is `127.0.0.1` only, not also `::1`.** A single Fastify instance can't cleanly dual-bind. The spec's hard constraint ("never `0.0.0.0`") is fully met, and the value is hardcoded with no env-var override.

**`model_download` events don't move reported progress.** Spec §6 maps only the transcribe and diarize stages. These events exist purely as inactivity-timer keepalives.

**Default locale is `en-US`** — not spec-stated; chosen because only English models are installed on this machine.

**`test-fixtures/malformed.mp3` is not committed.** It would redistribute most of a macOS system audio resource. `scripts/make-fixtures.sh` regenerates it plus a sidecar (`malformed.mp3.json`) carrying its true and declared durations; the E2E case skips loudly and names the script.

**Startup timeout raised 60s → 180s** (spec §6 updated to match, value pinned by a test). End-to-end testing measured `AVAssetExportSession` at roughly 90 seconds of fixed overhead in this environment on *any* input, including a 6.6-second AIFF. The malformed-MP3 repair path — the exact case that export exists to serve — could never emit `ready` inside a 60s budget, so it was dead on arrival in production. Worth re-measuring on non-sandboxed hardware; the larger budget is harmless either way, since the timeout's job is catching a hung or missing helper.

## Parked items (real, deliberately not fixed in v1)

**Whole-file in-memory decode for diarization** (`helper/Sources/speech-helper/DiarizationAudioDecoder.swift`). Allocates the entire decoded file at native rate and channel count: roughly 645 MB for 30-minute stereo 44.1 kHz media, ~2.5 GB for two hours. FluidAudio's URL-based `process()` would fix both this and the silent-decode window, but it does not apply `primeMethod = .none`, which spec §4 item 7 mandates — so switching is a spec amendment, not a drop-in. Chunked decode is the v2 alternative. Allocation failure degrades gracefully (warning, job still completes). Summarized in the README's Known limitations.

**Per-event synchronous whole-record disk write** (`server/src/jobStore.ts`). Every `progress`/`segment` event re-serializes the whole job record: O(n²) bytes, roughly 1–2s cumulative blocking at ~600 segments. Acceptable at personal-pipeline scale. Recorded so it isn't rediscovered later as a mystery latency source.

## Disclosed coverage gaps

**`KeepAliveTicker`'s 20-second periodic tick has no automated test and was never observed firing live** (models were already cached during every run). Its correctness rests on code inspection, independently reviewed as sound: dedicated serial queue, no retain cycle, no deadlock path, and it emits through `EventEmitter`'s lock so it cannot interleave partial lines or emit after a terminal event.

The *immediate* pre-diarize tick is structurally guaranteed rather than merely tested: `SpeakerDiarizer.diarize` passes its progress callback only to `manager.process(...)`, which runs after `decode()` and `prepareModels()` — so the ticker cannot be stopped before the silent window it covers has elapsed.

**The server-side keepalive test exercises a pre-existing mechanism, not the Swift ticker.** `server/test/unit/supervisor.test.ts`'s fake-helper scenario would pass unchanged if `KeepAliveTicker.swift` were deleted; it verifies that any NDJSON line resets the inactivity timer. This is stated in the test's own comment. Do not read it as ticker coverage.

**The MP3-repair E2E case fails open on a fresh clone.** Because the fixture isn't committed, the only coverage of `AudioPreparer.repair()` skips with a warning until `scripts/make-fixtures.sh` runs. The README documents fixture generation as a required E2E prerequisite.

## Why `helper/scripts/swift-test.sh` exists — do not delete it

On a Command-Line-Tools-only toolchain (no full Xcode), bare `swift test` **builds successfully and exits 0 while running zero tests** — no output, no failures, no signal. This was proven by planting a deliberately failing test: the bare run still exited 0, while the wrapper correctly exited 1. The wrapper passes the needed search-path flags directly to `swift test`.

A future contributor who "cleans up" this wrapper and reverts to bare `swift test` will get a permanently green Swift suite that tests nothing. The README's development section documents this.

## Techniques worth keeping

**Constructing a malformed MP3 without an encoder.** Task 1 could not exercise the MP3 tail-probe/repair branch because no MP3 encoder was available. The working approach: prepend a synthetic MPEG frame carrying a lying Xing/VBR frame-count header onto a real, well-formed system MP3. Verified genuine — the helper logs tail-probe detection and reports the true 32.7s duration instead of the declared ~131s. `scripts/make-fixtures.sh` implements it.

## Bugs found by review that would have shipped

Recorded because they show where this system's real risks concentrate — process supervision and cross-component assumptions.

1. **The inactivity timeout would have killed the first diarized job on any fresh machine.** Spec §6 justified the 120s budget on model downloads emitting keepalive events — true for Apple's asset downloads, false for FluidAudio's `prepareModels()`, which downloads ~21 MB silently with no progress callback and logs only to OSLog. The job died at 120s with a complete transcript stranded in `job.json` and unreachable via the API. Two tasks' assumptions met and disagreed; neither task's own review could see it.
2. **A spawn failure would have wedged the queue permanently** — the supervisor resolved only on the child's `exit` event, which never fires when the process fails to spawn.
3. **The run-promise could resolve before the job was finalized**, letting the queue advance while the record still said `running`, and leaking a kill timer.
4. **Jobs were marked `done` before transcripts were written** (spec §5 mandates the reverse), so a crash in that window left a permanently-done job with no transcript and no retry.
5. **Segment IDs were assigned before empty segments were filtered**, producing gaps — behind a test named "assigns sequential ids" that contained no empty segments.

Two tests were also caught claiming coverage they didn't have (the ID test above, and an ordering test that passed under the buggy order). Both were replaced with assertions verified to fail before the fix.
