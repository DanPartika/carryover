// POST /api/adherence — log (or revise) MY OWN completion of one plan item
// for today. Self-scoped: the plan item must belong to a plan whose episode's
// patient is the caller — a patient can never log against someone else's plan.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

type Body = {
  planItemId?: string;
  completed?: boolean;
  setsDone?: number | null;
  repsDone?: number | null;
  pain?: number | null;
  effort?: number | null;
  note?: string;
  flagForPt?: boolean;
};

function clampOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.planItemId) {
    return NextResponse.json({ error: "planItemId required" }, { status: 400 });
  }

  const { rows: owns } = await pool.query(
    `SELECT 1 FROM plan_items pi
     JOIN plans p ON p.id = pi.plan_id
     JOIN episodes ep ON ep.id = p.episode_id
     WHERE pi.id = $1 AND ep.patient_user_id = $2`,
    [body.planItemId, user.id],
  );
  if (owns.length === 0) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const {
    rows: [log],
  } = await pool.query(
    `INSERT INTO adherence_logs
       (plan_item_id, patient_user_id, completed, sets_done, reps_done, pain, effort, note, flag_for_pt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (plan_item_id, log_date) DO UPDATE SET
       completed = EXCLUDED.completed, sets_done = EXCLUDED.sets_done,
       reps_done = EXCLUDED.reps_done, pain = EXCLUDED.pain, effort = EXCLUDED.effort,
       note = EXCLUDED.note, flag_for_pt = EXCLUDED.flag_for_pt, updated_at = now()
     RETURNING id, log_date AS "logDate"`,
    [
      body.planItemId,
      user.id,
      body.completed ?? true,
      clampOrNull(body.setsDone, 0, 20),
      clampOrNull(body.repsDone, 0, 100),
      clampOrNull(body.pain, 0, 10),
      clampOrNull(body.effort, 1, 5),
      body.note?.trim().slice(0, 500) || null,
      body.flagForPt ?? false,
    ],
  );

  return NextResponse.json({ ok: true, log });
}
