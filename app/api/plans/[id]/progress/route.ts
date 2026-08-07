// POST /api/plans/:id/progress — swap ONE item for its charted successor (or
// predecessor) and make that the active plan. The five-second half of a
// check-in: no AI, no intake, no draft-then-approve ceremony.
//
// It is still a plan REVISION, not an edit. Approved plans are immutable
// (doctrine #1 — the approved record is what the patient saw), so this mints a
// new plan, copies every other item across unchanged, and retires the old one.
// The PT pressing the button IS the approval: they picked the exercise, they
// saw the dosage, and it reaches the patient immediately.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { resolveEdge } from "@/lib/review/progressions";
import { recordReview, resolveOpenRequest } from "@/lib/review/record";
import { reviewContext, reviewSignals } from "@/lib/review/signals";

type Body = { planItemId?: string; toExerciseId?: string; note?: string };

type ItemRow = {
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
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.planItemId || !body?.toExerciseId) {
    return NextResponse.json({ error: "planItemId and toExerciseId required" }, { status: 400 });
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
    return NextResponse.json(
      { error: "only the active plan can be progressed" },
      { status: 409 },
    );
  }

  // Server-verified: the edge has to exist in the chain, the target has to be
  // visible to this clinic, and it must not already be in the plan. Trusting
  // the pair from the body would let a caller name any exercise in the library
  // as a "successor" and skip the chain entirely.
  const edge = await resolveEdge(
    pool,
    body.planItemId,
    body.toExerciseId,
    plan.id,
    episode.patientUserId,
    episode.clinicId,
  );
  if (!edge) {
    return NextResponse.json(
      { error: "that isn't a charted step from this exercise" },
      { status: 400 },
    );
  }

  const { rows: items } = await pool.query<ItemRow>(
    `SELECT pi.id, pi.exercise_id, pi.sets, pi.reps, pi.hold_secs, pi.duration_mins,
            pi.intensity, pi.frequency_per_week, pi.location, pi.rationale,
            pi.care_timing, pi.sort, e.dosage_type
     FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
     WHERE pi.plan_id = $1 ORDER BY pi.sort`,
    [plan.id],
  );

  const context = reviewContext((await reviewSignals(pool, [plan.episode_id])).get(plan.episode_id));
  const note = body.note?.trim().slice(0, 500) || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [next],
    } = await client.query<{ id: string }>(
      // equipment_suggestions ride along: the patient's "worth getting" hint
      // shouldn't vanish because one exercise stepped up a chain. ai_note
      // stays behind — it described the draft it was written for.
      `INSERT INTO plans (episode_id, status, source, created_by, supersedes_plan_id,
                          equipment_suggestions)
       VALUES ($1, 'draft', 'progression', $2, $3,
               (SELECT equipment_suggestions FROM plans WHERE id = $3))
       RETURNING id`,
      [plan.episode_id, user.id, plan.id],
    );

    for (const it of items) {
      const swapped = it.id === edge.planItemId;
      // Dosage only carries across when it still means the same thing. A
      // seated hold becoming a timed bike keeps neither its sets nor its
      // seconds, and the patient's logger renders from that same type.
      const sameShape = !swapped || it.dosage_type === edge.dosageType;
      const type = swapped ? edge.dosageType : it.dosage_type;
      // A successor needing equipment this patient doesn't own can't be sent
      // home just because its predecessor could be.
      const location =
        swapped && it.location !== "office" && !edge.homeEligible ? "office" : it.location;

      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
            frequency_per_week, location, rationale, care_timing, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          next.id,
          swapped ? edge.toExerciseId : it.exercise_id,
          type === "time" ? null : sameShape ? it.sets : 3,
          type === "reps" ? (sameShape ? it.reps : 10) : null,
          type === "hold" ? (sameShape ? it.hold_secs : 20) : null,
          type === "time" ? (sameShape ? it.duration_mins : 10) : null,
          type === "time" ? (sameShape ? it.intensity : null) : null,
          it.frequency_per_week,
          location,
          // The old rationale described the old exercise — carrying it over
          // would tell the patient why they're doing something they no longer
          // are. The PT's note replaces it, or it goes blank.
          swapped ? note : it.rationale,
          // Timing described the old care too; chain edges land on exercises,
          // so a swapped item's timing doesn't survive the swap.
          swapped ? null : it.care_timing,
          it.sort,
        ],
      );
    }

    await client.query(
      `UPDATE plans SET status = 'retired', retired_at = now() WHERE id = $1`,
      [plan.id],
    );
    await client.query(
      `UPDATE plans SET status = 'active', approved_by = $2, approved_at = now()
       WHERE id = $1`,
      [next.id, user.id],
    );
    await recordReview(client, {
      episodeId: plan.episode_id,
      reviewedBy: user.id,
      outcome: edge.direction === "up" ? "progressed" : "regressed",
      planId: next.id,
      // Which way along the chain, spelled out: "A → B" alone reads as a
      // progression whichever direction it was, and this is a clinical record.
      note:
        `${edge.direction === "up" ? "Progressed" : "Eased off"}: ` +
        `${edge.fromName} → ${edge.toName}${note ? ` — ${note}` : ""}`,
      context,
    });
    await resolveOpenRequest(client, plan.episode_id, user.id);
    await client.query("COMMIT");

    return NextResponse.json({
      planId: next.id,
      from: edge.fromName,
      to: edge.toName,
      direction: edge.direction,
      demotedToOffice: wasDemoted(items, edge),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Did the swap have to move the item out of the patient's home program? The
 *  PT needs telling — it changes what shows up on the patient's Today screen. */
function wasDemoted(
  items: ItemRow[],
  edge: { planItemId: string; homeEligible: boolean },
): boolean {
  const it = items.find((i) => i.id === edge.planItemId);
  return !!it && it.location !== "office" && !edge.homeEligible;
}
