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
// caller's bearer to Core /v1/admin/session, which only answers 200 for a
// platform admin holding a token minted for LITHE STUDIO. The gateway is public
// by design ("each app gates itself on login"), so this check IS the security
// boundary — keep it first, and keep it server-side.
//
// It used to ask /v1/me and read `role`. That verified the token and the role
// but not which app the token was FOR — and Core accepts a token minted for any
// registered app on /v1/me, by design. So an admin's token lifted from any one
// app (breezy-bets is public; an XSS or a leaked log line is enough) would run
// arbitrary SQL, writes included, against this app's database. Core's own admin
// routes closed that hole in July by requiring a Studio token; /v1/admin/session
// sits behind the same gate, so this console now inherits it. A Core too old to
// have the route answers 404 and the console fails closed.
//
// THE CONNECTION IS THROWAWAY. Operator SQL can change session state — SET
// search_path, SET ROLE, an explicit COMMIT that ends our transaction — and a
// pooled connection carries that into whichever request borrows it next. So the
// limits below are set at session level (they outlive a COMMIT inside the
// script), and the connection is destroyed afterwards instead of being released.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Runs raw operator SQL: never prerender, never cache.
export const dynamic = "force-dynamic";

const STATEMENT_TIMEOUT = "15s"; // a runaway query can't wedge the app's pool
const MAX_ROWS = 1000; // cap what we serialize back to the browser
const CORE_TIMEOUT_MS = 5000; // Core is one hop away in-network; don't hang on it

type CoreMe = { role?: string; email?: string; displayName?: string };

/** Resolve the caller through Core. Returns null unless they're a platform admin. */
async function requireLitheAdmin(req: NextRequest): Promise<CoreMe | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;

  const core = (process.env.LITHE_CORE_INTERNAL_URL || "http://core:8080").replace(/\/+$/, "");
  try {
    const res = await fetch(`${core}/v1/admin/session`, {
      headers: { authorization: auth },
      cache: "no-store",
      signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
    });
    // 401 = bad/expired token, 403 = not an admin or not a Studio token,
    // 404 = a Core that predates the route. All of them mean no.
    if (!res.ok) return null;
    const me = (await res.json()) as CoreMe;
    return me.role === "admin" ? me : null;
  } catch {
    return null; // Core unreachable or slow — fail closed
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
  // the sniff gives a clear error, and a read-only SESSION makes Postgres itself
  // refuse any write that slipped past it.
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
    // Session-level, not SET LOCAL / BEGIN READ ONLY alone. Those end with the
    // transaction, and the script below is free to end it: "select 1; commit;
    // delete from x" passed the sniff (it starts with select), committed our
    // read-only transaction, and ran the delete in a fresh read-write one with no
    // timeout. A session default applies to every transaction the script opens.
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
    if (!allowWrite) await client.query("SET default_transaction_read_only = on");
    await client.query(allowWrite ? "BEGIN" : "BEGIN READ ONLY");
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
    // Destroy, never return to the pool: see "THE CONNECTION IS THROWAWAY" above.
    client.release(true);
  }
}
