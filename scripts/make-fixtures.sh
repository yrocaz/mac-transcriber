#!/usr/bin/env bash
# scripts/make-fixtures.sh
#
# Regenerates the test-fixtures/ used by the unit tests, E2E tests, and
# manual verification. Safe to re-run: each fixture is rebuilt from scratch
# (temp files cleaned up, output overwritten atomically via a temp path +
# mv), and no external state is mutated other than the fixture files
# themselves.
#
# What this script generates (macOS `say` + `afconvert`, both system tools,
# no network, no third-party encoder):
#   - test-fixtures/speech-short.aiff     single-voice, ~2 sentences
#   - test-fixtures/two-voice-interview.wav   6-turn interview, 2 alternating voices
#   - test-fixtures/malformed.mp3         synthetic malformed-MP3 (see below) — best effort
#
# Note on determinism: `say`'s synthesis for a given voice/text/OS build is
# stable, but SpeechAnalyzer's ASR of that audio can shift slightly across
# macOS/model updates (e.g. punctuation, whether two sentences land as one
# segment or two) — verified while writing this script: a freshly generated
# speech-short.aiff transcribed to "...dog, Apple speech analyzer runs..."
# (one segment) vs. the currently-committed file's "...dog." / "Apple's
# speech analyzer runs..." (two segments, apostrophe intact). Both are
# correct, faithful transcriptions of real speech; they just aren't
# byte-identical or segmentation-identical. The E2E suite's assertions are
# written to tolerate this (substring/structural checks, not exact-string
# equality) for exactly this reason. Re-run this script when you need to
# regenerate a missing/corrupted fixture from scratch; if you re-run it
# against an already-working checkout, diff the result before committing —
# don't blindly replace fixtures other tests/reports already depend on.
#
# What this script does NOT generate (documented, not regenerated here):
#   - test-fixtures/sample-5s.mp4 — downloaded from samplelib.com (a short
#     music/no-speech mp4 with an AAC audio track), used to verify container
#     handling per docs/research/spikes/README.md. Re-download manually from
#     https://samplelib.com/sample-mp4.html if it's ever lost; there is
#     nothing to regenerate deterministically for it, so this script leaves
#     it alone.
#
# Requirements: macOS with `say` and `afconvert` (both ship with the OS).
# python3 (ships with macOS) is used for WAV concatenation and the malformed
# MP3 byte-surgery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/test-fixtures"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${FIXTURES_DIR}"

log() { echo "[make-fixtures] $*"; }

# ---------------------------------------------------------------------------
# 1. speech-short.aiff — single voice, known content, used by unit-adjacent
#    E2E "single-voice fixture -> transcript matches known content" case.
# ---------------------------------------------------------------------------
make_speech_short() {
  local out="${FIXTURES_DIR}/speech-short.aiff"
  local tmp="${TMP_DIR}/speech-short.aiff"
  local text="The quick brown fox jumps over the lazy dog. Apple's speech analyzer runs entirely on device."

  log "Generating speech-short.aiff (voice: Samantha)..."
  say -v Samantha -o "${tmp}" "${text}"
  mv "${tmp}" "${out}"
  log "  -> ${out} ($(stat -f%z "${out}") bytes)"
}

