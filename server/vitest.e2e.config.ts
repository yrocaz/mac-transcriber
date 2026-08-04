import { defineConfig } from "vitest/config";

// Real end-to-end suite (spec §7): spawns the actual `speech-helper`
// release binary against real media fixtures — macOS only, not offline
// (the first diarization run downloads CoreML models from HuggingFace).
// Kept out of the default `npm test` / vitest.config.ts run so that stays
// fast and hermetic; run explicitly via `npm run test:e2e`.
//
// Generous timeouts: a 41.7s two-voice fixture plus a cold model download
// can legitimately take minutes on first run. Individual tests narrow this
// further where a tighter bound is safe.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
