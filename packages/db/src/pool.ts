import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult<R extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<R>;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  /** Per-statement timeout. Default 15 s. */
  statementTimeoutMs?: number;
  /** Kills sessions that sit idle inside a transaction (a leaked client). Default 30 s. */
  idleInTransactionTimeoutMs?: number;
}

export function createPool(options: PoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "qenbel-admin",
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // An error on an idle client must not crash the process. Message only: never log the connection string.
  pool.on("error", (err) => {
    process.stderr.write(`[db] idle client error: ${err.message}\n`);
  });
  return pool;
}
