// POST /api/me/checkin — the patient raising a hand. DELETE — putting it down.
//
// The trigger the app can't compute. A patient can be at 100% adherence with
// pain at 2 and still be bored out of their mind on a plan they've outgrown,
// or be quietly cutting every set in half because it hurts. Silence reads the
// same either way; asking is the only way to know.
//
// Self-scoped by identity like the rest of /api/me — no episode id in the body
// to authorize, because a patient can only ever raise a hand on their own care.
// This is a REQUEST, never an instruction: it puts a chip in front of the PT
// and changes nothing about the plan.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const KINDS = ["too_easy", "too_hard", "something_changed"];

async function openEpisode(
  pool: ReturnType<typeof getPool>,
  userId: string,
): Promise<string | null> {
  const {
    rows: [ep],
  } = await pool.query<{ id: string }>(
    `SELECT id FROM episodes WHERE patient_user_id = $1 AND closed_at IS NULL
     ORDER BY opened_at DESC LIMIT 1`,
    [userId],
  );
  return ep?.id ?? null;
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kind?: string; note?: string } | null;
  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "kind required" }, { status: 400 });
  }
  const episodeId = await openEpisode(pool, user.id);
  if (!episodeId) return NextResponse.json({ error: "no open episode" }, { status: 400 });

  // Raising a hand twice is the same hand, not a queue — the second press
  // updates the open row. ON CONFLICT names the partial index's predicate,
  // which Postgres requires to infer it.
  const {
    rows: [row],
  } = await pool.query<{ id: string; kind: string; note: string | null; on: string }>(
    `INSERT INTO checkin_requests (episode_id, patient_user_id, kind, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (episode_id) WHERE resolved_at IS NULL
     DO UPDATE SET kind = EXCLUDED.kind, note = EXCLUDED.note, created_at = now()
     RETURNING id, kind, note, created_at::date::text AS "on"`,
    [episodeId, user.id, body.kind, body.note?.trim().slice(0, 500) || null],
  );
  return NextResponse.json({ checkin: row }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Deleted, not resolved: a hand put down before anyone looked is a change of
  // mind, and marking it "resolved" would claim a PT answered it.
  await pool.query(
    `DELETE FROM checkin_requests
     WHERE patient_user_id = $1 AND resolved_at IS NULL`,
    [user.id],
  );
  return NextResponse.json({ ok: true });
}
