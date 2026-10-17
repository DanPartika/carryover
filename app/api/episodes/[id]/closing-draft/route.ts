// POST /api/episodes/:id/closing-draft {endedOn?} — the AI's first pass at the
// closing summary, for the PT to edit. Changes NOTHING: no episode state, no
// plan, no patient-visible text. The patient sees words only after the PT
// presses Close on /close with their own edited version.
//
// Never a dead end. A PT who has finished with a patient must always be able to
// close, whatever state the model is in (an expired key, a timeout, a draft that
// kept breaking the rules): on any failure this returns the plain template with
// fellBack: true, and logs the real reason to ai_call_log. "Write it myself"
// never calls this route at all.

import { NextRequest, NextResponse } from "next/server";
import { closingModel, draftClosingSummary } from "@/lib/ai/closing";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { isDay } from "@/lib/episodes/closing";
import { closedEpisodeResponse } from "@/lib/episodes/guard";
import { loadClosingInput } from "@/lib/episodes/input";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { endedOn?: unknown } | null;
  const endedOn = isDay(body?.endedOn) ? body.endedOn : undefined;

  const episode = await episodeForActor(pool, id, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (episode.closed) return closedEpisodeResponse();

  const input = await loadClosingInput(pool, episode.id, endedOn);
  if (!input) return NextResponse.json({ error: "not found" }, { status: 404 });

  const started = Date.now();
  const result = await draftClosingSummary({ input, jwt: user.token });

  await pool.query(
    `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
     VALUES ($1, 'episode-close', $2, $3, $4, $5, $6)`,
    [
      user.id,
      process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture",
      result.model ?? (process.env.CARRYOVER_AI_MODE === "lithe" ? closingModel() : null),
      result.fellBack ? "error" : "ok",
      Date.now() - started,
      result.reason,
    ],
  );

  return NextResponse.json({
    draft: result.body,
    mode: result.mode,
    fellBack: result.fellBack,
  });
}
