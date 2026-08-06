// GET /api/patients/:id/sessions?clinicId=&days= — every home session the
// patient logged in the window, one row per exercise per day, with the
// prescription that was in force at the time beside what they actually did.
//
// The dashboard above this answers "how much" — 93%, 22 of 25. This answers
// "what happened": three sets or two, twelve minutes or six, what hurt, what
// they wrote, and the steps they were reading while they did it.
//
// The prescription comes from the log's OWN plan item, not the active plan.
// A patient who was on 3×10 in July and 3×15 now should read as having met
// the prescription in July — re-scoring old sessions against today's plan
// would invent a shortfall that never happened.

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_WINDOW_DAYS } from "@/lib/adherence/load";
import { windowStart } from "@/lib/adherence/stats";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const WINDOW_CHOICES = [7, 14, 28, 90];
// Generous for one patient's window (90 days of a 10-item daily plan is ~900),
// but a bound the payload can't grow past. Truncation is reported, never silent.
const MAX_ROWS = 600;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId } = await ctx.params;
  const clinicId = req.nextUrl.searchParams.get("clinicId");
  if (!clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const asked = Number(req.nextUrl.searchParams.get("days"));
  const days = WINDOW_CHOICES.includes(asked) ? asked : DEFAULT_WINDOW_DAYS;

  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");
  const from = windowStart(days, today);

  const { rows: sessions } = await pool.query(
    `SELECT al.id, al.log_date::text AS date, al.exercise_id AS "exerciseId",
            al.plan_item_id AS "planItemId", e.name,
            e.dosage_type AS "dosageType", e.kind,
            al.completed, al.sets_done AS "setsDone", al.reps_done AS "repsDone",
            al.duration_done_mins AS "durationDoneMins",
            al.pain, al.effort, al.note, al.flag_for_pt AS flagged,
            -- Not the same instant to the microsecond means the patient came
            -- back and changed it. Worth showing: a revised log is a second
            -- thought, and the PT is reading this to decide something.
            (al.updated_at <> al.created_at) AS edited,
            pi.sets, pi.reps, pi.hold_secs AS "holdSecs",
            pi.duration_mins AS "durationMins", pi.intensity,
            pi.frequency_per_week AS "frequencyPerWeek", pi.location
     FROM adherence_logs al
     JOIN exercises e ON e.id = al.exercise_id
     LEFT JOIN plan_items pi ON pi.id = al.plan_item_id
     WHERE al.patient_user_id = $1 AND al.log_date BETWEEN $2::date AND $3::date
     ORDER BY al.log_date DESC, e.name
     LIMIT ${MAX_ROWS + 1}`,
    [patientId, from, today],
  );

  const truncated = sessions.length > MAX_ROWS;
  const rows = truncated ? sessions.slice(0, MAX_ROWS) : sessions;

  // Instruction steps once per exercise rather than repeated on every session
  // — the same quad set across 25 days would otherwise ship its steps 25 times.
  const exerciseIds = [...new Set(rows.map((r) => r.exerciseId as string))];
  const { rows: exercises } = exerciseIds.length
    ? await pool.query(
        `SELECT id, name, instructions, (images ->> 0) AS image, difficulty,
                dosage_type AS "dosageType", kind
         FROM exercises WHERE id = ANY($1::uuid[])`,
        [exerciseIds],
      )
    : { rows: [] };

  return NextResponse.json({
    today,
    windowFrom: from,
    windowDays: days,
    truncated,
    sessions: rows,
    exercises,
  });
}
