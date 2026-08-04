#!/usr/bin/env bash
# helper/scripts/swift-test.sh
#
# Wrapper around `swift test` that works around a Command Line Tools-only
# toolchain limitation: swift-testing's `Testing.framework` ships under
# `/Library/Developer/CommandLineTools/Library/Developer/Frameworks` (or the
# equivalent path under a full Xcode.app's DEVELOPER_DIR), but SwiftPM's
# decision to actually *invoke* the test runner keys off top-level
# `-Xswiftc`/`-Xlinker` CLI flags — NOT target-level `unsafeFlags` in
# Package.swift. Confirmed empirically on this machine (Command Line Tools
# only, no Xcode.app — `xcodebuild -version` fails with "requires Xcode"):
#
#   - Package.swift alone (target swiftSettings/linkerSettings baking the
#     framework search path + rpath into the built test binary) fixes
#     *compilation* ("no such module 'Testing'") and *linking/loading*
#     (`otool -l` shows the correct LC_RPATH entries; the binary dlopens
#     Testing.framework and lib_TestingInterop.dylib fine when invoked
#     directly). It does NOT make bare `swift test` execute the suite:
#     confirmed by temporarily adding a deliberately-failing test and running
#     bare `swift test` — exit 0, zero output, even with a guaranteed
#     failure present. That is not a display/capture quirk (a quirk cannot
#     turn a failing test into a clean exit); SwiftPM's own pre-flight
#     detection of "is swift-testing available" apparently doesn't consult
#     the target's own build settings, so it silently skips running.
#   - `swift test` given the same search-path flags on ITS OWN command line
#     (`-Xswiftc -F <dir> -Xlinker -F <dir> -Xlinker -rpath -Xlinker <dir>`)
#     reliably builds AND runs the suite, with correct pass/fail reporting.
#
# So: this script supplies those flags on the CLI, every time, rather than
# relying on the manifest alone. Package.swift's settings are still required
# (they're what make direct/manual invocation of the built binary work, and
# don't hurt `swift build -c release`), but this wrapper is the reliable way
# to actually *run* `swift test` on this toolchain. See README's Development
# notes section for the full writeup.
#
# On a full Xcode.app install, or a future toolchain where this SwiftPM
# limitation is fixed, the search-path flags are simply redundant (the
# framework is already found normally) — this script degrades to a thin
# `swift test` passthrough rather than breaking anything.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Same candidate-directory probe as Package.swift's swiftTestingSearchDirectories():
# prefer $DEVELOPER_DIR if set, then the Command Line Tools' own fixed path.
candidates=()
if [[ -n "${DEVELOPER_DIR:-}" ]]; then
  candidates+=("${DEVELOPER_DIR}")
fi
candidates+=("/Library/Developer/CommandLineTools")

frameworks_dir=""
for dev_dir in "${candidates[@]}"; do
  if [[ -d "${dev_dir}/Library/Developer/Frameworks/Testing.framework" ]]; then
    frameworks_dir="${dev_dir}/Library/Developer/Frameworks"
    lib_dir="${dev_dir}/Library/Developer/usr/lib"
    break
  fi
done

cd "${HELPER_DIR}"

if [[ -z "${frameworks_dir}" ]]; then
  echo "swift-test.sh: no local Testing.framework found under DEVELOPER_DIR or the Command Line Tools path; running plain 'swift test'." >&2
  exec swift test "$@"
fi

echo "swift-test.sh: using swift-testing search path: ${frameworks_dir}" >&2
exec swift test \
  -Xswiftc -F -Xswiftc "${frameworks_dir}" \
  -Xlinker -F -Xlinker "${frameworks_dir}" \
  -Xlinker -rpath -Xlinker "${frameworks_dir}" \
  -Xlinker -rpath -Xlinker "${lib_dir}" \
  "$@"
