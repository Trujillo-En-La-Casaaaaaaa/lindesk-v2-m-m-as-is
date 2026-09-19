import pg from "pg";

/**
 * The only place a PostgreSQL connection pool is created. The connection string is always passed in
 * from configuration (`DATABASE_URL`); there is no fallback host, credential or alternate store.
 */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", (error: Error) => {
    // Idle-client errors must not take the process down; the next query opens a fresh connection.
    console.error(`postgres pool error: ${error.message}`);
  });
  return pool;
}