# ---------------------------------------------------------------------------
# 2. two-voice-interview.wav — 6 alternating turns, two distinct `say`
#    voices (Samantha / Daniel), 0.6s silence gaps. Used by the E2E
#    "two-voice fixture -> speakerCount 2, S1/S2" case.
# ---------------------------------------------------------------------------
make_two_voice_interview() {
  local out="${FIXTURES_DIR}/two-voice-interview.wav"
  log "Generating two-voice-interview.wav (voices: Samantha / Daniel)..."

  # Alternating (voice, text) turns. Text approximates a short podcast-style
  # interview; content only needs to be real, well-formed English speech —
  # the E2E test checks structural properties (speaker count, segment
  # speaker labels), not exact wording.
  local voices=(Samantha Daniel Samantha Daniel Samantha Daniel)
  local texts=(
    "Thanks for joining me today. Can you tell our listeners a bit about your background in software engineering?"
    "Sure, happy to. I've been building distributed systems for about twelve years now, starting out at a small startup in Seattle."
    "That's fascinating. What got you interested in that particular area of engineering in the first place?"
    "Honestly, it was curiosity. I kept running into problems where a single server just could not keep up, and I wanted to understand exactly why."
    "Looking back, is there anything you would have done differently early in your career?"
    "I would have asked for help sooner. I spent way too long trying to solve hard problems entirely on my own."
  )

  local wav_parts=()
  for i in "${!voices[@]}"; do
    local aiff="${TMP_DIR}/turn_${i}.aiff"
    local wav="${TMP_DIR}/turn_${i}.wav"
    say -v "${voices[$i]}" -o "${aiff}" "${texts[$i]}"
    # Normalize to mono 16-bit PCM WAV @ 22050 Hz (matches the committed
    # fixture's format) — say's AIFC output uses a compression tag Python's
    # stdlib `aifc` module can't parse, so afconvert does the AIFC -> PCM
    # WAV step (Task 2's documented approach).
    afconvert -f WAVE -d LEI16@22050 -c 1 "${aiff}" "${wav}"
    wav_parts+=("${wav}")
  done

  python3 - "${out}" 0.6 "${wav_parts[@]}" <<'PYEOF'
import sys
import wave

out_path = sys.argv[1]
gap_sec = float(sys.argv[2])
parts = sys.argv[3:]

with wave.open(parts[0], "rb") as w0:
    params = w0.getparams()
nchannels, sampwidth, framerate = params.nchannels, params.sampwidth, params.framerate
silence = b"\x00" * int(gap_sec * framerate) * sampwidth * nchannels

frames = []
for i, p in enumerate(parts):
    with wave.open(p, "rb") as w:
        assert w.getframerate() == framerate and w.getsampwidth() == sampwidth, (
            f"turn {i} format mismatch: {w.getparams()} vs {params}"
        )
        frames.append(w.readframes(w.getnframes()))
    if i < len(parts) - 1:
        frames.append(silence)

with wave.open(out_path, "wb") as out:
    out.setnchannels(nchannels)
    out.setsampwidth(sampwidth)
    out.setframerate(framerate)
    out.writeframes(b"".join(frames))

print(f"wrote {out_path}: {sum(len(f) for f in frames)} bytes of frame data")
PYEOF

  log "  -> ${out} ($(stat -f%z "${out}") bytes)"
}

