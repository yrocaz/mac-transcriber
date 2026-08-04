import { spawn } from "node:child_process";
import readline from "node:readline";
import type { TimeoutConfig } from "./config";
import { MonotonicProgress } from "./progress";
import { HelperEvent } from "./types";
import type { JobRecord } from "./types";
import type { JobStore } from "./jobStore";

const STDERR_TAIL_LIMIT = 8_000;

export interface SupervisorConfig {
  helperPath: string;
  timeouts: TimeoutConfig;
}

/**
 * Spawns `speech-helper transcribe`, parses its NDJSON stdout, drives the
 * three timeouts and the monotonic progress mapping (spec §6), and persists
 * results into the JobStore as events arrive. One instance handles one job
 * run; the caller (the queue worker) awaits `run()` to completion before
 * starting the next job, which is what gives concurrency 1 its guarantee
 * that only one helper process is ever alive at a time.
 *
 * Process-lifecycle notes (subtle, worth preserving if this gets touched):
 *  - The promise resolves off the child's `'exit'` event, not `'close'`.
 *    On a timeout kill, SIGTERM only reaches the immediate child (bash); an
 *    orphaned grandchild (e.g. a `sleep` the fake helper spawned) can keep
 *    inheriting the stdout/stderr fds and hold the pipes open long after
 *    the helper itself is gone, so `'close'` (which waits for stdio to
 *    fully drain) would block for as long as that grandchild lives. `'exit'`
 *    fires as soon as the process we actually spawned terminates.
 *  - A spawn-level failure (e.g. ENOENT) never produces an `'exit'` event
 *    (there's no process), so that path resolves directly rather than
 *    waiting for one — otherwise the queue would wedge on every subsequent
 *    job forever.
 *  - `'exit'` can fire before readline has delivered the last buffered
 *    stdout line (Node doesn't guarantee stdout is drained first), so the
 *    "process died without a terminal event" fallback only fires once BOTH
 *    the process has exited AND stdout has closed — otherwise a fast final
 *    `done`/`error` line could lose a race against `'exit'` and get
 *    mismarked as an unexplained crash.
 */
export class HelperSupervisor {
  constructor(private readonly config: SupervisorConfig) {}

  run(job: JobRecord, store: JobStore): Promise<void> {
    return new Promise((resolve) => {
      const { helperPath, timeouts } = this.config;
      const args = [
        "transcribe",
        "--input",
        job.path,
        "--locale",
        job.locale,
        ...(job.diarize ? [] : ["--no-diarize"]),
      ];

      store.updateJob(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });

      const child = spawn(helperPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      const progress = new MonotonicProgress(job.diarize);
      let finalized = false;
      let resolved = false;
      let exited = false;
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let stdoutClosed = false;
      let stderrTail = "";
      let killTimer: NodeJS.Timeout | undefined;

      let startupTimer: NodeJS.Timeout | undefined;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;

      const clearTimers = () => {
        if (startupTimer) clearTimeout(startupTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (totalTimer) clearTimeout(totalTimer);
      };

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(
          () => finalizeError("inactivityTimeout", `Helper produced no events for ${timeouts.inactivityTimeoutMs}ms.`),
          timeouts.inactivityTimeoutMs,
        );
      };

      const armTotalTimer = (durationSec: number) => {
        const totalMs = Math.max(
          timeouts.totalRuntimeMultiplier * durationSec * 1000,
          timeouts.totalRuntimeFloorMs,
        );
        totalTimer = setTimeout(
          () => finalizeError("totalTimeout", `Helper exceeded the total runtime budget (${totalMs}ms).`),
          totalMs,
        );
      };

      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };

      /** Arms a SIGKILL safety net and waits for the canonical `exited` flag; does not resolve directly. */
      const armKillGraceAndWait = () => {
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, timeouts.killGraceMs);
        if (exited) resolveOnce();
      };

      const finalizeError = (code: string, message: string) => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        store.updateJob(job.id, {
          status: "error",
          error: { code, message },
          finishedAt: new Date().toISOString(),
          stderrTail: stderrTail || null,
        });
        try {
          child.kill("SIGTERM");
        } catch {
          // already dead
        }
        armKillGraceAndWait();
      };

