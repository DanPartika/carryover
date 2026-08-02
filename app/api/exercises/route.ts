// GET /api/exercises — library browse with facet filters (PRD build step 1):
// ?q= name search · ?region= body region · ?equipment= catalog slug ·
// ?difficulty= max level · ?position= · ?source= · ?limit=/&offset= pagination.
// Signed-in users only (invite-only app; requireUser also covers the dev user).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canManage, rolesInClinic } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { viewerClinicIds, visibleToViewerSql } from "@/lib/library/visibility";

const MAX_LIMIT = 100;
const BODY_REGIONS = [
  "neck", "shoulder", "elbow", "wrist_hand", "spine",
  "core", "hip", "knee", "ankle_foot", "full_body",
];
const POSITIONS = ["standing", "seated", "supine", "prone", "side_lying", "quadruped"];

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const where: string[] = ["e.archived_at IS NULL"];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };

  // Clinic-authored exercises are private to their clinic until shared. This
  // predicate must match the one the AI's library slice uses, or a PT would
  // see an exercise the draft can never pick (or worse, the reverse).
  where.push(visibleToViewerSql(arg(await viewerClinicIds(pool, user.id))));

  const q = p.get("q")?.trim();
  if (q) where.push(`e.name ILIKE ${arg(`%${q}%`)}`);

  const region = p.get("region");
  if (region) where.push(`${arg(region)} = ANY(e.body_regions)`);

  const position = p.get("position");
  if (position) where.push(`e.position = ${arg(position)}`);

  const source = p.get("source");
  if (source) where.push(`e.source = ${arg(source)}`);

  // Default view is the curated rehab tier; ?tier=all opts in to gym extras.
  if (p.get("tier") !== "all") where.push(`e.tier = 'rehab'`);

  // Modalities (ice, heat, TENS, compression) share the exercises table but
  // are not exercises — they'd be noise in a browse or an add-exercise search.
  // ?kind=modality asks for them; ?kind=any drops the filter entirely.
  const kind = p.get("kind");
  if (kind === "modality") where.push(`e.kind = 'modality'`);
  else if (kind !== "any") where.push(`e.kind = 'exercise'`);

  const difficulty = Number(p.get("difficulty"));
  if (difficulty >= 1 && difficulty <= 5) where.push(`e.difficulty <= ${arg(difficulty)}`);

  const equipment = p.get("equipment");
  if (equipment) {
    where.push(`EXISTS (
      SELECT 1 FROM exercise_equipment ee
      JOIN equipment_catalog ec ON ec.id = ee.equipment_id
      WHERE ee.exercise_id = e.id AND ec.slug = ${arg(equipment)}
    )`);
  }

  const limit = Math.min(Math.max(Number(p.get("limit")) || 30, 1), MAX_LIMIT);
  const offset = Math.max(Number(p.get("offset")) || 0, 0);

  const whereSql = where.join(" AND ");
  const { rows: items } = await pool.query(
    `SELECT e.id, e.name, e.source, e.body_regions, e.position, e.difficulty, e.tags,
            e.dosage_type AS "dosageType", e.kind,
            e.clinic_id AS "clinicId", e.shared,
            (e.images ->> 0) AS image,
            COALESCE(
              (SELECT array_agg(ec.name ORDER BY ec.name)
               FROM exercise_equipment ee JOIN equipment_catalog ec ON ec.id = ee.equipment_id
               WHERE ee.exercise_id = e.id),
              '{}'
            ) AS equipment
     FROM exercises e
     WHERE ${whereSql}
     ORDER BY (e.source = 'carryover') DESC, e.difficulty NULLS LAST, e.name
     LIMIT ${arg(limit)} OFFSET ${arg(offset)}`,
    args,
  );

  const countArgs = args.slice(0, args.length - 2);
  const {
    rows: [{ n }],
  } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM exercises e WHERE ${whereSql}`,
    countArgs,
  );

  return NextResponse.json({ items, total: Number(n), limit, offset });
}

// POST /api/exercises — a PT writes their own. It lands CLINIC-PRIVATE; the
// Share button (PATCH) is what promotes it to the library every clinic sees.
//
// Written as source='clinic' with license='owned': the library permanently
// mixes licence regimes (PRD §2), and a row with no provenance is a row nobody
// can later work out whether they're allowed to publish.
export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    clinicId?: string;
    name?: string;
    instructions?: string[];
    bodyRegions?: string[];
    position?: string | null;
    difficulty?: number | null;
    dosageType?: string;
    kind?: string;
    videoUrl?: string | null;
    equipmentSlugs?: string[];
  } | null;

  if (!body?.clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  const name = body.name?.trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  // Authoring into a clinic's library is a clinician act, not a patient one.
  if (!canManage(await rolesInClinic(pool, user.id, body.clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const regions = (body.bodyRegions ?? []).filter((r) => BODY_REGIONS.includes(r));
  if (regions.length === 0) {
    // Not pedantry: the AI's library slice selects on body_regions, so a
    // region-less exercise is invisible to every draft ever made. Better to
    // refuse than to hand back an exercise that quietly never gets suggested.
    return NextResponse.json({ error: "pick at least one body region" }, { status: 400 });
  }

  const position = POSITIONS.includes(String(body.position)) ? body.position : null;
  const difficulty =
    Number.isFinite(Number(body.difficulty)) &&
    Number(body.difficulty) >= 1 &&
    Number(body.difficulty) <= 5
      ? Math.round(Number(body.difficulty))
      : null;
  const dosageType = ["reps", "hold", "time"].includes(String(body.dosageType))
    ? body.dosageType
    : "reps";
  const kind = body.kind === "modality" ? "modality" : "exercise";
  const instructions = (body.instructions ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((s) => s.slice(0, 500));

  // Only http(s): a javascript: or data: URL here would be rendered as a link
  // in both the PT's and the patient's browser.
  let videoUrl: string | null = null;
  if (body.videoUrl?.trim()) {
    try {
      const u = new URL(body.videoUrl.trim());
      if (u.protocol === "http:" || u.protocol === "https:") videoUrl = u.toString();
    } catch {
      /* not a URL — dropped rather than rejected; the exercise is still valid */
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [created],
    } = await client.query<{ id: string }>(
      `INSERT INTO exercises
         (source, clinic_id, name, instructions, body_regions, position, difficulty,
          dosage_type, kind, video_url, license, license_author, created_by, shared)
       VALUES ('clinic', $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9,
               'owned', (SELECT name FROM clinics WHERE id = $1), $10, false)
       RETURNING id`,
      [
        body.clinicId,
        name,
        JSON.stringify(instructions),
        regions,
        position,
        difficulty,
        dosageType,
        kind,
        videoUrl,
        user.id,
      ],
    );

    const slugs = (body.equipmentSlugs ?? []).filter((s) => typeof s === "string").slice(0, 10);
    if (slugs.length > 0) {
      await client.query(
        `INSERT INTO exercise_equipment (exercise_id, equipment_id)
         SELECT $1, ec.id FROM equipment_catalog ec WHERE ec.slug = ANY($2)
         ON CONFLICT DO NOTHING`,
        [created.id, slugs],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
