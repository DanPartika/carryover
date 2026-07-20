// GET /api/patients/:id/overview?clinicId= — everything the PT's patient page
// needs: identity, home-equipment inventory, open episode, latest intake, and
// plans with items. Treatment-relationship gated.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

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
    `SELECT id, display_name AS "displayName", email FROM users WHERE id = $1`,
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
  if (episode) {
    const { rows: intakes } = await pool.query(
      `SELECT id, condition, body_regions AS "bodyRegions", onset_date::text AS "onsetDate",
              pain_now AS "painNow", pain_worst AS "painWorst", goals, restrictions,
              narrative, created_at AS "createdAt"
       FROM intakes WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [episode.id],
    );
    latestIntake = intakes[0] ?? null;

    const { rows: planRows } = await pool.query(
      `SELECT p.id, p.status, p.source, p.model, p.created_at AS "createdAt",
              p.approved_at AS "approvedAt"
       FROM plans p WHERE p.episode_id = $1 AND p.status IN ('draft', 'active')
       ORDER BY p.status = 'active' DESC, p.created_at DESC`,
      [episode.id],
    );
    const { rows: itemRows } = await pool.query(
      `SELECT pi.id, pi.plan_id AS "planId", pi.exercise_id AS "exerciseId",
              e.name, (e.images ->> 0) AS image, e.difficulty,
              pi.sets, pi.reps, pi.hold_secs AS "holdSecs",
              pi.frequency_per_week AS "frequencyPerWeek", pi.location,
              pi.rationale, pi.sort
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
       WHERE pi.plan_id = ANY($1::uuid[]) ORDER BY pi.sort, e.name`,
      [planRows.map((p) => p.id)],
    );
    plans = planRows.map((p) => ({
      ...p,
      items: itemRows.filter((i) => i.planId === p.id),
    }));
  }

  return NextResponse.json({
    patient,
    equipment: equipment.map((e) => e.name),
    episode: episode ?? null,
    latestIntake,
    plans,
  });
}
