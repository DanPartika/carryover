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
import { daysBetween, windowStart } from "@/lib/adherence/stats";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { APP_DAY, dayOf } from "@/lib/dates";
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
  let days = WINDOW_CHOICES.includes(asked) ? asked : DEFAULT_WINDOW_DAYS;

  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>(`SELECT ${APP_DAY}::text AS today`);
  let from = windowStart(days, today);
  let to = today;

  // The CURRENT episode's sessions start when it did: a patient who returns
  // after an earlier episode must not see last round's logs interleaved with
  // this round's prescriptions.
  const {
    rows: [current],
  } = await pool.query<{ openedOn: string }>(
    `SELECT ${dayOf("opened_at")}::text AS "openedOn" FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, clinicId],
  );
  if (current && current.openedOn > from) from = current.openedOn;

  // A past episode: the window is that episode's own days, opened to closed,
  // whatever "days" says. Logs are patient-scoped by date, so the episode's
  // span is what separates its sessions from the next round's. Pinned to this
  // patient AND clinic so an id from elsewhere finds nothing.
  const episodeId = req.nextUrl.searchParams.get("episodeId");
  if (episodeId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(episodeId)) {
      return NextResponse.json({ error: "bad episodeId" }, { status: 400 });
    }
    const {
      rows: [span],
    } = await pool.query<{ openedOn: string; closedOn: string | null }>(
      `SELECT ${dayOf("opened_at")}::text AS "openedOn",
              COALESCE(ended_on, ${dayOf("closed_at")})::text AS "closedOn"
       FROM episodes
       WHERE id = $3::uuid AND patient_user_id = $1 AND clinic_id = $2`,
      [patientId, clinicId, episodeId],
    );
    if (!span) return NextResponse.json({ error: "not found" }, { status: 404 });
    from = span.openedOn;
    to = span.closedOn ?? today;
    days = daysBetween(from, to) + 1;
  }

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
       -- Logs are patient-scoped, so a patient seen at two clinics has one pile.
       -- This clinic reads only exercises it may see: another clinic's private
       -- exercise names and instructions are not its business.
       AND (e.clinic_id IS NULL OR e.shared OR e.clinic_id = $4::uuid)
     ORDER BY al.log_date DESC, e.name
     LIMIT ${MAX_ROWS + 1}`,
    [patientId, from, to, clinicId],
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
