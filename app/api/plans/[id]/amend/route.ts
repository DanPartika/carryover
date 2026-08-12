// POST /api/plans/:id/amend — add ONE exercise to the active plan by hand.
// The other five-second door beside /progress: no AI, no re-intake, no
// draft-then-approve ceremony. The PT picked the exercise and typed the
// dosage — that IS the approval, and it reaches the patient immediately.
//
// Still a plan REVISION, not an edit (doctrine #1 — the approved record is
// what the patient saw): this mints a new plan, copies every item across
// unchanged, appends the new one at the end, and retires the old plan.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { recordReview, resolveOpenRequest } from "@/lib/review/record";
import { reviewContext, reviewSignals } from "@/lib/review/signals";

type Body = {
  exerciseId?: string;
  sets?: number | null;
  reps?: number | null;
  holdSecs?: number | null;
  durationMins?: number | null;
  intensity?: string | null;
  frequencyPerWeek?: number;
  location?: "office" | "home" | "both";
  rationale?: string;
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
  if (!body?.exerciseId) {
    return NextResponse.json({ error: "exerciseId required" }, { status: 400 });
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
  if (plan.status !== "active") {
    return NextResponse.json({ error: "only the active plan can be amended" }, { status: 409 });
  }

  // Same visibility predicate as the library browse and the AI's slice — a
  // clinic's private exercise can't be amended into another clinic's plan.
  const {
    rows: [exercise],
  } = await pool.query<{ id: string; name: string; kind: string; dosage_type: string }>(
    `SELECT id, name, kind, dosage_type FROM exercises
     WHERE id = $1 AND archived_at IS NULL
       AND (clinic_id IS NULL OR shared OR clinic_id = $2)`,
    [body.exerciseId, episode.clinicId],
  );
  if (!exercise) return NextResponse.json({ error: "unknown exercise" }, { status: 400 });

  const { rows: items } = await pool.query<{
    id: string;
    exercise_id: string;
    sets: number | null;
    reps: number | null;
    hold_secs: number | null;
    duration_mins: number | null;
    intensity: string | null;
    frequency_per_week: number;
    location: string;
    rationale: string | null;
    care_timing: string | null;
    sort: number;
  }>(
    `SELECT id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
            frequency_per_week, location, rationale, care_timing, sort
     FROM plan_items WHERE plan_id = $1 ORDER BY sort`,
    [plan.id],
  );
  if (items.some((it) => it.exercise_id === exercise.id)) {
    return NextResponse.json({ error: "already in the plan" }, { status: 409 });
  }
  if (items.length >= 30) {
    return NextResponse.json({ error: "plan is at its 30-item limit" }, { status: 400 });
  }

  // Dosage lands in the columns its type means, exactly like the draft editor
  // — posting reps for a bike would store a number no dashboard can read.
  const type = exercise.dosage_type;
  const rationale = String(body.rationale ?? "").slice(0, 500) || null;
  const context = reviewContext(
    (await reviewSignals(pool, [plan.episode_id])).get(plan.episode_id),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [next],
    } = await client.query<{ id: string }>(
      // equipment_suggestions ride along, same as a progression — the
      // patient's "worth getting" hint shouldn't vanish because the PT added
      // an exercise. ai_note stays behind: it described the draft it was
      // written for.
      `INSERT INTO plans (episode_id, status, source, created_by, supersedes_plan_id,
                          equipment_suggestions)
       VALUES ($1, 'draft', 'amendment', $2, $3,
               (SELECT equipment_suggestions FROM plans WHERE id = $3))
       RETURNING id`,
      [plan.episode_id, user.id, plan.id],
    );

    for (const it of items) {
      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
            frequency_per_week, location, rationale, care_timing, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          next.id,
          it.exercise_id,
          it.sets,
          it.reps,
          it.hold_secs,
          it.duration_mins,
          it.intensity,
          it.frequency_per_week,
          it.location,
          it.rationale,
          it.care_timing,
          it.sort,
        ],
      );
    }

    await client.query(
      `INSERT INTO plan_items
         (plan_id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
          frequency_per_week, location, rationale, care_timing, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        next.id,
        exercise.id,
        type === "time" ? null : (clampOrNull(body.sets, 1, 10) ?? 3),
        type === "reps" ? (clampOrNull(body.reps, 1, 50) ?? 10) : null,
        type === "hold" ? (clampOrNull(body.holdSecs, 1, 300) ?? 20) : null,
        type === "time" ? (clampOrNull(body.durationMins, 1, 240) ?? 10) : null,
        type === "time" ? body.intensity?.trim().slice(0, 80) || null : null,
        clampOrNull(body.frequencyPerWeek, 1, 14) ?? (exercise.kind === "modality" ? 7 : 5),
        ["office", "home", "both"].includes(String(body.location)) ? body.location : "home",
        rationale,
        // Timing is a modality concept — same rule as the draft editor.
        exercise.kind === "modality" &&
        (body.careTiming === "before" || body.careTiming === "after")
          ? body.careTiming
          : null,
        items.length === 0 ? 0 : items[items.length - 1].sort + 1,
      ],
    );

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
      [next.id, user.id],
    );
    await recordReview(client, {
      episodeId: plan.episode_id,
      reviewedBy: user.id,
      outcome: "amended",
      planId: next.id,
      note: `Added: ${exercise.name}${rationale ? ` — ${rationale}` : ""}`,
      context,
    });
    await resolveOpenRequest(client, plan.episode_id, user.id);
    await client.query("COMMIT");

    return NextResponse.json({ planId: next.id, added: exercise.name });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
