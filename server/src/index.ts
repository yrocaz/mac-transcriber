import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, recoveredJobIds } = buildApp(config);

  if (recoveredJobIds.length > 0) {
    app.log.info(
      { recoveredJobIds },
      `Marked ${recoveredJobIds.length} stale job(s) as interrupted after restart.`,
    );
  }

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
