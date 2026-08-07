// POST /api/patients/:id/goals — the PT records goal ratings elicited in the
// room ("how are the stairs today, honestly?"). Treatment-gated; same
// append-only goal_ratings rows the patient's self-rates land in, with the
// author telling the two apart.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { goalRows, parseRatings, recordRatings } from "@/lib/review/goals";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { clinicId?: string; ratings?: unknown }
    | null;
  if (!body?.clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, body.clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const {
    rows: [episode],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, body.clinicId],
  );
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 404 });

  const goals = await goalRows(pool, episode.id);
  if (!goals) {
    return NextResponse.json(
      { error: "no rated activities on the intake — add them there first" },
      { status: 409 },
    );
  }

  const ratings = parseRatings(body.ratings, goals);
  if (ratings.length === 0) {
    return NextResponse.json({ error: "nothing to record" }, { status: 400 });
  }

  await recordRatings(pool, episode.id, user.id, ratings);
  return NextResponse.json({ ok: true }, { status: 201 });
}
