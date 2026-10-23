// DELETE /api/me/goals/:goalId — the patient takes a goal THEY added off their
// list (a typo, a change of heart). Soft: the row stays, it just stops being a
// live goal. The intake's own goals and goals a PT added aren't theirs to
// remove here.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { retireGoalResponse, UUID_RE } from "@/lib/review/goal-http";
import { retireGoal } from "@/lib/review/goals";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ goalId: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { goalId } = await ctx.params;
  if (!UUID_RE.test(goalId)) return NextResponse.json({ error: "goal not found" }, { status: 404 });

  const {
    rows: [episode],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
     WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [user.id],
  );
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 404 });

  return retireGoalResponse(
    await retireGoal(pool, { episodeId: episode.id, goalId, userId: user.id, onlyOwn: true }),
  );
}
