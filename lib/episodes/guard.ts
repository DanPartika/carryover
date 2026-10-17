// A closed episode is the record of a finished course of care: read-only.
//
// Two layers, because a check at the top of a route is not enough on its own:
//   * closedEpisodeResponse() — the pre-check every mutating route does after
//     it resolves its episode, so a stale tab gets a clear 409 instead of a
//     silent write into history.
//   * lockOpenEpisode() — taken as the first statement of a route's write
//     transaction. Closing takes the same row FOR UPDATE, so a concurrent close
//     and a concurrent approve/revise serialize: the revision either lands
//     first (and the close then retires it) or sees the episode closed and
//     aborts. Without it the pre-check races the close by a few milliseconds.

import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

export const EPISODE_CLOSED_MESSAGE =
  "this episode was closed — reload the page to see where things stand";

/** `code` is what the client keys on (lib/api/client.ts): any page holding a
 *  stale view reloads itself instead of showing a bare status number. */
export const EPISODE_CLOSED_CODE = "episode_closed";

export function closedEpisodeResponse(): NextResponse {
  return NextResponse.json(
    { error: EPISODE_CLOSED_MESSAGE, code: EPISODE_CLOSED_CODE },
    { status: 409 },
  );
}

/** The database's own backstop (migration 0016's trigger) raising for a write
 *  into a closed episode — the narrow race the pre-checks can't see. */
export function isEpisodeClosedError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "23514" && /is closed/.test(e.message ?? "");
}

/** Share-lock the episode row if (and only if) it is still open. Call inside
 *  an open transaction, before the writes. False means it closed underneath
 *  the caller — ROLLBACK and answer with closedEpisodeResponse(). */
export async function lockOpenEpisode(client: PoolClient, episodeId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    "SELECT 1 FROM episodes WHERE id = $1 AND closed_at IS NULL FOR SHARE",
    [episodeId],
  );
  return rowCount === 1;
}
