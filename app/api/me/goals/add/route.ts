// POST /api/me/goals/add {activity, rating} — the patient names a goal of their
// own mid-episode ("I'd like to sleep through the night"). Self-scoped: it
// lands on the caller's open episode, with their own 0-10 rating as its
// baseline. The PT sees it on the goals panel, marked as added by the patient.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { parseNewGoal } from "@/lib/goals/model";
import { addGoalResponse } from "@/lib/review/goal-http";
import { addGoal } from "@/lib/review/goals";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const goal = parseNewGoal(await req.json().catch(() => null));
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
     WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [user.id],
  );
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 404 });

  return addGoalResponse(
    await addGoal(pool, {
      episodeId: episode.id,
      authorUserId: user.id,
      authorRole: "patient",
      activity: goal.activity,
      rating: goal.rating,
    }),
  );
}
