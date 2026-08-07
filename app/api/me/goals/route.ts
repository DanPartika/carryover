// POST /api/me/goals — the patient re-rates their own intake goals ("stairs,
// 0-10 today?"). Self-scoped; the row lands append-only in goal_ratings and
// the next check-in's progress report reads it beside the intake baseline.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { goalRows, parseRatings, recordRatings } from "@/lib/review/goals";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const {
    rows: [episode],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
     WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [user.id],
  );
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 404 });

  const goals = await goalRows(pool, episode.id);
  if (!goals) {
    return NextResponse.json({ error: "no goals on file to rate" }, { status: 409 });
  }

  const body = (await req.json().catch(() => null)) as { ratings?: unknown } | null;
  const ratings = parseRatings(body?.ratings, goals);
  if (ratings.length === 0) {
    return NextResponse.json({ error: "nothing to record" }, { status: 400 });
  }

  await recordRatings(pool, episode.id, user.id, ratings);
  return NextResponse.json({ ok: true }, { status: 201 });
}
