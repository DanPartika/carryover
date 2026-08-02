// POST /api/patients/:id/summary?clinicId=&days= — generate and store the AI
// adherence summary for the PT (PRD §2, build step 5). Reads through the same
// loader the dashboard renders from, so the prose and the numbers agree.

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_WINDOW_DAYS, loadAdherence } from "@/lib/adherence/load";
import { summarizeAdherence, summaryModel } from "@/lib/ai/summary";
import { requireUser } from "@/lib/auth/identity";
import { canTreat } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

const WINDOW_CHOICES = [7, 14, 28, 90];

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: patientId } = await ctx.params;
  const clinicId = req.nextUrl.searchParams.get("clinicId");
  if (!clinicId) return NextResponse.json({ error: "clinicId required" }, { status: 400 });
  if (!(await canTreat(pool, user.id, patientId, clinicId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
  if (!episode) return NextResponse.json({ error: "no open episode" }, { status: 400 });

  const view = await loadAdherence(pool, episode.id, days);
  if (!view.plan) {
    return NextResponse.json({ error: "no active plan to summarize" }, { status: 400 });
  }
  if (view.compliance.completed === 0 && view.flags.length === 0) {
    // The dashboard already states "nothing logged" in plain text. Spending a
    // model call to restate it is the one summary that can't earn its cost.
    return NextResponse.json(
      { error: "nothing logged in this window yet — nothing to summarize" },
      { status: 400 },
    );
  }

  const started = Date.now();
  let result;
  try {
    result = await summarizeAdherence({
      input: {
        condition: episode.condition,
        windowDays: view.windowDays,
        compliance: view.compliance,
        pain: view.pain,
        flags: view.flags,
        visits: view.visits,
      },
      jwt: user.token,
    });
  } catch (err) {
    const errMode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
    await pool.query(
      `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
       VALUES ($1, 'adherence-summary', $2, $3, 'error', $4, $5)`,
      [
        user.id,
        errMode,
        errMode === "lithe" ? summaryModel() : null,
        Date.now() - started,
        String((err as Error).message).slice(0, 500),
      ],
    );
    return NextResponse.json({ error: "summary failed — try again" }, { status: 502 });
  }

  await pool.query(
    `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms)
     VALUES ($1, 'adherence-summary', $2, $3, 'ok', $4)`,
    [user.id, result.mode, result.model, Date.now() - started],
  );

  const {
    rows: [saved],
  } = await pool.query(
    `INSERT INTO adherence_summaries
       (episode_id, body, window_days, logs_through, mode, model, generated_by)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7)
     RETURNING id, body, window_days AS "windowDays", mode, model,
               created_at AS "createdAt", 0 AS "newLogsSince"`,
    [episode.id, result.body, view.windowDays, view.logsThrough, result.mode, result.model, user.id],
  );

  return NextResponse.json({ summary: saved }, { status: 201 });
}
