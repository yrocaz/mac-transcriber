#!/usr/bin/env bash
# Fake speech-helper for unit tests: echoes canned NDJSON instead of running
# the real Swift binary, so the TS supervisor/queue/timeout logic can be
# tested fast and offline (spec §7). The scenario is selected by the
# basename (without extension) of --input, so callers pick a scenario simply
# by choosing which fixture file to POST.
set -u

emit() { printf '%s\n' "$1"; }

# Real timeout tests SIGTERM this script; without a trap, a backgrounded
# `sleep` grandchild would be orphaned (it inherits stdio fds, so it also
# keeps the pipes the supervisor is reading open) and linger for its full
# duration. `snooze` backgrounds the sleep and waits on it so the trap can
# reap it immediately on SIGTERM.
cleanup() {
  jobs -p | xargs -r kill -9 2>/dev/null
  exit 143
}
trap cleanup TERM
snooze() {
  sleep "$1" &
  wait $!
}

if [[ "${1:-}" == "status" ]]; then
  emit '{"available":true,"installedLocales":["en-US"],"supportedLocales":["en-US"]}'
  exit 0
fi

if [[ "${1:-}" != "transcribe" ]]; then
  echo "fake-helper: unknown subcommand '${1:-}'" >&2
  exit 64
fi
shift

input=""
diarize=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      input="$2"
      shift 2
      ;;
    --locale)
      shift 2
      ;;
    --no-diarize)
      diarize=0
      shift
      ;;
    *)
      shift
      ;;
  esac
done

name="$(basename "$input")"
name="${name%.*}"

