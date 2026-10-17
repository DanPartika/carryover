// POST /api/plans/:id/adjust — change ONE item of the active plan in place
// (Dan's ask: "when I click into an exercise I should be able to edit it").
// Dosage, frequency, location, timing, rationale — the exercise itself stays;
// swapping is the progression pills' job, adding is /amend's.
//
// Still a plan REVISION (doctrine #1 — the approved record is what the
// patient saw): mints a new plan, copies every item, writes the changed one,
// retires the old plan. The press is the approval.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { dosageText } from "@/lib/dosage";
import { closedEpisodeResponse, lockOpenEpisode } from "@/lib/episodes/guard";
import { recordReview, resolveOpenRequest } from "@/lib/review/record";
import { reviewContext, reviewSignals } from "@/lib/review/signals";

type Body = {
  planItemId?: string;
  sets?: number | null;
  reps?: number | null;
  holdSecs?: number | null;
  durationMins?: number | null;
  intensity?: string | null;
  frequencyPerWeek?: number | null;
  location?: "office" | "home" | "both";
  rationale?: string | null;
  careTiming?: "before" | "after" | null;
};

function clampOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.planItemId) {
    return NextResponse.json({ error: "planItemId required" }, { status: 400 });
  }

  const {
    rows: [plan],
  } = await pool.query<{ id: string; status: string; episode_id: string }>(
    "SELECT id, status, episode_id FROM plans WHERE id = $1",
    [id],
  );
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });
  const episode = await episodeForActor(pool, plan.episode_id, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (episode.closed) return closedEpisodeResponse();
  if (plan.status !== "active") {
    return NextResponse.json({ error: "only the active plan can be adjusted" }, { status: 409 });
  }

  const { rows: items } = await pool.query<{
    id: string;
    exercise_id: string;
    sets: number | null;
    reps: number | null;
    hold_secs: number | null;
    duration_mins: number | null;
    intensity: string | null;
    frequency_per_week: number;
    location: "office" | "home" | "both";
    rationale: string | null;
    care_timing: "before" | "after" | null;
    sort: number;
    dosage_type: "reps" | "hold" | "time";
    kind: string;
    name: string;
  }>(
    `SELECT pi.id, pi.exercise_id, pi.sets, pi.reps, pi.hold_secs, pi.duration_mins,
            pi.intensity, pi.frequency_per_week, pi.location, pi.rationale,
            pi.care_timing, pi.sort, e.dosage_type, e.kind, e.name
     FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
     WHERE pi.plan_id = $1 ORDER BY pi.sort`,
    [plan.id],
  );
  const target = items.find((it) => it.id === body.planItemId);
  if (!target) return NextResponse.json({ error: "that item isn't on this plan" }, { status: 400 });

  // Dosage lands in the columns its type means — same shape rules as the
  // draft editor and /amend. Absent fields keep the current prescription.
  const type = target.dosage_type;
  const next = {
    sets:
      type === "time" ? null : (clampOrNull(body.sets, 1, 10) ?? target.sets),
    reps:
      type === "reps" ? (clampOrNull(body.reps, 1, 50) ?? target.reps) : null,
    holdSecs:
      type === "hold" ? (clampOrNull(body.holdSecs, 1, 300) ?? target.hold_secs) : null,
    durationMins:
      type === "time" ? (clampOrNull(body.durationMins, 1, 240) ?? target.duration_mins) : null,
    intensity:
      type === "time"
        ? body.intensity === undefined
          ? target.intensity
          : body.intensity?.trim().slice(0, 80) || null
        : null,
    frequencyPerWeek: clampOrNull(body.frequencyPerWeek, 1, 14) ?? target.frequency_per_week,
    location: ["office", "home", "both"].includes(String(body.location))
      ? body.location!
      : target.location,
    rationale:
      body.rationale === undefined
        ? target.rationale
        : String(body.rationale ?? "").slice(0, 500) || null,
    careTiming:
      target.kind === "modality"
        ? body.careTiming === undefined
          ? target.care_timing
          : body.careTiming === "before" || body.careTiming === "after"
            ? body.careTiming
            : null
        : null,
  };

  const before = dosageText({
    dosageType: type,
    sets: target.sets,
    reps: target.reps,
    holdSecs: target.hold_secs,
    durationMins: target.duration_mins,
    intensity: target.intensity,
  });
  const after = dosageText({
    dosageType: type,
    sets: next.sets,
    reps: next.reps,
    holdSecs: next.holdSecs,
    durationMins: next.durationMins,
    intensity: next.intensity,
  });
  const deltas = [
    before !== after ? `${before} → ${after}` : null,
    target.frequency_per_week !== next.frequencyPerWeek
      ? `${target.frequency_per_week}/wk → ${next.frequencyPerWeek}/wk`
      : null,
    target.location !== next.location ? `${target.location} → ${next.location}` : null,
  ].filter(Boolean);

  const context = reviewContext(
    (await reviewSignals(pool, [plan.episode_id])).get(plan.episode_id),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockOpenEpisode(client, plan.episode_id))) {
      await client.query("ROLLBACK");
      return closedEpisodeResponse();
    }
    const {
      rows: [nextPlan],
    } = await client.query<{ id: string }>(
      `INSERT INTO plans (episode_id, status, source, created_by, supersedes_plan_id,
                          equipment_suggestions)
       VALUES ($1, 'draft', 'adjustment', $2, $3,
               (SELECT equipment_suggestions FROM plans WHERE id = $3))
       RETURNING id`,
      [plan.episode_id, user.id, plan.id],
    );

    for (const it of items) {
      const isTarget = it.id === target.id;
      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
            frequency_per_week, location, rationale, care_timing, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          nextPlan.id,
          it.exercise_id,
          isTarget ? next.sets : it.sets,
          isTarget ? next.reps : it.reps,
          isTarget ? next.holdSecs : it.hold_secs,
          isTarget ? next.durationMins : it.duration_mins,
          isTarget ? next.intensity : it.intensity,
          isTarget ? next.frequencyPerWeek : it.frequency_per_week,
          isTarget ? next.location : it.location,
          isTarget ? next.rationale : it.rationale,
          isTarget ? next.careTiming : it.care_timing,
          it.sort,
        ],
      );
    }

    // AND status='active' + rowCount is the race guard: two tabs both read
    // "active" before either committed; the loser must abort, not re-retire a
    // retired plan and mint a second active one. The plans_one_active index
    // (0015) is the backstop.
    const { rowCount: retired } = await client.query(
      `UPDATE plans SET status = 'retired', retired_at = now()
       WHERE id = $1 AND status = 'active'`,
      [plan.id],
    );
    if (!retired) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "this plan was just changed elsewhere — reload to see it" },
        { status: 409 },
      );
    }
    await client.query(
      `UPDATE plans SET status = 'active', approved_by = $2, approved_at = now()
       WHERE id = $1`,
      [nextPlan.id, user.id],
    );
    await recordReview(client, {
      episodeId: plan.episode_id,
      reviewedBy: user.id,
      outcome: "adjusted",
      planId: nextPlan.id,
      note: `Adjusted: ${target.name}${deltas.length ? ` — ${deltas.join(" · ")}` : ""}`,
      context,
    });
    await resolveOpenRequest(client, plan.episode_id, user.id);
    await client.query("COMMIT");

    return NextResponse.json({ planId: nextPlan.id, adjusted: target.name });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
