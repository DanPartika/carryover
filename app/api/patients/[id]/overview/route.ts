// GET /api/patients/:id/overview?clinicId= — everything the PT's patient page
// needs: identity, home-equipment inventory, open episode, latest intake,
// plans with items, and the check-in signal. Treatment-relationship gated.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { INTAKE_SELECT_COLS } from "@/lib/intake/fields";
import { progressionCandidates } from "@/lib/review/progressions";
import { reviewSignals } from "@/lib/review/signals";

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

  const {
    rows: [patient],
  } = await pool.query(
    `SELECT id, display_name AS "displayName", email, birth_year AS "birthYear"
     FROM users WHERE id = $1`,
    [patientId],
  );
  if (!patient) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { rows: equipment } = await pool.query(
    `SELECT ec.name FROM patient_equipment pe
     JOIN equipment_catalog ec ON ec.id = pe.equipment_id
     WHERE pe.user_id = $1 ORDER BY ec.name`,
    [patientId],
  );

  const {
    rows: [episode],
  } = await pool.query(
    `SELECT id, condition, opened_at AS "openedAt" FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, clinicId],
  );

  let latestIntake = null;
  let plans: unknown[] = [];
  let review: unknown = null;
  if (episode) {
    // The whole record, plus whether the patient wrote it: a pre-visit
    // self-intake renders with a "review me" banner on the PT side.
    const { rows: intakes } = await pool.query(
      `SELECT ${INTAKE_SELECT_COLS},
              (i.author_user_id = $2) AS "patientSubmitted"
       FROM intakes i WHERE i.episode_id = $1 ORDER BY i.created_at DESC LIMIT 1`,
      [episode.id, patientId],
    );
    latestIntake = intakes[0] ?? null;

    const { rows: planRows } = await pool.query(
      `SELECT p.id, p.status, p.source, p.model, p.created_at AS "createdAt",
              p.approved_at AS "approvedAt",
              p.equipment_suggestions AS "equipmentSuggestions", p.ai_note AS "aiNote"
       FROM plans p WHERE p.episode_id = $1 AND p.status IN ('draft', 'active')
       ORDER BY p.status = 'active' DESC, p.created_at DESC`,
      [episode.id],
    );
    const { rows: itemRows } = await pool.query(
      `SELECT pi.id, pi.plan_id AS "planId", pi.exercise_id AS "exerciseId",
              e.name, (e.images ->> 0) AS image, e.difficulty,
              e.dosage_type AS "dosageType", e.kind,
              pi.sets, pi.reps, pi.hold_secs AS "holdSecs",
              pi.duration_mins AS "durationMins", pi.intensity,
              pi.frequency_per_week AS "frequencyPerWeek", pi.location,
              pi.rationale, pi.care_timing AS "careTiming", pi.sort
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
       WHERE pi.plan_id = ANY($1::uuid[]) ORDER BY pi.sort, e.name`,
      [planRows.map((p) => p.id)],
    );
    plans = planRows.map((p) => ({
      ...p,
      items: itemRows.filter((i) => i.planId === p.id),
    }));

    // The check-in signal, plus the charted steps off every item in the active
    // plan. Both travel with the page's one load: a PT deciding whether to
    // progress someone shouldn't watch two spinners resolve in sequence.
    const signal = (await reviewSignals(pool, [episode.id])).get(episode.id) ?? null;
    const activePlan = planRows.find((p) => p.status === "active");
    const progressions = activePlan
      ? await progressionCandidates(pool, activePlan.id, patientId, clinicId)
      : [];
    review = signal ? { ...signal, progressions } : null;
  }

  return NextResponse.json({
    patient,
    equipment: equipment.map((e) => e.name),
    episode: episode ?? null,
    latestIntake,
    plans,
    review,
  });
}
