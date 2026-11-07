import type { INestApplication } from "@nestjs/common";
import type { AppLogger } from "./common/logger.ts";

/**
 * Closes the application: stop accepting connections, let in-flight requests finish, then Nest runs the
 * module destroy hooks (rate limiter, database pool). A timer forces exit if that takes too long.
 */
export async function closeApp(app: INestApplication, logger: AppLogger, timeoutMs: number): Promise<void> {
  const server = app.getHttpServer() as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
  const timer = setTimeout(() => {
    logger.error("shutdown timed out, closing remaining connections");
    server.closeAllConnections?.();
  }, timeoutMs);
  timer.unref();
  try {
    server.closeIdleConnections?.();
    await app.close();
  } finally {
    clearTimeout(timer);
  }
}

export function gracefulShutdown(app: INestApplication, logger: AppLogger, timeoutMs: number): void {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info("shutting down", { signal });
    const hard = setTimeout(() => process.exit(1), timeoutMs + 2_000);
    hard.unref();
    closeApp(app, logger, timeoutMs).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
}
