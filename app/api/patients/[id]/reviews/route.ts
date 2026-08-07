// GET /api/patients/:id/reviews?clinicId= — the episode's check-in history,
// newest first. plan_reviews rows have been accumulating since 0010 with no
// UI reading them back; this is the readback. Each row carries its frozen
// context (the numbers as they stood at the decision — logs stay editable,
// so recomputing would rewrite history).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const MAX_ROWS = 50;

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
    rows: [episode],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, clinicId],
  );
  if (!episode) return NextResponse.json({ reviews: [] });

  const { rows: reviews } = await pool.query(
    `SELECT pr.id, pr.outcome, pr.note, pr.context,
            pr.created_at::date::text AS "on",
            u.display_name AS "reviewedByName",
            p.source AS "planSource"
     FROM plan_reviews pr
     JOIN users u ON u.id = pr.reviewed_by
     LEFT JOIN plans p ON p.id = pr.plan_id
     WHERE pr.episode_id = $1
     ORDER BY pr.created_at DESC
     LIMIT ${MAX_ROWS}`,
    [episode.id],
  );

  return NextResponse.json({ reviews });
}
