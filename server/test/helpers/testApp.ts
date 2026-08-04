import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type BuiltApp } from "../../src/app";
import type { AppConfig, TimeoutConfig } from "../../src/config";
import { DEFAULT_TIMEOUTS } from "../../src/config";

export const FAKE_HELPER_PATH = path.join(__dirname, "..", "fixtures", "fake-helper.sh");
export const FIXTURE_MEDIA_DIR = path.join(__dirname, "..", "fixtures", "media");

export function fixtureMediaPath(name: string): string {
  return path.join(FIXTURE_MEDIA_DIR, name);
}

/**
 * Fast timeouts for tests that need to actually observe a timeout firing.
 * inactivityTimeoutMs is kept comfortably above the fake helper's
 * deliberate ~150ms mid-run pause (see fixtures/fake-helper.sh "basic"
 * scenario) so happy-path tests using these timeouts still complete
 * normally instead of tripping the inactivity timeout.
 */
export const FAST_TIMEOUTS: TimeoutConfig = {
  startupTimeoutMs: 80,
  inactivityTimeoutMs: 400,
  totalRuntimeMultiplier: 2,
  totalRuntimeFloorMs: 120,
  killGraceMs: 50,
};

export function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "media-transcriber-test-"));
}

export function buildTestApp(overrides: Partial<AppConfig> = {}): BuiltApp & { dataDir: string } {
  const dataDir = overrides.dataDir ?? makeTempDataDir();
  const config: AppConfig = {
    dataDir,
    helperPath: overrides.helperPath ?? FAKE_HELPER_PATH,
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 0,
    timeouts: { ...DEFAULT_TIMEOUTS, ...overrides.timeouts },
  };
  const built = buildApp(config);
  return { ...built, dataDir };
}

export function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
