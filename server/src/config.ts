import path from "node:path";

// Repo root is two levels up from this file whether it runs from src/ (tsx)
// or dist/ (compiled): server/src/config.ts -> server -> repo root, and
// server/dist/config.js -> server -> repo root.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface TimeoutConfig {
  /** Spec §6: 60s from spawn to the `ready` event. */
  startupTimeoutMs: number;
  /** Spec §6: 120s with no NDJSON event of any type. */
  inactivityTimeoutMs: number;
  /** Spec §6: max(2 * durationSec, 10 min), armed once `ready` arrives. */
  totalRuntimeMultiplier: number;
  totalRuntimeFloorMs: number;
  /** Grace period between SIGTERM and a follow-up SIGKILL when killing a stuck helper. */
  killGraceMs: number;
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  startupTimeoutMs: 60_000,
  inactivityTimeoutMs: 120_000,
  totalRuntimeMultiplier: 2,
  totalRuntimeFloorMs: 10 * 60 * 1000,
  killGraceMs: 3_000,
};

/** Only en-* locales are installed on this machine today (spec constraints); en-US is the sensible default when a POST omits `locale`. */
export const DEFAULT_LOCALE = "en-US";

export interface AppConfig {
  dataDir: string;
  helperPath: string;
  host: string;
  port: number;
  timeouts: TimeoutConfig;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir:
      overrides.dataDir ??
      process.env.TRANSCRIBER_DATA_DIR ??
      path.join(REPO_ROOT, "data"),
    helperPath:
      overrides.helperPath ??
      process.env.TRANSCRIBER_HELPER_PATH ??
      path.join(REPO_ROOT, "helper", ".build", "release", "speech-helper"),
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.PORT ?? 4173),
    timeouts: { ...DEFAULT_TIMEOUTS, ...overrides.timeouts },
  };
}
