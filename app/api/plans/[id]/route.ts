// PATCH /api/plans/:id — replace a DRAFT plan's items (the editor saves the
// whole list; simplest correct semantics for a short list). Approved plans are
// immutable — start a new draft instead (doctrine #1: the approved record is
// what the patient saw).
// DELETE /api/plans/:id — discard a draft.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

type ItemInput = {
  exerciseId?: string;
  sets?: number | null;
  reps?: number | null;
  holdSecs?: number | null;
  frequencyPerWeek?: number;
  location?: "office" | "home" | "both";
  rationale?: string;
};

function clampOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

async function loadDraftPlan(
  req: NextRequest,
  planId: string,
): Promise<
  | { error: NextResponse }
  | { pool: ReturnType<typeof getPool>; plan: { id: string; status: string; episode_id: string } }
> {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  const {
    rows: [plan],
  } = await pool.query<{ id: string; status: string; episode_id: string }>(
    "SELECT id, status, episode_id FROM plans WHERE id = $1",
    [planId],
  );
  if (!plan) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  if (!(await episodeForActor(pool, plan.episode_id, user.id))) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (plan.status !== "draft") {
    return {
      error: NextResponse.json(
        { error: "only draft plans can be changed — start a new draft" },
        { status: 409 },
      ),
    };
  }
  return { pool, plan };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadDraftPlan(req, id);
  if ("error" in loaded) return loaded.error;
  const { pool, plan } = loaded;

  const body = (await req.json().catch(() => null)) as { items?: ItemInput[] } | null;
  if (!body?.items || !Array.isArray(body.items) || body.items.length > 30) {
    return NextResponse.json({ error: "items array required (max 30)" }, { status: 400 });
  }

  const exerciseIds = body.items.map((i) => String(i.exerciseId ?? ""));
  const { rows: valid } = await pool.query<{ id: string }>(
    "SELECT id FROM exercises WHERE id = ANY($1::uuid[]) AND archived_at IS NULL",
    [exerciseIds.filter((s) => /^[0-9a-f-]{36}$/.test(s))],
  );
  const validIds = new Set(valid.map((r) => r.id));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM plan_items WHERE plan_id = $1", [plan.id]);
    let sort = 0;
    for (const it of body.items) {
      const exerciseId = String(it.exerciseId ?? "");
      if (!validIds.has(exerciseId)) continue;
      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, frequency_per_week, location, rationale, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          plan.id,
          exerciseId,
          clampOrNull(it.sets, 1, 10),
          clampOrNull(it.reps, 1, 50),
          clampOrNull(it.holdSecs, 1, 300),
          clampOrNull(it.frequencyPerWeek, 1, 14) ?? 5,
          ["office", "home", "both"].includes(String(it.location)) ? it.location : "home",
          String(it.rationale ?? "").slice(0, 500) || null,
          sort++,
        ],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, itemCount: sort });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadDraftPlan(req, id);
  if ("error" in loaded) return loaded.error;
  await loaded.pool.query("DELETE FROM plans WHERE id = $1", [loaded.plan.id]);
  return NextResponse.json({ ok: true });
}
