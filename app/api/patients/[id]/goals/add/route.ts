// POST /api/patients/:id/goals/add {clinicId, activity, rating} — the PT adds a
// goal in the room ("you mentioned sleep — how is that, honestly?"). The rating
// is the PATIENT's, elicited by the PT, same as the in-room re-rate. Treatment-
// gated; lands on the patient's open episode with this clinic.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { parseNewGoal } from "@/lib/goals/model";
import { addGoalResponse } from "@/lib/review/goal-http";
import { addGoal } from "@/lib/review/goals";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { clinicId?: string; activity?: unknown; rating?: unknown }
    | null;
  if (!body?.clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, body.clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const goal = parseNewGoal(body);
  if (!goal) {
    return NextResponse.json(
      { error: "a goal needs a few words and a rating from 0 to 10" },
      { status: 400 },
    );
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

  return addGoalResponse(
    await addGoal(pool, {
      episodeId: episode.id,
      authorUserId: user.id,
      authorRole: "pt",
      activity: goal.activity,
      rating: goal.rating,
    }),
  );
}
