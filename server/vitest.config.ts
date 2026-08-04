import { defineConfig } from "vitest/config";

// Fast, offline unit suite only (spec §7): fake-helper-backed tests, no real
// Swift binary, no network, no on-device models. `test/e2e/**` is excluded
// here on purpose — see vitest.e2e.config.ts and `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
