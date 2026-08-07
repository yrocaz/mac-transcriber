import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { getHelperStatus } from "../helperStatus";

export interface HealthRouteDeps {
  helperPath: string;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  const { helperPath } = deps;

  app.get("/health", async (_request, reply) => {
    let status: "ok" | "degraded" = "ok";

    // Check if helper binary exists and is executable.
    try {
      fs.accessSync(helperPath, fs.constants.F_OK | fs.constants.X_OK);
    } catch {
      status = "degraded";
      return reply.code(200).send({
        status,
        helper: null,
      });
    }

    // Attempt to get helper status.
    const statusResponse = await getHelperStatus(helperPath);
    if (!statusResponse) {
      status = "degraded";
    }

    return reply.code(200).send({
      status,
      helper: statusResponse,
    });
  });
}
