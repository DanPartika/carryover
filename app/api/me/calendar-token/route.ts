// Calendar-feed capability lifecycle (bearer-only): POST mints/regenerates the
// secret (regeneration REVOKES the previous URL), GET reads it, DELETE turns
// the feed off. The feed itself is served by /api/calendar/[token].

import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await pool.query<{ calendar_token: string | null }>(
    "SELECT calendar_token FROM users WHERE id = $1",
    [user.id],
  );
  return NextResponse.json({ token: rows[0]?.calendar_token ?? null });
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = randomBytes(24).toString("hex"); // 48 hex chars
  await pool.query("UPDATE users SET calendar_token = $2 WHERE id = $1", [user.id, token]);
  return NextResponse.json({ token });
}

export async function DELETE(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await pool.query("UPDATE users SET calendar_token = NULL WHERE id = $1", [user.id]);
  return new NextResponse(null, { status: 204 });
}
