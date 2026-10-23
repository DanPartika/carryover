// DELETE /api/patients/:id/goals/:goalId?clinicId= — the PT takes a goal that
// was added after the intake off the live list. Soft; the row stays. The
// intake's own activities are part of what was assessed and don't go.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { retireGoalResponse, UUID_RE } from "@/lib/review/goal-http";
import { retireGoal } from "@/lib/review/goals";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; goalId: string }> },
) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId, goalId } = await ctx.params;
  const clinicId = req.nextUrl.searchParams.get("clinicId");
  if (!clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!UUID_RE.test(goalId)) return NextResponse.json({ error: "goal not found" }, { status: 404 });

  const {
    rows: [episode],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, clinicId],
  );
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 404 });

  return retireGoalResponse(
    await retireGoal(pool, { episodeId: episode.id, goalId, userId: user.id, onlyOwn: false }),
  );
}
