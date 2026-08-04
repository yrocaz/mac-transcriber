import { spawn } from "node:child_process";
import { z } from "zod";

const STATUS_TIMEOUT_MS = 5000;

const HelperStatusResponse = z.object({
  available: z.boolean(),
  supportedLocales: z.array(z.string()),
  installedLocales: z.array(z.string()),
});
export type HelperStatusResponse = z.infer<typeof HelperStatusResponse>;

/**
 * Spawns `helperPath status` and parses the JSON response.
 * Returns null on timeout or error (helper absent/failed).
 */
export async function getHelperStatus(helperPath: string): Promise<HelperStatusResponse | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let didTimeout = false;

    const child = spawn(helperPath, ["status"], { stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      didTimeout = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
    }, STATUS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (didTimeout || code !== 0) {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const validated = HelperStatusResponse.safeParse(parsed);
        if (validated.success) {
          resolve(validated.data);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}
