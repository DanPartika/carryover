// PATCH /api/visits/:id — set the wrap-up note and/or end the session.
// Ending is one-way: a closed visit is a record of something that happened,
// not a document to keep editing.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { visitForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

type Body = { note?: string | null; end?: boolean };

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const visit = await visitForActor(pool, id, user.id);
  if (!visit) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (visit.endedAt) return NextResponse.json({ error: "visit already ended" }, { status: 409 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const note = body?.note?.trim().slice(0, 1000) || null;

  const {
    rows: [updated],
  } = await pool.query(
    `UPDATE visits SET note = $2, ended_at = CASE WHEN $3 THEN now() ELSE ended_at END
     WHERE id = $1
     RETURNING id, started_at AS "startedAt", ended_at AS "endedAt", note`,
    [id, note, body?.end === true],
  );
  return NextResponse.json({ visit: updated });
}
