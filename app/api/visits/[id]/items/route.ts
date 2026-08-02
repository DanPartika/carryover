// Tap-done (PRD build step 6). POST upserts one exercise into the open visit,
// DELETE takes it back out — the two halves of a toggle a PT hits with a thumb
// while the patient is mid-set. Both refuse once the visit has ended.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { visitForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

type Body = {
  exerciseId?: string;
  planItemId?: string | null;
  sets?: number | null;
  reps?: number | null;
  holdSecs?: number | null;
  durationMins?: number | null;
  intensity?: string | null;
  pain?: number | null;
  note?: string | null;
};

function clampOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const visit = await visitForActor(pool, id, user.id);
  if (!visit) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (visit.endedAt) return NextResponse.json({ error: "visit already ended" }, { status: 409 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.exerciseId) return NextResponse.json({ error: "exerciseId required" }, { status: 400 });

  // A plan_item_id is only meaningful when it belongs to THIS episode; an id
  // from someone else's plan would silently cross-link two patients' records.
  let planItemId: string | null = null;
  if (body.planItemId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM plan_items pi JOIN plans p ON p.id = pi.plan_id
       WHERE pi.id = $1 AND p.episode_id = $2`,
      [body.planItemId, visit.episodeId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "plan item is not on this episode" }, { status: 400 });
    }
    planItemId = body.planItemId;
  }

  const {
    rows: [item],
  } = await pool.query(
    `INSERT INTO visit_items
       (visit_id, exercise_id, plan_item_id, sets, reps, hold_secs,
        duration_mins, intensity, pain, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (visit_id, exercise_id) DO UPDATE SET
       plan_item_id = EXCLUDED.plan_item_id, sets = EXCLUDED.sets, reps = EXCLUDED.reps,
       hold_secs = EXCLUDED.hold_secs, duration_mins = EXCLUDED.duration_mins,
       intensity = EXCLUDED.intensity, pain = EXCLUDED.pain, note = EXCLUDED.note
     RETURNING id, exercise_id AS "exerciseId", plan_item_id AS "planItemId",
               sets, reps, hold_secs AS "holdSecs",
               duration_mins AS "durationMins", intensity, pain, note`,
    [
      id,
      body.exerciseId,
      planItemId,
      clampOrNull(body.sets, 0, 20),
      clampOrNull(body.reps, 0, 100),
      clampOrNull(body.holdSecs, 1, 300),
      clampOrNull(body.durationMins, 1, 240),
      body.intensity?.trim().slice(0, 80) || null,
      clampOrNull(body.pain, 0, 10),
      body.note?.trim().slice(0, 500) || null,
    ],
  );
  return NextResponse.json({ item });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const visit = await visitForActor(pool, id, user.id);
  if (!visit) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (visit.endedAt) return NextResponse.json({ error: "visit already ended" }, { status: 409 });

  const exerciseId = req.nextUrl.searchParams.get("exerciseId");
  if (!exerciseId) return NextResponse.json({ error: "exerciseId required" }, { status: 400 });

  await pool.query("DELETE FROM visit_items WHERE visit_id = $1 AND exercise_id = $2", [
    id,
    exerciseId,
  ]);
  return NextResponse.json({ ok: true });
}
