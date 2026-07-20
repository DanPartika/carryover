// POST /api/plans/:id/approve — the PT sign-off gate (doctrine #1): the draft
// becomes the episode's single active plan; any previous active plan retires.
// Only a PT assigned to the patient (or clinic admin) may approve.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const {
    rows: [plan],
  } = await pool.query<{ id: string; status: string; episode_id: string }>(
    "SELECT id, status, episode_id FROM plans WHERE id = $1",
    [id],
  );
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await episodeForActor(pool, plan.episode_id, user.id))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (plan.status !== "draft") {
    return NextResponse.json({ error: "plan is not a draft" }, { status: 409 });
  }

  const {
    rows: [{ n }],
  } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM plan_items WHERE plan_id = $1",
    [plan.id],
  );
  if (Number(n) === 0) {
    return NextResponse.json({ error: "cannot approve an empty plan" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE plans SET status = 'retired', retired_at = now()
       WHERE episode_id = $1 AND status = 'active'`,
      [plan.episode_id],
    );
    await client.query(
      `UPDATE plans SET status = 'active', approved_by = $2, approved_at = now()
       WHERE id = $1`,
      [plan.id, user.id],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
