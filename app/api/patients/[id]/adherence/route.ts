// GET /api/patients/:id/adherence?clinicId=&days= — the PT dashboard (PRD
// build step 5): home-exercise compliance, the pain trend, everything the
// patient flagged or wrote, and the last stored AI summary with its staleness.
// Treatment-relationship gated, same as the rest of the PT surface.

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_WINDOW_DAYS, loadAdherence } from "@/lib/adherence/load";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const WINDOW_CHOICES = [7, 14, 28, 90];

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

  // Only the offered windows — an arbitrary ?days= would let a caller widen
  // the scan far past what the UI can honestly label.
  const asked = Number(req.nextUrl.searchParams.get("days"));
  const days = WINDOW_CHOICES.includes(asked) ? asked : DEFAULT_WINDOW_DAYS;

  const {
    rows: [episode],
  } = await pool.query<{ id: string; condition: string }>(
    `SELECT id, condition FROM episodes
     WHERE patient_user_id = $1 AND clinic_id = $2 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [patientId, clinicId],
  );
  if (!episode) return NextResponse.json({ episode: null, summary: null });

  const view = await loadAdherence(pool, episode.id, days);

  const {
    rows: [summary],
  } = await pool.query(
    `SELECT s.id, s.body, s.window_days AS "windowDays", s.mode, s.model,
            s.created_at AS "createdAt",
            (SELECT count(*)::int
               FROM adherence_logs al
               JOIN plan_items pi ON pi.id = al.plan_item_id
               JOIN plans p ON p.id = pi.plan_id
              WHERE p.episode_id = s.episode_id
                AND (s.logs_through IS NULL OR al.updated_at > s.logs_through)
            ) AS "newLogsSince"
     FROM adherence_summaries s
     WHERE s.episode_id = $1
     ORDER BY s.created_at DESC LIMIT 1`,
    [episode.id],
  );

  return NextResponse.json({
    episode,
    windowChoices: WINDOW_CHOICES,
    ...view,
    summary: summary ?? null,
  });
}
