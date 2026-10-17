// Reading closed episodes back — for the PT (everything), and for the patient
// (an allowlisted subset).
//
// The patient shape is built by picking fields, never by deleting them from the
// PT shape: a field added to the PT's view later must stay invisible to the
// patient until someone decides otherwise. What the patient never gets:
// adherence percent / expected sessions (a score is a verdict to someone reading
// their own record), pain (the slider's default makes it unreliable — see
// lib/ai/closing.ts), flag counts, the check-in count, the "watch for" line
// (it exists to steer the PT's next draft), the intake (it carries the PT's
// restrictions and red-flag screen), notes, and anything from plans.ai_note.

import type { Pool } from "pg";
import { dayOf } from "@/lib/dates";
import { INTAKE_SELECT_COLS, type IntakeRecord } from "@/lib/intake/fields";
import {
  planSnapshots,
  REOPEN_WINDOW_HOURS,
  type ClosingContext,
  type PlanSnapshot,
} from "./closing";
import { patientPlan, patientStats, type PatientPastEpisode } from "./shape";

export type PastEpisode = {
  id: string;
  clinicId: string;
  condition: string;
  openedOn: string;
  /** The day care ended — which may be earlier than the day it was closed. */
  endedOn: string;
  /** The clinic day the PT pressed Close (care may have ended earlier). */
  closedOn: string;
  closedAt: string;
  /** Closed within REOPEN_WINDOW_HOURS (whether or not it can still be undone). */
  recent: boolean;
  closedByName: string | null;
  aiAssisted: boolean;
  summary: string;
  watchFor: string | null;
  context: ClosingContext | null;
  startPlan: PlanSnapshot | null;
  finalPlan: PlanSnapshot | null;
  /** The intake as it stood at the end of the episode. PT view only. */
  intake: (IntakeRecord & { patientSubmitted: boolean }) | null;
  /** Set only on the newest closed episode, while nothing newer is open and
   *  the window hasn't passed: when a mis-tap can still be undone until. */
  reopenableUntil: string | null;
};

type EpisodeRow = Omit<PastEpisode, "startPlan" | "finalPlan" | "intake">;

/** Closed episodes for one patient, newest first. `clinicId` scopes a PT's
 *  view to their own clinic; null (the patient's own view) spans all of them. */
export async function loadPastEpisodes(
  pool: Pool,
  patientUserId: string,
  clinicId: string | null,
  opts: { withIntake: boolean },
): Promise<PastEpisode[]> {
  const { rows } = await pool.query<EpisodeRow>(
    `SELECT e.id, e.clinic_id AS "clinicId", e.condition,
            ${dayOf("e.opened_at")}::text AS "openedOn",
            COALESCE(e.ended_on, ${dayOf("e.closed_at")})::text AS "endedOn",
            ${dayOf("e.closed_at")}::text AS "closedOn",
            e.closed_at::text AS "closedAt",
            (e.closed_at > now() - interval '${REOPEN_WINDOW_HOURS} hours') AS recent,
            u.display_name AS "closedByName",
            e.closing_ai_assisted AS "aiAssisted",
            e.closing_summary AS summary,
            e.closing_watch_for AS "watchFor",
            e.closing_context AS context,
            CASE
              WHEN e.closed_at > now() - interval '${REOPEN_WINDOW_HOURS} hours'
               AND e.id = (SELECT e2.id FROM episodes e2
                            WHERE e2.patient_user_id = e.patient_user_id
                              AND e2.clinic_id = e.clinic_id AND e2.closed_at IS NOT NULL
                            ORDER BY e2.closed_at DESC LIMIT 1)
               AND NOT EXISTS (SELECT 1 FROM episodes o
                                WHERE o.patient_user_id = e.patient_user_id
                                  AND o.clinic_id = e.clinic_id AND o.closed_at IS NULL)
              THEN (e.closed_at + interval '${REOPEN_WINDOW_HOURS} hours')::text
            END AS "reopenableUntil"
     FROM episodes e
     LEFT JOIN users u ON u.id = e.closed_by
     WHERE e.patient_user_id = $1 AND e.closed_at IS NOT NULL
       AND ($2::uuid IS NULL OR e.clinic_id = $2::uuid)
     ORDER BY e.closed_at DESC`,
    [patientUserId, clinicId],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [firstPlans, lastPlans] = await Promise.all([
    planSnapshots(pool, ids, "first"),
    planSnapshots(pool, ids, "last"),
  ]);

  const intakes = new Map<string, PastEpisode["intake"]>();
  if (opts.withIntake) {
    const { rows: intakeRows } = await pool.query<
      IntakeRecord & { episodeId: string; patientSubmitted: boolean }
    >(
      `SELECT DISTINCT ON (i.episode_id) i.episode_id AS "episodeId", ${INTAKE_SELECT_COLS},
              (i.author_user_id = $2) AS "patientSubmitted"
       FROM intakes i
       WHERE i.episode_id = ANY($1::uuid[])
       ORDER BY i.episode_id, i.created_at DESC`,
      [ids, patientUserId],
    );
    for (const r of intakeRows) intakes.set(r.episodeId, r);
  }

  return rows.map((r) => ({
    ...r,
    startPlan: firstPlans.get(r.id) ?? null,
    finalPlan: lastPlans.get(r.id) ?? null,
    intake: intakes.get(r.id) ?? null,
  }));
}

export function forPatient(
  e: PastEpisode,
  messages: PatientPastEpisode["messages"] = [],
): PatientPastEpisode {
  return {
    id: e.id,
    condition: e.condition,
    openedOn: e.openedOn,
    endedOn: e.endedOn,
    closedByName: e.closedByName,
    recent: e.recent,
    summary: e.summary,
    stats: e.context ? patientStats(e.context) : null,
    finalPlan: e.finalPlan ? patientPlan(e.finalPlan) : null,
    messages,
  };
}
