// GET /api/exercises/:id — full exercise detail: instructions, media, license
// provenance, equipment, and progression neighbors (easier ← this → harder).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;

  const {
    rows: [exercise],
  } = await pool.query(
    `SELECT e.id, e.name, e.source, e.source_key, e.instructions, e.body_regions,
            e.position, e.difficulty, e.tags, e.images, e.video_url,
            e.license, e.license_author, e.source_url
     FROM exercises e WHERE e.id = $1 AND e.archived_at IS NULL`,
    [id],
  );
  if (!exercise) return NextResponse.json({ error: "not found" }, { status: 404 });

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
