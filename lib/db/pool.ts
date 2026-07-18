// pg Pool built from POSTGRES_* + CARRYOVER_DB_HOST/PORT (clientfirst pattern).
// LAZY on purpose: nothing here touches the network at module load, so `next build`
// succeeds with no database running. `pg` itself only dials on the first query.

import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.CARRYOVER_DB_HOST || "carryover-db",
      port: Number(process.env.CARRYOVER_DB_PORT || 5432),
      user: process.env.POSTGRES_USER || "carryover",
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB || "carryover",
    });
  }
  return pool;
}