# ---------------------------------------------------------------------------
# 3. malformed.mp3 — synthetic malformed MP3 exercising the helper's
#    tail-probe/repair branch (AudioPreparer.swift, the AVAssetExportSession
#    M4A re-export path for MP3s that misreport their packet count).
#
# Carried gap from Task 1: no MP3 encoder is available here (afconvert
# decodes MP3 but can't encode it; no lame/ffmpeg/sox). This constructs the
# malformed file from a real, well-formed MP3 macOS ships as a system voice-
# enrollment prompt (PersonalAudio.framework), prepending one synthetic MPEG
# frame with a lying "Xing" VBR header (same version/layer/bitrate/rate/
# channel-mode as the real stream, so it parses as an ordinary frame, but
# its frame-count field claims 4x the real count) — the exact bug class
# yap's fix targets: AVAudioFile.length ends up larger than what's actually
# decodable, so the tail-probe's read comes up short and repair triggers.
#
# NOT committed to git (deliberately gitignored below): the output is
# ~99.9% byte-identical to Apple's shipped audio resource, which isn't ours
# to redistribute. This fixture only exists after running this script, and
# the E2E case that depends on it skips loudly (not silently) when it's
# absent, naming this script as the fix.
# ---------------------------------------------------------------------------
make_malformed_mp3() {
  local src="/System/Library/PrivateFrameworks/PersonalAudio.framework/Versions/A/Resources/Enrollment_1.mp3"
  local out="${FIXTURES_DIR}/malformed.mp3"

  if [[ ! -f "${src}" ]]; then
    log "WARNING: source system MP3 not found at:"
    log "  ${src}"
    log "  Skipping malformed.mp3 regeneration (this is a known, OS-version-"
    log "  dependent path). If test-fixtures/malformed.mp3 already exists,"
    log "  it is left untouched; the MP3-repair E2E case will use it as-is."
    log "  If it does not exist, that E2E case will skip cleanly."
    return 0
  fi

  log "Generating malformed.mp3 (source: ${src})..."
  python3 - "${src}" "${out}" <<'PYEOF'
import sys

src_path, out_path = sys.argv[1], sys.argv[2]

with open(src_path, "rb") as f:
    data = f.read()

# Locate the first MPEG audio frame sync word (11 set bits: 0xFF followed by
# top 3 bits of the next byte also set) by scanning rather than trusting a
# hardcoded offset, since ID3v2 tag size can vary across OS versions.
pos = 0
while pos + 4 <= len(data):
    if data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0:
        break
    pos += 1
else:
    raise SystemExit("no MPEG frame sync found in source file")

audio_offset = pos
header = data[audio_offset:audio_offset + 4]

# Decode just enough of the header to compute frame size and the Xing tag
# offset (works for the MPEG1/2 Layer III, no-CRC headers `say`/afconvert-
# adjacent system audio actually uses; good enough for this fixture, not a
# general-purpose MP3 parser).
b1, b2, b3 = header[1], header[2], header[3]
mpeg_version_bits = (b1 >> 3) & 0x3  # 11=MPEG1, 10=MPEG2, 00=MPEG2.5
is_mpeg1 = mpeg_version_bits == 0b11
bitrate_index = (b2 >> 4) & 0xF
srate_index = (b2 >> 2) & 0x3
channel_mode = (b3 >> 6) & 0x3
is_mono = channel_mode == 0b11

mpeg1_bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
mpeg2_bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
mpeg1_srates = [44100, 48000, 32000, 0]
mpeg2_srates = [22050, 24000, 16000, 0]

bitrate_kbps = (mpeg1_bitrates if is_mpeg1 else mpeg2_bitrates)[bitrate_index]
samplerate = (mpeg1_srates if is_mpeg1 else mpeg2_srates)[srate_index]
if not bitrate_kbps or not samplerate:
    raise SystemExit(f"unsupported/free bitrate or reserved sample rate in source header: {header.hex()}")

multiplier = 144 if is_mpeg1 else 72
frame_size = (multiplier * bitrate_kbps * 1000) // samplerate  # padding bit assumed 0, matches source

if is_mpeg1:
    side_info = 17 if is_mono else 32
else:
    side_info = 9 if is_mono else 17
xing_offset = 4 + side_info

# Count the real frames actually present (sanity/inflation baseline only —
# not written anywhere sensitive).
scan = audio_offset
real_frames = 0
while scan + 4 <= len(data) and data[scan] == 0xFF and (data[scan + 1] & 0xE0) == 0xE0:
    real_frames += 1
    scan += frame_size
if real_frames < 10:
    raise SystemExit(f"only {real_frames} real frames found — source file too short for a convincing fixture")

inflated_frames = real_frames * 4

xing_frame = bytearray(frame_size)
xing_frame[0:4] = header
xing_frame[xing_offset:xing_offset + 4] = b"Xing"
xing_frame[xing_offset + 4:xing_offset + 8] = (1).to_bytes(4, "big")  # flags: FRAMES field present
xing_frame[xing_offset + 8:xing_offset + 12] = inflated_frames.to_bytes(4, "big")  # the lie

out_bytes = data[:audio_offset] + bytes(xing_frame) + data[audio_offset:]
with open(out_path, "wb") as f:
    f.write(out_bytes)

print(
    f"wrote {out_path}: {len(out_bytes)} bytes "
    f"(real frames={real_frames}, declared frames={inflated_frames}, "
    f"real ~{real_frames * (1152 if is_mpeg1 else 576) / samplerate:.1f}s, "
    f"declared ~{inflated_frames * (1152 if is_mpeg1 else 576) / samplerate:.1f}s)"
)
PYEOF
  log "  -> ${out} ($(stat -f%z "${out}") bytes)"
}

make_speech_short
make_two_voice_interview
make_malformed_mp3

log "Done. sample-5s.mp4 is external (samplelib.com) and not regenerated by this script."
