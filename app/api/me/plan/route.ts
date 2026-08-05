// GET /api/me/plan — the signed-in PATIENT's own Today view data: active plan
// items (with exercise media/instructions), today's log per item, a 14-day
// streak strip, and the home-equipment inventory (owned + full catalog).
// Self-scoped by identity — no id in the URL, nothing to authorize against
// another patient.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const STREAK_DAYS = 14;

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const {
    rows: [episode],
  } = await pool.query<{ id: string; condition: string }>(
    `SELECT id, condition FROM episodes
     WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [user.id],
  );

  let plan: { id: string; approvedAt: string } | null = null;
  let items: unknown[] = [];
  if (episode) {
    const {
      rows: [p],
    } = await pool.query<{ id: string; approved_at: string }>(
      `SELECT id, approved_at FROM plans WHERE episode_id = $1 AND status = 'active'`,
      [episode.id],
    );
    if (p) {
      plan = { id: p.id, approvedAt: p.approved_at };
      const { rows } = await pool.query(
        `SELECT pi.id, pi.exercise_id AS "exerciseId", pi.sets, pi.reps,
                pi.hold_secs AS "holdSecs", pi.duration_mins AS "durationMins",
                pi.intensity, pi.frequency_per_week AS "frequencyPerWeek",
                pi.location, pi.rationale,
                e.name, e.instructions, (e.images ->> 0) AS image, e.difficulty,
                e.dosage_type AS "dosageType", e.kind,
                al.id AS "logId", al.completed AS "logCompleted",
                al.sets_done AS "logSetsDone", al.reps_done AS "logRepsDone",
                al.duration_done_mins AS "logDurationDoneMins",
                al.pain AS "logPain", al.effort AS "logEffort", al.note AS "logNote",
                al.flag_for_pt AS "logFlagForPt"
         FROM plan_items pi
         JOIN exercises e ON e.id = pi.exercise_id
         LEFT JOIN adherence_logs al
           ON al.plan_item_id = pi.id AND al.log_date = CURRENT_DATE
         WHERE pi.plan_id = $1
         ORDER BY pi.sort, e.name`,
        [plan.id],
      );
      items = rows;
    }
  }

  // The hand this patient has already raised, if any — so the button reads
  // "your PT has been told" instead of inviting a second press.
  let checkin: unknown = null;
  if (episode) {
    const { rows } = await pool.query(
      `SELECT id, kind, note, created_at::date::text AS "on"
       FROM checkin_requests WHERE episode_id = $1 AND resolved_at IS NULL`,
      [episode.id],
    );
    checkin = rows[0] ?? null;
  }

  const { rows: streakRows } = await pool.query<{ log_date: string }>(
    `SELECT DISTINCT log_date::text FROM adherence_logs
     WHERE patient_user_id = $1 AND completed AND log_date > CURRENT_DATE - $2::int
     ORDER BY log_date`,
    [user.id, STREAK_DAYS],
  );
  const loggedDates = new Set(streakRows.map((r) => r.log_date));
  const streak = Array.from({ length: STREAK_DAYS }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (STREAK_DAYS - 1 - i));
    const iso = d.toISOString().slice(0, 10);
    return { date: iso, completed: loggedDates.has(iso) };
  });

  // Care the patient did on their own initiative — no plan item behind it, so
  // it never touches the compliance percentage, but the PT still sees it.
  const { rows: adhocToday } = await pool.query(
    `SELECT al.id, al.exercise_id AS "exerciseId", e.name,
            al.duration_done_mins AS "durationDoneMins", al.pain, al.note
     FROM adherence_logs al JOIN exercises e ON e.id = al.exercise_id
     WHERE al.patient_user_id = $1 AND al.plan_item_id IS NULL
       AND al.log_date = CURRENT_DATE
     ORDER BY al.created_at`,
    [user.id],
  );

  // The "log something else" picker. Modalities only: this is for care the
  // patient reaches for unprompted (ice, boots, heat), not for browsing 887
  // exercises on a phone.
  const { rows: careOptions } = await pool.query(
    `SELECT id, name FROM exercises
     WHERE kind = 'modality' AND archived_at IS NULL AND clinic_id IS NULL
     ORDER BY name`,
  );

  const { rows: equipment } = await pool.query(
    "SELECT id, slug, name, kind FROM equipment_catalog ORDER BY kind, name",
  );
  const { rows: owned } = await pool.query<{ equipment_id: string }>(
    "SELECT equipment_id FROM patient_equipment WHERE user_id = $1",
    [user.id],
  );
  const ownedIds = new Set(owned.map((r) => r.equipment_id));

  return NextResponse.json({
    episode: episode ?? null,
    plan,
    items,
    checkin,
    streak,
    adhocToday,
    careOptions,
    equipment: equipment.map((e) => ({ ...e, owned: ownedIds.has(e.id) })),
  });
}
