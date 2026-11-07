import { createApp } from "./bootstrap.ts";
import { AppLogger } from "./common/logger.ts";
import { ConfigError, describeConfig, loadConfig } from "./config/config.ts";
import { gracefulShutdown } from "./shutdown.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // Variable names and rules only; values are never printed.
    process.stderr.write(`${err instanceof ConfigError ? err.message : "Configuration could not be read."}\n`);
    process.exit(1);
  }
  const logger = new AppLogger(config.logLevel);
  const app = await createApp({ config, logger });
  await app.listen(config.port, config.host);
  logger.info("api listening", describeConfig(config));

  gracefulShutdown(app, logger, config.shutdownTimeoutMs);

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { reason: reason instanceof Error ? reason.name : "unknown" });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.name : "error"}\n`);
  process.exit(1);
});
