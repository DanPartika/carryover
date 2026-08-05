// The charted next (or previous) step for each item in a plan.
//
// exercise_progressions has held 8 seeded edges since build step 1 and nothing
// has ever read them. This is what they were for: a PT looking at an active
// plan should be one tap from "quad set → straight-leg raise" without drafting
// anything, re-running an intake, or typing a search.
//
// Both directions are offered. A check-in that can only make a plan harder has
// a verdict baked into it, and the same chain read backwards is exactly the
// right move for a patient whose pain is climbing.

import type { Pool } from "pg";
import { HOUSEHOLD_SLUGS } from "@/lib/ai/plan";
import type { DosageType } from "@/lib/dosage";

export type ProgressionCandidate = {
  planItemId: string;
  fromExerciseId: string;
  fromName: string;
  toExerciseId: string;
  toName: string;
  direction: "up" | "down";
  /** The clinic's own note on the edge. Only ever set for "up" — the note was
   *  written to describe moving forward ("Progress when the two-leg bridge is
   *  easy"), and showing it beside an ease-off button would be nonsense. */
  note: string | null;
  dosageType: DosageType;
  difficulty: number | null;
  homeEligible: boolean;
};

export async function progressionCandidates(
  pool: Pool,
  planId: string,
  patientUserId: string,
  clinicId: string,
): Promise<ProgressionCandidate[]> {
  const { rows } = await pool.query<ProgressionCandidate>(
    `WITH edges AS (
       SELECT from_exercise_id AS anchor, to_exercise_id AS target, note, 'up' AS direction
       FROM exercise_progressions
       UNION ALL
       SELECT to_exercise_id AS anchor, from_exercise_id AS target, NULL, 'down'
       FROM exercise_progressions
     )
     SELECT pi.id AS "planItemId",
            pi.exercise_id AS "fromExerciseId", fe.name AS "fromName",
            te.id AS "toExerciseId", te.name AS "toName",
            ed.direction, ed.note,
            te.dosage_type AS "dosageType", te.difficulty,
            (count(ec.id) = 0 OR bool_or(
              ec.slug = ANY($4) OR pe.equipment_id IS NOT NULL
            )) AS "homeEligible"
     FROM plan_items pi
     JOIN exercises fe ON fe.id = pi.exercise_id
     JOIN edges ed ON ed.anchor = pi.exercise_id
     JOIN exercises te ON te.id = ed.target AND te.archived_at IS NULL
     LEFT JOIN exercise_equipment ee ON ee.exercise_id = te.id
     LEFT JOIN equipment_catalog ec ON ec.id = ee.equipment_id
     LEFT JOIN patient_equipment pe ON pe.equipment_id = ec.id AND pe.user_id = $2
     WHERE pi.plan_id = $1
       -- A clinic's private exercise stays private even when it sits on an
       -- edge someone else's exercise points at.
       AND (te.clinic_id IS NULL OR te.shared OR te.clinic_id = $3)
       -- Nothing already in the plan: swapping in a duplicate isn't a step.
       AND NOT EXISTS (
         SELECT 1 FROM plan_items x WHERE x.plan_id = pi.plan_id AND x.exercise_id = te.id
       )
     GROUP BY pi.id, pi.exercise_id, fe.name, te.id, te.name, ed.direction, ed.note,
              te.dosage_type, te.difficulty
     ORDER BY fe.name, ed.direction DESC, te.name`,
    [planId, patientUserId, clinicId, HOUSEHOLD_SLUGS],
  );
  return rows;
}

/** Verify an edge the client asked to walk actually exists, in either
 *  direction, and resolve what it lands on. Never trust the pair from the
 *  request body: a caller could otherwise name any exercise in the library as
 *  the "successor" of a plan item and skip the chain entirely. */
export async function resolveEdge(
  pool: Pool,
  planItemId: string,
  toExerciseId: string,
  planId: string,
  patientUserId: string,
  clinicId: string,
): Promise<ProgressionCandidate | null> {
  const all = await progressionCandidates(pool, planId, patientUserId, clinicId);
  return (
    all.find((c) => c.planItemId === planItemId && c.toExerciseId === toExerciseId) ?? null
  );
}
