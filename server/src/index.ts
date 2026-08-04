import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, recoveredJobIds, supervisor } = buildApp(config);

  if (recoveredJobIds.length > 0) {
    app.log.info(
      { recoveredJobIds },
      `Marked ${recoveredJobIds.length} stale job(s) as interrupted after restart.`,
    );
  }

  // Minor finding 7: without this, Ctrl-C (SIGINT) or SIGTERM mid-job left
  // the helper child running (still holding a SpeechAnalyzer session) after
  // the server process itself exited. A subsequent server start + re-POST
  // of the same job would then run two analyses concurrently — exactly what
  // the concurrency-1 queue exists to prevent (spec §5). Kill the in-flight
  // helper (if any) before exiting; `killActive` is a safe no-op when idle.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    supervisor.killActive("SIGTERM");
    app
      .close()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Error while closing the server:", err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Loopback-only (spec §1): never bind 0.0.0.0. This is the sole security
  // boundary for an API with no authentication.
  await app.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`media-transcriber server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
