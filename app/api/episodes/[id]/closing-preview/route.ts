// GET /api/episodes/:id/closing-preview?endedOn= — everything the PT should see
// BEFORE writing a word of the closing summary. No AI call, so it is instant and
// never fails because a model did.
//
// It answers: what would stop this close (an open visit), what closing leaves
// behind unanswered (a raised hand), where "care ended" should start (today,
// unless care went quiet long ago — closing a long-stale episode as of today
// would score the weeks the patient was already gone), and the numbers and
// patient-facing plan this close would file, for the date chosen.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { buildClosingContext, closingPreview, isDay, planSnapshots } from "@/lib/episodes/closing";
import { closedEpisodeResponse } from "@/lib/episodes/guard";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const episode = await episodeForActor(pool, id, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (episode.closed) return closedEpisodeResponse();

  const preview = await closingPreview(pool, episode.id);
  if (!preview) return NextResponse.json({ error: "not found" }, { status: 404 });

  const asked = req.nextUrl.searchParams.get("endedOn");
  let endedOn = preview.suggestedEndedOn;
  if (asked) {
    if (!isDay(asked) || asked < preview.startedOn || asked > preview.today) {
      return NextResponse.json(
        { error: "care can't have ended before it started or after today" },
        { status: 400 },
      );
    }
    endedOn = asked;
  }

  const context = await buildClosingContext(pool, episode.id, endedOn);
  const finalPlan = (await planSnapshots(pool, [episode.id], "last")).get(episode.id) ?? null;

  return NextResponse.json({ preview, endedOn, context, finalPlan });
}
