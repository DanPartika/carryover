// Everything the closing-summary draft is written from, assembled in one place
// so the draft route and any future caller read the same record.
//
// Deliberately narrow (see lib/ai/closing.ts): the episode's measurements and
// the PT's own recorded decisions. Not the patient's free-text notes, not the
// PT's private notes, not plans.ai_note, not pain.

import type { Pool } from "pg";
import type { ClosingDecision, ClosingInput } from "@/lib/ai/closing";
import { dayOf } from "@/lib/dates";
import { buildClosingContext, planSnapshots } from "./closing";

const MAX_DECISIONS = 40;

/** Name parts worth scrubbing from free text: display-name words and the part
 *  of the email before the @. */
function nameParts(displayName: string | null, email: string | null): string[] {
  const parts = new Set<string>();
  for (const w of (displayName ?? "").split(/\s+/)) if (w) parts.add(w);
  const local = (email ?? "").split("@")[0];
  if (local) parts.add(local);
  return [...parts];
}

export async function loadClosingInput(
  pool: Pool,
  episodeId: string,
  endedOn?: string,
): Promise<ClosingInput | null> {
  const {
    rows: [episode],
  } = await pool.query<{ condition: string; displayName: string | null; email: string | null }>(
    `SELECT e.condition, u.display_name AS "displayName", u.email
     FROM episodes e JOIN users u ON u.id = e.patient_user_id WHERE e.id = $1`,
    [episodeId],
  );
  if (!episode) return null;

  const context = await buildClosingContext(pool, episodeId, endedOn);
  if (!context) return null;

  const {
    rows: [intake],
  } = await pool.query<{ goals: string | null }>(
    `SELECT goals FROM intakes WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [episodeId],
  );

  const [first, last] = await Promise.all([
    planSnapshots(pool, [episodeId], "first"),
    planSnapshots(pool, [episodeId], "last"),
  ]);

  const { rows: decisions } = await pool.query<ClosingDecision>(
    `SELECT ${dayOf("created_at")}::text AS "on", outcome, note
     FROM plan_reviews WHERE episode_id = $1 AND ${dayOf("created_at")} <= $2::date
     ORDER BY created_at ASC LIMIT ${MAX_DECISIONS}`,
    [episodeId, context.endedOn],
  );

  return {
    condition: episode.condition,
    intakeGoals: intake?.goals?.trim() || null,
    context,
    start: first.get(episodeId) ?? null,
    end: last.get(episodeId) ?? null,
    decisions,
    patientNames: nameParts(episode.displayName, episode.email),
  };
}
