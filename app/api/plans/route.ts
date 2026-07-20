// POST /api/plans — create a plan for an episode, either drafted by AI from
// the latest intake (source: "ai-draft") or empty for manual building
// (source: "manual"). Draft status until a PT approves. Treatment-gated.

import { NextRequest, NextResponse } from "next/server";
import { draftPlan, planModel, type IntakeForPrompt } from "@/lib/ai/plan";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

type Body = { episodeId?: string; source?: "ai-draft" | "manual" };

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }
  const episode = await episodeForActor(pool, body.episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const source = body.source === "manual" ? "manual" : "ai-draft";

  let items: Awaited<ReturnType<typeof draftPlan>>["items"] = [];
  let model: string | null = null;
  let mode = "fixture";
  let dropped = 0;

  if (source === "ai-draft") {
    const {
      rows: [intake],
    } = await pool.query<IntakeForPrompt & { id: string }>(
      `SELECT id, condition, body_regions, onset_date::text AS onset_date,
              pain_now, pain_worst, goals, restrictions, narrative
       FROM intakes WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [episode.id],
    );
    if (!intake) {
      return NextResponse.json(
        { error: "complete an intake before drafting with AI" },
        { status: 400 },
      );
    }

    const started = Date.now();
    try {
      const result = await draftPlan({
        pool,
        intake,
        patientUserId: episode.patientUserId,
        jwt: user.token,
      });
      items = result.items;
      model = result.model;
      mode = result.mode;
      dropped = result.droppedItems;
      if (items.length === 0) {
        // All items dropped by grounding validation (or the model proposed
        // none) — an empty "AI draft" is a failure, not a plan.
        await pool.query(
          `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, dropped_items, error)
           VALUES ($1, 'plan-draft', $2, $3, 'error', $4, $5, 'empty draft after validation')`,
          [user.id, mode, model, Date.now() - started, dropped],
        );
        return NextResponse.json({ error: "draft came back empty — try again" }, { status: 502 });
      }
      await pool.query(
        `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, dropped_items)
         VALUES ($1, 'plan-draft', $2, $3, 'ok', $4, $5)`,
        [user.id, mode, model, Date.now() - started, dropped],
      );
    } catch (err) {
      const errMode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
      await pool.query(
        `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
         VALUES ($1, 'plan-draft', $2, $3, 'error', $4, $5)`,
        [
          user.id,
          errMode,
          errMode === "lithe" ? planModel() : null,
          Date.now() - started,
          String((err as Error).message).slice(0, 500),
        ],
      );
      return NextResponse.json({ error: "draft failed — try again" }, { status: 502 });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [plan],
    } = await client.query<{ id: string }>(
      `INSERT INTO plans (episode_id, status, source, model, created_by)
       VALUES ($1, 'draft', $2, $3, $4) RETURNING id`,
      [episode.id, source, model, user.id],
    );
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, frequency_per_week, location, rationale, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          plan.id,
          it.exercise_id,
          it.sets,
          it.reps,
          it.hold_secs,
          it.frequency_per_week,
          it.location,
          it.rationale,
          i,
        ],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json(
      { planId: plan.id, itemCount: items.length, mode, model, droppedItems: dropped },
      { status: 201 },
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
