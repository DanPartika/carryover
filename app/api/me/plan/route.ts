// GET /api/me/plan — the signed-in PATIENT's own Today view data: active plan
// items (with exercise media/instructions), today's log per item, a 14-day
// streak strip, and the home-equipment inventory (owned + full catalog).
// Self-scoped by identity — no id in the URL, nothing to authorize against
// another patient.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { APP_DAY, dayOf } from "@/lib/dates";
import { getPool } from "@/lib/db/pool";
import { goalRows } from "@/lib/review/goals";

const STREAK_DAYS = 14;
/** Re-rate nudge cadence: roughly every two weeks is a check-in, more often
 *  is nagging. The card can always be used sooner by choice. */
const GOAL_PROMPT_DAYS = 14;

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

  let plan: { id: string; approvedAt: string; equipmentSuggestions: unknown } | null = null;
  let items: unknown[] = [];
  if (episode) {
    const {
      rows: [p],
    } = await pool.query<{
      id: string;
      approved_at: string;
      equipment_suggestions: unknown;
    }>(
      `SELECT id, approved_at, equipment_suggestions
       FROM plans WHERE episode_id = $1 AND status = 'active'`,
      [episode.id],
    );
    if (p) {
      // equipment_suggestions reached this side only because a PT approved
      // the plan carrying them (or pruned them first). ai_note NEVER ships
      // here — it's the PT-only channel.
      plan = {
        id: p.id,
        approvedAt: p.approved_at,
        equipmentSuggestions: p.equipment_suggestions ?? [],
      };
      // Today's log is matched by EXERCISE, not plan item: a check-in revision
      // mints new item rows, and the ✓ a patient earned this morning must not
      // vanish because their PT swapped something else this afternoon. The
      // lateral prefers the row already linked to this item, then the newest.
      const { rows } = await pool.query(
        `SELECT pi.id, pi.exercise_id AS "exerciseId", pi.sets, pi.reps,
                pi.hold_secs AS "holdSecs", pi.duration_mins AS "durationMins",
                pi.intensity, pi.frequency_per_week AS "frequencyPerWeek",
                pi.location, pi.rationale, pi.care_timing AS "careTiming",
                e.name, e.instructions, (e.images ->> 0) AS image, e.difficulty,
                e.dosage_type AS "dosageType", e.kind,
                al.id AS "logId", al.completed AS "logCompleted",
                al.sets_done AS "logSetsDone", al.reps_done AS "logRepsDone",
                al.duration_done_mins AS "logDurationDoneMins",
                al.pain AS "logPain", al.effort AS "logEffort", al.note AS "logNote",
                al.flag_for_pt AS "logFlagForPt"
         FROM plan_items pi
         JOIN exercises e ON e.id = pi.exercise_id
         LEFT JOIN LATERAL (
           SELECT a.id, a.completed, a.sets_done, a.reps_done, a.duration_done_mins,
                  a.pain, a.effort, a.note, a.flag_for_pt
           FROM adherence_logs a
           WHERE a.patient_user_id = $2 AND a.exercise_id = pi.exercise_id
             AND a.log_date = ${APP_DAY}
           ORDER BY (a.plan_item_id = pi.id) DESC NULLS LAST, a.created_at DESC
           LIMIT 1
         ) al ON true
         WHERE pi.plan_id = $1
         ORDER BY pi.sort, e.name`,
        [plan.id, user.id],
      );
      items = rows;
    }
  }

  // The hand this patient has already raised, if any — so the button reads
  // "your PT has been told" instead of inviting a second press.
  let checkin: unknown = null;
  if (episode) {
    const { rows } = await pool.query(
      `SELECT id, kind, note, ${dayOf("created_at")}::text AS "on"
       FROM checkin_requests WHERE episode_id = $1 AND resolved_at IS NULL`,
      [episode.id],
    );
    checkin = rows[0] ?? null;
  }

  // The intake's rated activities, and whether it's been long enough since
  // the last rating to nudge for a fresh one. The re-rate is what turns the
  // PT's next check-in into a real progress report — number beside number.
  let goals: { rows: unknown; promptDue: boolean } | null = null;
  if (episode) {
    const rows = await goalRows(pool, episode.id);
    if (rows) {
      const last = rows.reduce(
        (max, r) => ((r.currentOn ?? r.baselineOn) > max ? (r.currentOn ?? r.baselineOn) : max),
        rows[0].baselineOn,
      );
      const elapsed = Math.floor((Date.now() - Date.parse(last)) / 86_400_000);
      goals = { rows, promptDue: elapsed >= GOAL_PROMPT_DAYS };
    }
  }

  // The strip's days come from the same clinic-day clock the logs are stamped
  // with — building them from the server's own Date() put the whole strip a
  // day off for anyone logging after 8pm Eastern.
  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>(`SELECT ${APP_DAY}::text AS today`);
  const { rows: streakRows } = await pool.query<{ log_date: string }>(
    `SELECT DISTINCT log_date::text FROM adherence_logs
     WHERE patient_user_id = $1 AND completed AND log_date > ${APP_DAY} - $2::int
     ORDER BY log_date`,
    [user.id, STREAK_DAYS],
  );
  const loggedDates = new Set(streakRows.map((r) => r.log_date));
  const streak = Array.from({ length: STREAK_DAYS }, (_, i) => {
    const iso = new Date(Date.parse(today) - (STREAK_DAYS - 1 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { date: iso, completed: loggedDates.has(iso) };
  });

  // Care the patient did on their own initiative — no plan item behind it, so
  // it never touches the compliance percentage, but the PT still sees it.
  const { rows: adhocToday } = await pool.query(
    `SELECT al.id, al.exercise_id AS "exerciseId", e.name,
            e.dosage_type AS "dosageType",
            al.sets_done AS "setsDone", al.reps_done AS "repsDone",
            al.duration_done_mins AS "durationDoneMins", al.pain, al.note
     FROM adherence_logs al JOIN exercises e ON e.id = al.exercise_id
     WHERE al.patient_user_id = $1 AND al.plan_item_id IS NULL
       AND al.log_date = ${APP_DAY}
     ORDER BY al.created_at`,
    [user.id],
  );

  // The quick half of the "log something else" picker: care the patient
  // reaches for unprompted (ice, boots, heat) stays one tap in a dropdown.
  // Exercises nobody prescribed — "I also did squats" — go through the
  // library search beside it instead of bloating this list.
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
    goals,
    streak,
    adhocToday,
    careOptions,
    equipment: equipment.map((e) => ({ ...e, owned: ownedIds.has(e.id) })),
  });
}
