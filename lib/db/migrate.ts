// Tiny migration runner (clientfirst pattern): applies db/migrations/*.sql in
// filename order, tracks applied files in schema_migrations, idempotent. Invoked
// from instrumentation.ts at every server start; a failing migration fails the
// boot (deliberate).
//
// The ordering/pending decisions are pure functions so they're testable with no DB.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_FILE = /^\d+_.+\.sql$/;

/** Pure: which directory entries are migrations, in apply order (zero-padded
 *  numeric prefixes make plain lexicographic order the numeric order). */
export function orderMigrations(files: string[]): string[] {
  return files.filter((f) => MIGRATION_FILE.test(f)).sort();
}

/** Pure: migrations still to apply, preserving apply order. */
export function pendingMigrations(available: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return orderMigrations(available).filter((f) => !done.has(f));
}

const LOCK_KEY = 727_004; // arbitrary app-wide advisory lock id (carryover = app #4)

/** Applies pending migrations; returns the filenames it applied. */
export async function runMigrations(
  pool: Pool,
  dir = path.join(process.cwd(), "db", "migrations"),
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Serialize concurrent boots (e.g. dev server + container) on one lock.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      const files = await readdir(dir);
      const { rows } = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      const pending = pendingMigrations(files, rows.map((r) => r.filename));
      for (const filename of pending) {
        const sql = await readFile(path.join(dir, filename), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
            filename,
          ]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${filename} failed: ${(err as Error).message}`);
        }
      }
      return pending;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Boot entry point (called from instrumentation.ts). Retries briefly in case the
 *  DB container is still coming up, then fails the boot — a server with missing
 *  schema would be broken anyway. */
export async function migrateAtBoot(): Promise<void> {
  const { getPool } = await import("./pool");
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await runMigrations(getPool());
      console.log(
        applied.length
          ? `[carryover] applied migrations: ${applied.join(", ")}`
          : "[carryover] migrations up to date",
      );
      return;
    } catch (err) {
      if (attempt >= attempts) {
        console.error("[carryover] migration runner failed:", err);
        throw err;
      }
      console.warn(
        `[carryover] migration attempt ${attempt}/${attempts} failed, retrying in 2s…`,
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
