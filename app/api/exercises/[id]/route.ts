// GET /api/exercises/:id — full exercise detail: instructions, media, license
// provenance, equipment, and progression neighbors (easier ← this → harder).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { canEditExercise, viewerClinicIds, visibleToViewerSql } from "@/lib/library/visibility";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const clinics = await viewerClinicIds(pool, user.id);

  const {
    rows: [exercise],
  } = await pool.query(
    `SELECT e.id, e.name, e.source, e.source_key, e.instructions, e.body_regions,
            e.position, e.difficulty, e.tags, e.images, e.video_url,
            e.license, e.license_author, e.source_url,
            e.dosage_type AS "dosageType", e.kind, e.clinic_id, e.shared,
            c.name AS "clinicName"
     FROM exercises e
     LEFT JOIN clinics c ON c.id = e.clinic_id
     WHERE e.id = $1 AND e.archived_at IS NULL AND ${visibleToViewerSql("$2")}`,
    [id, clinics],
  );
  // A clinic-private exercise from another clinic is "not found", not
  // "forbidden": 403 would confirm the row exists.
  if (!exercise) return NextResponse.json({ error: "not found" }, { status: 404 });
  exercise.canEdit = canEditExercise(exercise, clinics);

  const { rows: equipment } = await pool.query(
    `SELECT ec.slug, ec.name, ec.kind
     FROM exercise_equipment ee JOIN equipment_catalog ec ON ec.id = ee.equipment_id
     WHERE ee.exercise_id = $1 ORDER BY ec.name`,
    [id],
  );

  const { rows: harder } = await pool.query(
    `SELECT x.id, x.name, p.note FROM exercise_progressions p
     JOIN exercises x ON x.id = p.to_exercise_id
     WHERE p.from_exercise_id = $1 AND x.archived_at IS NULL ORDER BY x.name`,
    [id],
  );
  const { rows: easier } = await pool.query(
    `SELECT x.id, x.name, p.note FROM exercise_progressions p
     JOIN exercises x ON x.id = p.from_exercise_id
     WHERE p.to_exercise_id = $1 AND x.archived_at IS NULL ORDER BY x.name`,
    [id],
  );

  return NextResponse.json({ exercise, equipment, progressions: { easier, harder } });
}

// PATCH /api/exercises/:id — edit a clinic's own exercise, or flip its Share
// state. The built-in library is not editable in-app: a "typo fix" that
// rewrote free-exercise-db rows would silently change what other clinics have
// already prescribed, and its licence provenance would stop being true.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const clinics = await viewerClinicIds(pool, user.id);

  const {
    rows: [existing],
  } = await pool.query<{ clinic_id: string | null }>(
    "SELECT clinic_id FROM exercises WHERE id = $1 AND archived_at IS NULL",
    [id],
  );
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canEditExercise(existing, clinics)) {
    return NextResponse.json(
      { error: "only the clinic that wrote an exercise can change it" },
      { status: 403 },
    );
  }

  const patch = (await req.json().catch(() => null)) as {
    name?: string;
    instructions?: string[];
    difficulty?: number | null;
    shared?: boolean;
    archived?: boolean;
  } | null;

  if (patch?.archived === true) {
    // Archive, never delete: plan_items and visit_items reference this row,
    // and a patient's history must not lose the name of what they did.
    await pool.query("UPDATE exercises SET archived_at = now() WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, archived: true });
  }

  const name = patch?.name?.trim().slice(0, 120);
  if (patch?.name !== undefined && !name) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }
  const instructions =
    patch?.instructions === undefined
      ? null
      : JSON.stringify(
          patch.instructions
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 12)
            .map((s) => s.slice(0, 500)),
        );

  const {
    rows: [updated],
  } = await pool.query(
    `UPDATE exercises SET
       name = COALESCE($2, name),
       instructions = COALESCE($3::jsonb, instructions),
       difficulty = COALESCE($4, difficulty),
       shared = COALESCE($5, shared)
     WHERE id = $1
     RETURNING id, name, shared, difficulty`,
    [id, name ?? null, instructions, patch?.difficulty ?? null, patch?.shared ?? null],
  );
  return NextResponse.json({ exercise: updated });
}
