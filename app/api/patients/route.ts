// GET /api/patients — the signed-in PT's assigned patients (clinic admins see
// every patient in their clinics), with episode/plan status for the list view.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { APP_DAY, dayOf } from "@/lib/dates";
import { getPool } from "@/lib/db/pool";
import { reviewSignals } from "@/lib/review/signals";

type Row = { episodeId: string | null; reviewDue?: boolean; reviewLine?: string };

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows } = await pool.query(
    `WITH reachable AS (
       SELECT a.clinic_id, a.patient_user_id
       FROM pt_patients a
       WHERE a.pt_user_id = $1 AND a.active
       UNION
       SELECT m2.clinic_id, m2.user_id AS patient_user_id
       FROM clinic_members me
       JOIN clinic_members m2
         ON m2.clinic_id = me.clinic_id AND m2.role = 'patient' AND m2.active
       WHERE me.user_id = $1 AND me.role = 'admin' AND me.active
     )
     SELECT DISTINCT u.id, u.display_name, u.email, r.clinic_id AS "clinicId",
            c.name AS "clinicName",
            ep.id AS "episodeId", ep.condition,
            (SELECT p.status FROM plans p
             WHERE p.episode_id = ep.id AND p.status IN ('draft','active')
             ORDER BY p.status = 'active' DESC, p.created_at DESC LIMIT 1) AS "planStatus",
            -- Between-visit triage (PRD build step 5): who raised a hand, and
            -- who has gone quiet. Flags age out after two weeks, which is also
            -- the app's only "resolve" — there is no acknowledge action yet.
            -- Patient-scoped within the OPEN EPISODE, not active-plan-scoped: a
            -- flag raised Tuesday must not vanish because the plan was revised
            -- Wednesday, and "quiet for N days" is about the person logging, not
            -- about which revision they logged under. But bounded by the episode
            -- itself: a patient back after two years would otherwise read "quiet
            -- 600d" on the day their new plan was approved, and a patient whose
            -- episode just closed would keep a flag chip for two weeks.
            (SELECT count(*)::int FROM adherence_logs al
             WHERE ep.id IS NOT NULL AND al.patient_user_id = u.id
               AND al.flag_for_pt AND al.log_date > ${APP_DAY} - 14
               AND al.log_date >= ${dayOf("ep.opened_at")}) AS "flagCount",
            (SELECT max(al.log_date)::text FROM adherence_logs al
             WHERE ep.id IS NOT NULL AND al.patient_user_id = u.id AND al.completed
               AND al.log_date >= ${dayOf("ep.opened_at")}) AS "lastLoggedOn",
            -- A patient whose only episodes are closed is not "needs intake":
            -- the list says so, with the date, and links straight to the history.
            (SELECT count(*)::int FROM episodes ce
             WHERE ce.patient_user_id = u.id AND ce.clinic_id = r.clinic_id
               AND ce.closed_at IS NOT NULL) AS "closedEpisodes",
            (SELECT max(COALESCE(ce.ended_on, ${dayOf("ce.closed_at")}))::text FROM episodes ce
             WHERE ce.patient_user_id = u.id AND ce.clinic_id = r.clinic_id
               AND ce.closed_at IS NOT NULL) AS "lastClosedOn"
     FROM reachable r
     JOIN users u ON u.id = r.patient_user_id
     JOIN clinics c ON c.id = r.clinic_id
     LEFT JOIN episodes ep
       ON ep.patient_user_id = u.id AND ep.clinic_id = r.clinic_id AND ep.closed_at IS NULL
     ORDER BY u.display_name NULLS LAST, u.email`,
    [user.id],
  );

  // The list's "quiet for N days" is measured against the database's today,
  // the same clock adherence_logs.log_date is written with.
  const {
    rows: [{ today }],
  } = await pool.query<{ today: string }>(`SELECT ${APP_DAY}::text AS today`);

  // Check-in signals for every reachable patient at once. Batched rather than
  // looped: the chip has to mean the same thing here as it does on the patient
  // page, so it has to be the same computation, and running the per-episode
  // loader once per row would be dozens of round trips to paint a list.
  const episodeIds = (rows as Row[]).map((r) => r.episodeId).filter((id): id is string => !!id);
  const signals = await reviewSignals(pool, episodeIds);
  for (const row of rows as Row[]) {
    const s = row.episodeId ? signals.get(row.episodeId) : undefined;
    row.reviewDue = s?.due ?? false;
    row.reviewLine = s?.request ? "asked for a check-in" : (s?.line ?? "");
  }

  return NextResponse.json({ patients: rows, today });
}