      const finalizeDone = (durationSec: number) => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        store.updateJob(job.id, {
          status: "done",
          progress: 1,
          durationSec,
          finishedAt: new Date().toISOString(),
        });
        armKillGraceAndWait();
      };

      const finalizeHelperError = (code: string, message: string) => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        store.updateJob(job.id, {
          status: "error",
          error: { code, message },
          finishedAt: new Date().toISOString(),
          stderrTail: stderrTail || null,
        });
        armKillGraceAndWait();
      };

      const finalizeUnexpectedExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        store.updateJob(job.id, {
          status: "error",
          error: {
            code: "unknown",
            message: `Helper exited unexpectedly (code=${exitCode ?? "null"}, signal=${signal ?? "null"}) without a terminal event.`,
          },
          finishedAt: new Date().toISOString(),
          stderrTail: stderrTail || null,
        });
      };

      // Startup timeout: 60s from spawn to `ready` (spec §6).
      startupTimer = setTimeout(
        () => finalizeError("startupTimeout", `Helper did not emit 'ready' within ${timeouts.startupTimeoutMs}ms.`),
        timeouts.startupTimeoutMs,
      );
      resetInactivityTimer();

      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
      });

      child.on("error", (err) => {
        // Spawn-level failure (e.g. ENOENT): no process exists, so no
        // `'exit'` event will ever follow. Finalize the job record and
        // resolve directly — waiting here would wedge the queue on every
        // job after this one.
        finalizeHelperError("spawnFailed", `Failed to launch helper: ${err.message}`);
        resolveOnce();
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (finalized) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        resetInactivityTimer();

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(trimmed);
        } catch {
          return; // non-JSON noise; activity already counted above
        }
        const result = HelperEvent.safeParse(parsedJson);
        if (!result.success) return; // unknown event shape; ignore defensively
        const event = result.data;

        switch (event.type) {
          case "ready": {
            if (startupTimer) clearTimeout(startupTimer);
            store.updateJob(job.id, { durationSec: event.durationSec });
            armTotalTimer(event.durationSec);
            break;
          }
          case "model_download": {
            // No overall-progress contribution defined in spec §6; the
            // inactivity reset above is what keeps the job alive during
            // long first-run model downloads.
            break;
          }
          case "progress": {
            const overall = progress.apply(event.stage, event.pct);
            store.updateJob(job.id, { progress: overall });
            break;
          }
          case "segment": {
            const current = store.getJob(job.id);
            const segments = current
              ? [...current.segments, { start: event.start, end: event.end, text: event.text }]
              : [{ start: event.start, end: event.end, text: event.text }];
            store.updateJob(job.id, { segments });
            break;
          }
          case "speakers": {
            store.updateJob(job.id, {
              speakers: { segments: event.segments, count: event.count },
            });
            break;
          }
          case "warning": {
            const current = store.getJob(job.id);
            const warnings = current
              ? [...current.warnings, { code: event.code, message: event.message }]
              : [{ code: event.code, message: event.message }];
            store.updateJob(job.id, { warnings });
            break;
          }
          case "done": {
            finalizeDone(event.durationSec);
            break;
          }
          case "error": {
            finalizeHelperError(event.code, event.message);
            break;
          }
        }
      });

      rl.on("close", () => {
        stdoutClosed = true;
        // Only decide "died without a terminal event" once stdout has fully
        // drained AND the process has exited — see class-level notes.
        if (exited && !finalized) {
          finalizeUnexpectedExit(exitInfo?.code ?? null, exitInfo?.signal ?? null);
        }
        maybeRefreshStderrAndResolve();
      });

      const maybeRefreshStderrAndResolve = () => {
        if (!exited) return;
        // Best-effort: stderr is a separate pipe with no ordering guarantee
        // against stdout/exit, so re-persist the latest tail once we're as
        // settled as we're going to get, in case more arrived after the
        // job was first marked errored.
        const current = store.getJob(job.id);
        if (current && current.status === "error" && stderrTail && current.stderrTail !== stderrTail) {
          store.updateJob(job.id, { stderrTail });
        }
        resolveOnce();
      };

      child.on("exit", (exitCode, signal) => {
        exited = true;
        exitInfo = { code: exitCode, signal };
        if (!finalized && stdoutClosed) {
          finalizeUnexpectedExit(exitCode, signal);
        }
        maybeRefreshStderrAndResolve();
      });
    });
  }
}
