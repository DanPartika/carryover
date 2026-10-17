// POST /api/episodes/:id/reopen — undo a close. The escape hatch for a mis-tap on
// a phone, deliberately narrow:
//   - only the NEWEST closed episode for this patient and clinic;
//   - only while no newer episode is open (the patient's own "something new"
//     intake, or the PT's, counts — reopening on top of it would mean two);
//   - only for REOPEN_WINDOW_HOURS after closing.
//
// What it restores: the plan that was in force (closing_plan_id) goes back to
// active, and the episode's closing_* columns clear. Drafts and a raised hand
// were never touched by the close, so there is nothing to un-delete.
//
// What it cannot un-do: the patient may already have read the summary. That is
// why every close is appended to episode_closures and stays there — marked
// reopened, never erased.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { REOPEN_WINDOW_HOURS } from "@/lib/episodes/closing";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const episode = await episodeForActor(pool, id, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      rows: [e],
    } = await client.query<{
      closed_at: Date | null;
      closing_plan_id: string | null;
      inWindow: boolean;
    }>(
      `SELECT closed_at, closing_plan_id,
              (closed_at > now() - interval '${REOPEN_WINDOW_HOURS} hours') AS "inWindow"
       FROM episodes WHERE id = $1 FOR UPDATE`,
      [episode.id],
    );
    const refuse = async (error: string) => {
      await client.query("ROLLBACK");
      return NextResponse.json({ error }, { status: 409 });
    };
    if (!e || !e.closed_at) return await refuse("this episode isn't closed");
    if (!e.inWindow) {
      return await refuse(
        `it can only be reopened within ${REOPEN_WINDOW_HOURS} hours of closing — start a new episode instead`,
      );
    }

    const { rowCount: newerOpen } = await client.query(
      `SELECT 1 FROM episodes
       WHERE clinic_id = $1 AND patient_user_id = $2 AND closed_at IS NULL`,
      [episode.clinicId, episode.patientUserId],
    );
    if (newerOpen) return await refuse("a newer episode has already started for this patient");

    // Compared in SQL, never through a JS Date: node-postgres truncates
    // timestamptz to milliseconds, which would put this episode's own closed_at
    // a few hundred microseconds BEFORE itself and count it as "newer".
    const { rowCount: newerClosed } = await client.query(
      `SELECT 1 FROM episodes
       WHERE clinic_id = $1 AND patient_user_id = $2 AND id <> $3
         AND closed_at > (SELECT closed_at FROM episodes WHERE id = $3)`,
      [episode.clinicId, episode.patientUserId, episode.id],
    );
    if (newerClosed) return await refuse("only the most recently closed episode can be reopened");

    if (e.closing_plan_id) {
      await client.query(
        `UPDATE plans SET status = 'active', retired_at = NULL
         WHERE id = $1 AND episode_id = $2 AND status = 'retired'`,
        [e.closing_plan_id, episode.id],
      );
    }

    await client.query(
      `UPDATE episodes
       SET closed_at = NULL, closed_by = NULL, ended_on = NULL, closing_summary = NULL,
           closing_watch_for = NULL, closing_ai_assisted = false, closing_context = NULL,
           closing_plan_id = NULL
       WHERE id = $1`,
      [episode.id],
    );

    await client.query(
      `UPDATE episode_closures SET reopened_by = $2, reopened_at = now()
       WHERE id = (SELECT id FROM episode_closures
                   WHERE episode_id = $1 AND reopened_at IS NULL
                   ORDER BY closed_at DESC LIMIT 1)`,
      [episode.id, user.id],
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
