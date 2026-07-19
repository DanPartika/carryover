// GET /api/exercises — library browse with facet filters (PRD build step 1):
// ?q= name search · ?region= body region · ?equipment= catalog slug ·
// ?difficulty= max level · ?position= · ?source= · ?limit=/&offset= pagination.
// Signed-in users only (invite-only app; requireUser also covers the dev user).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const MAX_LIMIT = 100;

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
