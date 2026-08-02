// GET /api/me/visits — MY OWN in-office history, for the patient's "In office"
// tab (PRD build step 6; this is what retires the placeholder step 4 shipped).
// Self-scoped by identity, no id in the URL.
//
// Only ENDED visits. A visit still open is a PT mid-session with a half-filled
// list; the patient seeing it fill in live would read as a record when it is
// still a draft.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";

const HISTORY_LIMIT = 20;

export async function GET(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { rows: visits } = await pool.query(
    // startedOn is the day label, resolved by Postgres so it agrees with every
    // other date in the app (see the note in /api/visits).
    `SELECT v.id, v.started_at AS "startedAt", v.started_at::date::text AS "startedOn",
            v.ended_at AS "endedAt", v.note, u.display_name AS "ptName"
     FROM visits v
     JOIN episodes ep ON ep.id = v.episode_id
     LEFT JOIN users u ON u.id = v.pt_user_id
     WHERE ep.patient_user_id = $1 AND v.ended_at IS NOT NULL
     ORDER BY v.started_at DESC LIMIT ${HISTORY_LIMIT}`,
    [user.id],
  );
  if (visits.length === 0) return NextResponse.json({ visits: [] });

  const { rows: items } = await pool.query(
    `SELECT vi.visit_id AS "visitId", e.name, (e.images ->> 0) AS image,
            vi.sets, vi.reps, vi.hold_secs AS "holdSecs", vi.pain, vi.note,
            (vi.plan_item_id IS NULL) AS "adHoc"
     FROM visit_items vi JOIN exercises e ON e.id = vi.exercise_id
     WHERE vi.visit_id = ANY($1::uuid[])
     ORDER BY vi.created_at`,
    [visits.map((v) => v.id)],
  );

  return NextResponse.json({
    visits: visits.map((v) => ({ ...v, items: items.filter((i) => i.visitId === v.id) })),
  });
}
