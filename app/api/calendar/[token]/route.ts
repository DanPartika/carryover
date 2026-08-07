// The ICS subscription feed. [open + capability token]: Google Calendar polls
// this URL and cannot send bearer headers, so the secret in the path IS the
// auth (same model as Google's own "secret address" feeds, and as the plants
// app). Content is limited to the patient's own home program — exercise names
// and dosages; every mutation stays bearer-only elsewhere.
//
// The honest limit: Google polls subscribed feeds on ITS OWN schedule,
// typically every few hours. This is "my calendar shows my program", never a
// live view — making it live would mean Google OAuth and a Cloud project,
// exactly the dependency the ICS approach avoids.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { buildPatientFeed, type FeedItem } from "@/lib/calendar/ics";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  // Shape check before touching the DB; the unique index does the real lookup.
  if (!/^[a-f0-9]{48}$/.test(token)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const pool = getPool();
  const {
    rows: [user],
  } = await pool.query<{ id: string; display_name: string | null }>(
    "SELECT id, display_name FROM users WHERE calendar_token = $1",
    [token],
  );
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // The patient's active plan, if any. No plan (or no home items) is still a
  // 200 with an empty calendar — a subscription that 404s the day a plan ends
  // shows up in Google as a broken feed, not a finished program.
  const {
    rows: [plan],
  } = await pool.query<{ id: string; approved_on: string }>(
    `SELECT p.id, p.approved_at::date::text AS approved_on
     FROM plans p
     JOIN episodes ep ON ep.id = p.episode_id
     WHERE ep.patient_user_id = $1 AND ep.closed_at IS NULL AND p.status = 'active'
     ORDER BY p.approved_at DESC LIMIT 1`,
    [user.id],
  );

  let items: FeedItem[] = [];
  if (plan) {
    const { rows } = await pool.query<FeedItem>(
      `SELECT e.name, e.kind, pi.care_timing AS "careTiming",
              e.dosage_type AS "dosageType", pi.sets, pi.reps,
              pi.hold_secs AS "holdSecs", pi.duration_mins AS "durationMins",
              pi.intensity, pi.frequency_per_week AS "frequencyPerWeek"
       FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id
       WHERE pi.plan_id = $1 AND pi.location IN ('home', 'both')
       ORDER BY pi.sort, e.name`,
      [plan.id],
    );
    items = rows;
  }

  const ics = buildPatientFeed({
    calendarName: user.display_name ? `Carryover — ${user.display_name}` : "Carryover",
    planId: plan?.id ?? null,
    anchorDay: plan?.approved_on ?? null,
    items,
  });
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="carryover.ics"',
      "Cache-Control": "private, max-age=3600",
    },
  });
}