case "$name" in
  basic*)
    emit '{"type":"ready","durationSec":10}'
    # Small deliberate delay so tests have a window to observe this job as
    # "running" (e.g. to prove the queue keeps a second job "queued" while
    # this one is in flight) before it reaches a terminal state.
    sleep 0.15
    emit '{"type":"progress","stage":"transcribe","pct":0.5}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"segment","start":0,"end":2,"text":"Hello there."}'
    emit '{"type":"segment","start":2,"end":4,"text":"General Kenobi."}'
    if [[ "$diarize" -eq 1 ]]; then
      emit '{"type":"progress","stage":"diarize","pct":0.5}'
      emit '{"type":"progress","stage":"diarize","pct":1}'
      emit '{"type":"progress","stage":"diarize","pct":1}'
      emit '{"type":"speakers","segments":[{"start":0,"end":2,"speaker":"S1"},{"start":2,"end":4,"speaker":"S2"}],"count":2}'
    fi
    emit '{"type":"done","durationSec":10}'
    ;;

  no-diarize*)
    emit '{"type":"ready","durationSec":5}'
    emit '{"type":"progress","stage":"transcribe","pct":0.5}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"segment","start":0,"end":2,"text":"Solo segment."}'
    emit '{"type":"done","durationSec":5}'
    ;;

  warning*)
    emit '{"type":"ready","durationSec":8}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"segment","start":0,"end":2,"text":"Text with degraded diarization."}'
    emit '{"type":"warning","code":"diarizationFailed","message":"model download failed"}'
    emit '{"type":"done","durationSec":8}'
    ;;

  startup-timeout*)
    # Never emits `ready` — exercises the startup timeout.
    snooze 30
    emit '{"type":"ready","durationSec":5}'
    emit '{"type":"done","durationSec":5}'
    ;;

  inactivity-timeout*)
    # Emits `ready` then falls silent — exercises the inactivity timeout.
    emit '{"type":"ready","durationSec":5}'
    snooze 30
    emit '{"type":"done","durationSec":5}'
    ;;

  diarize-silent-after-segments*)
    # Critical 1 regression fixture: emits ready, full transcribe progress,
    # and real segments — exactly what a completed transcription looks like
    # — then falls silent through what would be FluidAudio's un-instrumented
    # model-download/prepareModels() window (no `model_download` progress,
    # no keepalive tick, nothing) until the inactivity timeout fires. Proves
    # two things together: (a) the job DOES error with inactivityTimeout
    # (this scenario deliberately has no keepalive, unlike the real fixed
    # helper — see diarize-keepalive-then-done below for the counterpart
    # that proves ticks prevent this), and (b) the segments already emitted
    # before the silence are not lost — supervisor.ts's error-finalize paths
    # must persist them to transcript.json/srt even though the job ends in
    # "error", not "done".
    emit '{"type":"ready","durationSec":10}'
    emit '{"type":"progress","stage":"transcribe","pct":0.5}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"segment","start":0,"end":2,"text":"Hello there."}'
    emit '{"type":"segment","start":2,"end":4,"text":"General Kenobi."}'
    snooze 30
    emit '{"type":"done","durationSec":10}'
    ;;

  diarize-keepalive-then-done*)
    # Counterpart to diarize-silent-after-segments above: same setup
    # (ready, transcribe progress, segments), but instead of true silence,
    # emits periodic diarize-stage keepalive ticks
    # (progress{stage:"diarize",pct:0}) spanning a window LONGER than the
    # test's inactivity-timeout budget before finishing normally. Each tick
    # is spaced well under the inactivity budget, so none of them
    # individually would reset-and-then-immediately-expire; the cumulative
    # silent-if-not-for-ticks window exceeds the budget. If the job reaches
    # "done" here, the ticks — not luck — are what kept it alive; this is
    # the server-side half of the keepalive contract (the Swift-side half,
    # KeepAliveTicker actually emitting these ticks, is covered by the
    # helper build/E2E, not this fake-helper unit test).
    emit '{"type":"ready","durationSec":10}'
    emit '{"type":"progress","stage":"transcribe","pct":0.5}'
    emit '{"type":"progress","stage":"transcribe","pct":1}'
    emit '{"type":"segment","start":0,"end":2,"text":"Hello there."}'
    emit '{"type":"segment","start":2,"end":4,"text":"General Kenobi."}'
    for _ in $(seq 1 6); do
      snooze 0.15
      emit '{"type":"progress","stage":"diarize","pct":0}'
    done
    emit '{"type":"progress","stage":"diarize","pct":1}'
    emit '{"type":"speakers","segments":[{"start":0,"end":2,"speaker":"S1"},{"start":2,"end":4,"speaker":"S2"}],"count":2}'
    emit '{"type":"done","durationSec":10}'
    ;;

  stderr-then-hang*)
    # Writes diagnostics to stderr, then falls silent — exercises stderr
    # capture on a timeout-driven kill.
    echo "fake-helper: diagnostic line for stderr capture test" >&2
    emit '{"type":"ready","durationSec":5}'
    snooze 30
    emit '{"type":"done","durationSec":5}'
    ;;

  total-timeout*)
    # Keeps emitting activity (so inactivity never trips) but never finishes
    # — exercises the total-runtime timeout.
    emit '{"type":"ready","durationSec":0.01}'
    for _ in $(seq 1 200); do
      snooze 0.05
      emit '{"type":"progress","stage":"transcribe","pct":0.1}'
    done
    emit '{"type":"done","durationSec":0.01}'
    ;;

  helper-error*)
    emit '{"type":"ready","durationSec":3}'
    echo "fake-helper: diagnostic before terminal error" >&2
    emit '{"type":"error","code":"audioReadFailed","message":"could not read audio track"}'
    exit 1
    ;;

  crash-silent*)
    # Exits nonzero without ever emitting a terminal `done`/`error` event.
    emit '{"type":"ready","durationSec":3}'
    exit 1
    ;;

  orphan-exit*)
    # Exits (without a terminal event) while a backgrounded descendant is
    # still alive and holding stdout open — deliberately NOT run through
    # `snooze`/the SIGTERM trap, because the whole point is that bash exits
    # on its own (not via a signal we send) leaving the background job
    # orphaned. This exercises the exited-but-not-finalized race: the
    # supervisor must not resolve until its own inactivity-timeout backstop
    # finalizes the job, even though the process is technically gone.
    emit '{"type":"ready","durationSec":5}'
    sleep 1 &
    exit 1
    ;;

  *)
    emit '{"type":"ready","durationSec":1}'
    emit '{"type":"done","durationSec":1}'
    ;;
esac
