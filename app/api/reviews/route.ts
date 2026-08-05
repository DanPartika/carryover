// POST /api/reviews — "I looked, and the plan stays as it is."
//
// The outcome that makes the other three honest. Without it, a plan a PT has
// deliberately decided to leave alone keeps raising the same chip every time
// they open the patient, and a signal that can't be answered is a signal a PT
// learns to ignore. Deciding to change nothing is a decision, and it resets the
// clock exactly like a revamp does.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { recordReview, resolveOpenRequest } from "@/lib/review/record";
import { reviewContext, reviewSignals } from "@/lib/review/signals";

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { episodeId?: string; note?: string }
    | null;
  if (!body?.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }
  const episode = await episodeForActor(pool, body.episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const context = reviewContext((await reviewSignals(pool, [episode.id])).get(episode.id));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordReview(client, {
      episodeId: episode.id,
      reviewedBy: user.id,
      outcome: "no_change",
      note: body.note ?? null,
      context,
    });
    await resolveOpenRequest(client, episode.id, user.id);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
