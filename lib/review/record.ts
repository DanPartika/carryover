// Writing down that a check-in happened.
//
// Every path that ends a check-in goes through here — the one-tap swap, an
// approved revamp, and "no change today" — so the clock the "due for review"
// signal counts from can never be reset by one of them and not another.

import type { PoolClient } from "pg";
import type { ReviewContext } from "./signals";

export type ReviewOutcome = "progressed" | "regressed" | "revamped" | "no_change";

export async function recordReview(
  client: PoolClient,
  args: {
    episodeId: string;
    reviewedBy: string;
    outcome: ReviewOutcome;
    planId?: string | null;
    note?: string | null;
    context: ReviewContext | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO plan_reviews (episode_id, reviewed_by, outcome, plan_id, note, context)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      args.episodeId,
      args.reviewedBy,
      args.outcome,
      args.planId ?? null,
      args.note?.trim().slice(0, 1000) || null,
      args.context ? JSON.stringify(args.context) : null,
    ],
  );
}

/** A hand stays up until someone looks. Any review outcome puts it down —
 *  including "no change today", which is an answer to the patient even when
 *  nothing about the plan moves. */
export async function resolveOpenRequest(
  client: PoolClient,
  episodeId: string,
  resolvedBy: string,
): Promise<void> {
  await client.query(
    `UPDATE checkin_requests SET resolved_at = now(), resolved_by = $2
     WHERE episode_id = $1 AND resolved_at IS NULL`,
    [episodeId, resolvedBy],
  );
}
