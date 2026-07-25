// POST /api/admin/query — the Lithe admin SQL console for THIS app's database.
//
// Lithe never holds an app's DB credentials (apps/README.md: "each app owns its
// own database"), so a platform-wide query console can't live in Core. Instead
// each app exposes this one endpoint against its own pool, and Lithe Studio's
// "Data" tab just POSTs here through the existing gateway
// (/apps/<slug>/api/admin/query). Studio learns nothing app-specific; an app
// that doesn't implement this simply 404s and Studio says so.
//
// PORTABILITY: this file depends only on (a) the app's pg pool and (b)
// LITHE_CORE_INTERNAL_URL. Copy it into any Lithe app, repoint the pool import,
// and it works — no shared package, no Lithe edits.
//
// AUTHORIZATION is Core's answer, never the client's claim: we forward the
// caller's bearer to Core /v1/me, which verifies the JWT signature against
// Zitadel's JWKS and returns the platform role. A forged or expired token can't
// get past it, and only role === "admin" proceeds. The gateway is public by
// design ("each app gates itself on login"), so this check IS the security
// boundary — keep it first, and keep it server-side.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Runs raw operator SQL: never prerender, never cache.
export const dynamic = "force-dynamic";

const STATEMENT_TIMEOUT = "15s"; // a runaway query can't wedge the app's pool
const MAX_ROWS = 1000; // cap what we serialize back to the browser

type CoreMe = { role?: string; email?: string; displayName?: string };

/** Resolve the caller through Core. Returns null unless they're a platform admin. */
async function requireLitheAdmin(req: NextRequest): Promise<CoreMe | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;

  const core = (process.env.LITHE_CORE_INTERNAL_URL || "http://core:8080").replace(/\/+$/, "");
  try {
    const res = await fetch(`${core}/v1/me`, {
      headers: { authorization: auth },
      cache: "no-store",
    });
    if (!res.ok) return null; // 401 = bad/expired token
    const me = (await res.json()) as CoreMe;
    return me.role === "admin" ? me : null;
  } catch {
    return null; // Core unreachable — fail closed
  }
}

/** Heuristic: does this look like anything other than a plain read? */
function looksLikeWrite(sql: string): boolean {
  // Strip line/block comments and leading whitespace before sniffing the verb,
  // so "/* hi */ delete from x" can't masquerade as a read.
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .toLowerCase();
  return !/^(select|with|explain|show|table|values)\b/.test(bare);
}

export async function POST(req: NextRequest) {
  const admin = await requireLitheAdmin(req);
  if (!admin) return NextResponse.json({ error: "admin only" }, { status: 403 });

  let body: { sql?: unknown; allowWrite?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const sql = typeof body.sql === "string" ? body.sql.trim() : "";
  const allowWrite = body.allowWrite === true;
  if (!sql) return NextResponse.json({ error: "sql is required" }, { status: 400 });

  // Two independent gates, because a regex alone is not a security control:
  // the sniff gives a clear error, and READ ONLY makes Postgres itself refuse
  // any write that slipped past it.
  const write = looksLikeWrite(sql);
  if (write && !allowWrite) {
    return NextResponse.json(
      { error: "this statement writes — re-run with write mode enabled" },
      { status: 400 },
    );
  }

  const started = Date.now();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(allowWrite ? "BEGIN" : "BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    // No parameters: node-pg uses the simple protocol, so a pasted script of
    // several statements works and comes back as an array — report the last.
    const raw = await client.query({ text: sql, rowMode: "array" });
    await client.query("COMMIT");

    const result = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const rows = (result?.rows ?? []) as unknown[][];
    // Dates/buffers don't survive JSON round-tripping usefully — stringify to
    // what the operator would have seen in psql.
    const cells = rows.slice(0, MAX_ROWS).map((r) =>
      r.map((v) =>
        v === null || v === undefined
          ? null
          : v instanceof Date
            ? v.toISOString()
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v),
      ),
    );

    console.log(
      `[admin-query] ${admin.email ?? "admin"} ${write ? "WRITE" : "read"} ok ` +
        `(${result?.rowCount ?? 0} rows, ${Date.now() - started}ms): ${sql.slice(0, 200)}`,
    );

    return NextResponse.json({
      columns: (result?.fields ?? []).map((f: { name: string }) => f.name),
      rows: cells,
      rowCount: result?.rowCount ?? 0,
      command: result?.command ?? "",
      statements: Array.isArray(raw) ? raw.length : 1,
      truncated: rows.length > MAX_ROWS,
      elapsedMs: Date.now() - started,
      wrote: write,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[admin-query] ${admin.email ?? "admin"} FAILED: ${msg}`);
    // Postgres' own message is the whole value of a console — pass it through.
    return NextResponse.json({ error: msg }, { status: 400 });
  } finally {
    client.release();
  }
}
