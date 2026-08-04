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
 *  - CORE INVARIANT: `run()`'s promise resolves if and only if the job
 *    record has reached a terminal state (`finalized`) — see
 *    `maybeRefreshStderrAndResolve`, which gates on `exited && finalized`,
 *    not `exited` alone. An earlier version resolved on `exited` alone,
 *    which let the queue advance to the next job (and let GET /jobs/:id
 *    report a live "running" status) for a process that had exited but
 *    whose orphaned descendant was still holding stdout open — the actual
 *    finalize (from a timeout backstop) then happened *after* the promise
 *    had already resolved, and the fresh kill-grace timer it armed leaked
 *    because `resolveOnce`'s guard skipped clearing it on that second call.
 *    Fixed by (a) requiring `finalized` before resolving and (b) making
 *    `resolveOnce` clear the kill-grace timer unconditionally, every call,
 *    not only the first. The spawn-failure path is the one deliberate
 *    exception: it resolves directly since `exited` can never become true.
 */
export class HelperSupervisor {
  constructor(private readonly config: SupervisorConfig) {}

  /**
   * Count of this instance's currently-armed internal timers (startup,
   * inactivity, total-runtime, kill-grace). Test-only diagnostic: it must
   * be back to 0 once a `run()` call's promise has settled, and is how the
   * "no timer remains armed after settle" regression is verified.
   */
  private activeTimerCount = 0;

  get debugActiveTimerCount(): number {
    return this.activeTimerCount;
  }

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

      // Every internal setTimeout/clearTimeout goes through these two so
      // `activeTimerCount` — and therefore `debugActiveTimerCount` — stays
      // accurate. Tracked via a Set (not a raw increment/decrement) so that
      // a timer which fires naturally and one which gets explicitly cleared
      // afterward (e.g. a fired inactivity timer's own callback calling
      // `clearTimers()`, which touches the same now-stale handle) don't
      // double-decrement: `Set.delete` on an already-removed handle is a
      // safe no-op. `clearTimer` always returns `undefined`, so call sites
      // can write `x = clearTimer(x)` to clear-and-null in one step.
      const activeHandles = new Set<NodeJS.Timeout>();
      const armTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
        const handle = setTimeout(() => {
          activeHandles.delete(handle);
          this.activeTimerCount = activeHandles.size;
          fn();
        }, ms);
        activeHandles.add(handle);
        this.activeTimerCount = activeHandles.size;
        return handle;
      };
      const clearTimer = (handle: NodeJS.Timeout | undefined): undefined => {
        if (handle !== undefined && activeHandles.delete(handle)) {
          clearTimeout(handle);
          this.activeTimerCount = activeHandles.size;
        }
        return undefined;
      };

      const clearTimers = () => {
        startupTimer = clearTimer(startupTimer);
        inactivityTimer = clearTimer(inactivityTimer);
        totalTimer = clearTimer(totalTimer);
      };

      const resetInactivityTimer = () => {
        inactivityTimer = clearTimer(inactivityTimer);
        inactivityTimer = armTimer(
          () => finalizeError("inactivityTimeout", `Helper produced no events for ${timeouts.inactivityTimeoutMs}ms.`),
          timeouts.inactivityTimeoutMs,
        );
      };

      const armTotalTimer = (durationSec: number) => {
        const totalMs = Math.max(
          timeouts.totalRuntimeMultiplier * durationSec * 1000,
          timeouts.totalRuntimeFloorMs,
        );
        totalTimer = armTimer(
          () => finalizeError("totalTimeout", `Helper exceeded the total runtime budget (${totalMs}ms).`),
          totalMs,
        );
      };

      // Clears the kill-grace timer on EVERY call, not just the first —
      // otherwise a timer armed by a later, legitimate finalize (after an
      // earlier, incorrect resolve) would leak forever. See class docblock.
      const resolveOnce = () => {
        killTimer = clearTimer(killTimer);
        if (resolved) return;
        resolved = true;
        resolve();
      };

      /** Arms a SIGKILL safety net; resolves immediately only if the process has already exited. */
      const armKillGraceAndWait = () => {
        killTimer = armTimer(() => {
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

        // Write transcript files BEFORE marking job done (spec §5 ordering).
        // This ensures a job with status="done" always has its transcript files.
        // Any write errors are logged but don't prevent job completion.
        const currentJob = store.getJob(job.id);
        if (currentJob) {
          store.writeTranscripts(currentJob);
        }

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
      startupTimer = armTimer(
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
            startupTimer = clearTimer(startupTimer);
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

      // Only resolves once the job record has actually reached a terminal
      // state (`finalized`) AND the process is confirmed gone (`exited`).
      // See the class docblock's CORE INVARIANT note for why `exited` alone
      // is not sufficient.
      const maybeRefreshStderrAndResolve = () => {
        if (!exited || !finalized) return;
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

      rl.on("close", () => {
        stdoutClosed = true;
        // Only decide "died without a terminal event" once stdout has fully
        // drained AND the process has exited — see class-level notes.
        if (exited && !finalized) {
          finalizeUnexpectedExit(exitInfo?.code ?? null, exitInfo?.signal ?? null);
        }
        maybeRefreshStderrAndResolve();
      });

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
