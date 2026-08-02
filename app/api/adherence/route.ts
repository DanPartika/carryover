// POST /api/adherence — log (or revise) MY OWN care for today. Two shapes:
//
//   {planItemId}  — a prescribed item. Ownership is proved through the plan.
//   {exerciseId}  — care I did on my own: iced because it felt tight, put the
//                   boots on, took an extra walk. Nothing prescribed it, so it
//                   never counts toward compliance — but the PT still sees it,
//                   and its pain score still joins the trend.
//
// Self-scoped either way: a patient can never log against someone else's plan.
// DELETE ?id= removes one of my own logs (mis-taps happen).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

type Body = {
  planItemId?: string;
  exerciseId?: string;
  completed?: boolean;
  setsDone?: number | null;
  repsDone?: number | null;
  durationDoneMins?: number | null;
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
  if (!body?.planItemId && !body?.exerciseId) {
    return NextResponse.json({ error: "planItemId or exerciseId required" }, { status: 400 });
  }

  // exercise_id is NOT NULL on every log, prescribed or not — resolve it from
  // the plan item so the two shapes store the same thing.
  let exerciseId: string;
  if (body.planItemId) {
    const {
      rows: [owned],
    } = await pool.query<{ exercise_id: string }>(
      `SELECT pi.exercise_id FROM plan_items pi
       JOIN plans p ON p.id = pi.plan_id
       JOIN episodes ep ON ep.id = p.episode_id
       WHERE pi.id = $1 AND ep.patient_user_id = $2`,
      [body.planItemId, user.id],
    );
    if (!owned) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    exerciseId = owned.exercise_id;
  } else {
    const {
      rows: [ex],
    } = await pool.query<{ id: string }>(
      "SELECT id FROM exercises WHERE id = $1 AND archived_at IS NULL",
      [body.exerciseId],
    );
    if (!ex) return NextResponse.json({ error: "unknown exercise" }, { status: 400 });
    exerciseId = ex.id;
  }

  const values = [
    body.planItemId ?? null,
    exerciseId,
    user.id,
    body.completed ?? true,
    clampOrNull(body.setsDone, 0, 20),
    clampOrNull(body.repsDone, 0, 100),
    clampOrNull(body.durationDoneMins, 0, 600),
    clampOrNull(body.pain, 0, 10),
    clampOrNull(body.effort, 1, 5),
    body.note?.trim().slice(0, 500) || null,
    body.flagForPt ?? false,
  ];

  const setClause = `completed = EXCLUDED.completed, sets_done = EXCLUDED.sets_done,
       reps_done = EXCLUDED.reps_done, duration_done_mins = EXCLUDED.duration_done_mins,
       pain = EXCLUDED.pain, effort = EXCLUDED.effort, note = EXCLUDED.note,
       flag_for_pt = EXCLUDED.flag_for_pt, updated_at = now()`;

  // Two partial unique indexes back these two conflict targets (migration
  // 0009): prescribed logs are unique per plan item per day, ad-hoc ones per
  // exercise per day. ON CONFLICT needs the matching index named explicitly —
  // it cannot infer a partial one from the column list alone.
  const conflict = body.planItemId
    ? "(plan_item_id, log_date) WHERE plan_item_id IS NOT NULL"
    : "(patient_user_id, exercise_id, log_date) WHERE plan_item_id IS NULL";

  const {
    rows: [log],
  } = await pool.query(
    `INSERT INTO adherence_logs
       (plan_item_id, exercise_id, patient_user_id, completed, sets_done, reps_done,
        duration_done_mins, pain, effort, note, flag_for_pt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ${conflict} DO UPDATE SET ${setClause}
     RETURNING id, log_date AS "logDate"`,
    values,
  );

  return NextResponse.json({ ok: true, log });
}

export async function DELETE(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { rowCount } = await pool.query(
    "DELETE FROM adherence_logs WHERE id = $1 AND patient_user_id = $2",
    [id, user.id],
  );
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
