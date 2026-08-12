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
import { APP_DAY } from "@/lib/dates";
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
    // Same visibility rule as the library browse — without it, this endpoint
    // is an existence oracle for other clinics' private exercises (and their
    // names would render right back in this patient's own log list).
    const {
      rows: [ex],
    } = await pool.query<{ id: string }>(
      `SELECT e.id FROM exercises e
       WHERE e.id = $1 AND e.archived_at IS NULL
         AND (e.clinic_id IS NULL OR e.shared OR e.clinic_id IN
              (SELECT clinic_id FROM clinic_members WHERE user_id = $2 AND active))`,
      [body.exerciseId, user.id],
    );
    if (!ex) return NextResponse.json({ error: "unknown exercise" }, { status: 400 });
    exerciseId = ex.id;
  }

  // Canonicalize to the ACTIVE plan's item for this exercise, whichever
  // button the log came through. A stale tab posting a retired revision's
  // item id must not re-point today's row backward, and an ad-hoc log of a
  // prescribed exercise IS that session done — it should light the ✓ and
  // count, not sit beside the prescription as a stranger.
  const {
    rows: [activeItem],
  } = await pool.query<{ id: string }>(
    `SELECT pi.id FROM plan_items pi
     JOIN plans p ON p.id = pi.plan_id AND p.status = 'active'
     JOIN episodes ep ON ep.id = p.episode_id
     WHERE ep.patient_user_id = $1 AND pi.exercise_id = $2
     ORDER BY pi.sort LIMIT 1`,
    [user.id, exerciseId],
  );
  const effectiveItemId = activeItem?.id ?? null;

  const fields = [
    body.completed ?? true,
    clampOrNull(body.setsDone, 0, 20),
    clampOrNull(body.repsDone, 0, 100),
    clampOrNull(body.durationDoneMins, 0, 600),
    clampOrNull(body.pain, 0, 10),
    clampOrNull(body.effort, 1, 5),
    body.note?.trim().slice(0, 500) || null,
    body.flagForPt ?? false,
  ];

  // One row per exercise per day, whichever button it came through. Today's
  // row is found by EXERCISE: plan revisions mint new item rows, and a log
  // saved this morning must stay this evening's row — re-pointed to the
  // current item — not a stranded duplicate. Preferring the row that already
  // holds the effective item id means the UPDATE can never collide with the
  // (plan_item_id, log_date) unique index: only one row can hold it.
  const {
    rows: [existing],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM adherence_logs
     WHERE patient_user_id = $1 AND exercise_id = $2 AND log_date = ${APP_DAY}
     ORDER BY (plan_item_id IS NOT DISTINCT FROM $3::uuid) DESC,
              (plan_item_id IS NOT NULL) DESC, created_at DESC
     LIMIT 1`,
    [user.id, exerciseId, effectiveItemId],
  );

  let log: { id: string; logDate: string };
  if (existing) {
    const {
      rows: [updated],
    } = await pool.query<{ id: string; logDate: string }>(
      `UPDATE adherence_logs
       SET completed = $2, sets_done = $3, reps_done = $4, duration_done_mins = $5,
           pain = $6, effort = $7, note = $8, flag_for_pt = $9,
           plan_item_id = COALESCE($10, plan_item_id), updated_at = now()
       WHERE id = $1
       RETURNING id, log_date AS "logDate"`,
      [existing.id, ...fields, effectiveItemId],
    );
    log = updated;
  } else {
    // The partial unique indexes (migration 0009) still stand as the race
    // backstop: prescribed rows unique per plan item per day, ad-hoc per
    // exercise per day.
    const conflict = effectiveItemId
      ? "(plan_item_id, log_date) WHERE plan_item_id IS NOT NULL"
      : "(patient_user_id, exercise_id, log_date) WHERE plan_item_id IS NULL";
    const {
      rows: [inserted],
    } = await pool.query<{ id: string; logDate: string }>(
      `INSERT INTO adherence_logs
         (plan_item_id, exercise_id, patient_user_id, completed, sets_done, reps_done,
          duration_done_mins, pain, effort, note, flag_for_pt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT ${conflict} DO UPDATE SET
         completed = EXCLUDED.completed, sets_done = EXCLUDED.sets_done,
         reps_done = EXCLUDED.reps_done, duration_done_mins = EXCLUDED.duration_done_mins,
         pain = EXCLUDED.pain, effort = EXCLUDED.effort, note = EXCLUDED.note,
         flag_for_pt = EXCLUDED.flag_for_pt, updated_at = now()
       RETURNING id, log_date AS "logDate"`,
      [effectiveItemId, exerciseId, user.id, ...fields],
    );
    log = inserted;
  }

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
