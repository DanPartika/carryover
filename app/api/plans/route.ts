// POST /api/plans — create a plan for an episode, either drafted by AI or empty
// for manual building (source: "manual"). Draft status until a PT approves.
// Treatment-gated.
//
// An AI draft comes in two shapes, and the difference is the whole point of
// Dan's ask #2. basis "intake" reads the intake form and proposes a first plan.
// basis "progress" ALSO reads what the patient has done since the current plan
// was approved — the sessions logged, the pain trend, what they wrote, what
// they asked for. Before this existed, "draft a new plan" on a patient six
// weeks in re-read the same intake and proposed the same first plan again.

import { NextRequest, NextResponse } from "next/server";
import { loadAdherence } from "@/lib/adherence/load";
import { draftPlan, planModel, type IntakeForPrompt, type ProgressContext } from "@/lib/ai/plan";
import { factSheet } from "@/lib/ai/summary";
import { requireUser } from "@/lib/auth/identity";
import { episodeForActor } from "@/lib/auth/treatment";
import { getPool } from "@/lib/db/pool";
import { dosageLine } from "@/lib/dosage";
import { requestLabel, type CheckinRequest } from "@/lib/review/due";
import { progressionCandidates } from "@/lib/review/progressions";
import { REVIEW_WINDOW_DAYS } from "@/lib/review/signals";

type Body = {
  episodeId?: string;
  source?: "ai-draft" | "manual";
  basis?: "intake" | "progress";
  /** The PT's steer for a revamp, in their own words. */
  note?: string;
};

type CurrentItem = {
  exerciseId: string;
  name: string;
  dosageType: "reps" | "hold" | "time";
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number;
  location: string;
};

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }
  const episode = await episodeForActor(pool, body.episodeId, user.id);
  if (!episode) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const source = body.source === "manual" ? "manual" : "ai-draft";

  let items: Awaited<ReturnType<typeof draftPlan>>["items"] = [];
  let model: string | null = null;
  let mode = "fixture";
  let dropped = 0;
  let kind = "plan-draft";

  if (source === "ai-draft") {
    const {
      rows: [intake],
    } = await pool.query<IntakeForPrompt & { id: string }>(
      `SELECT id, condition, body_regions, onset_date::text AS onset_date,
              pain_now, pain_worst, goals, restrictions, narrative
       FROM intakes WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [episode.id],
    );

    const {
      rows: [activePlan],
    } = await pool.query<{ id: string; approvedOn: string }>(
      `SELECT id, approved_at::date::text AS "approvedOn"
       FROM plans WHERE episode_id = $1 AND status = 'active'`,
      [episode.id],
    );

    // A revamp with nothing to revamp is a first draft, whatever was asked for.
    const revamp = body.basis === "progress" && !!activePlan;
    if (!revamp && !intake) {
      return NextResponse.json(
        { error: "complete an intake before drafting with AI" },
        { status: 400 },
      );
    }

    let progress: ProgressContext | undefined;
    let promptIntake = intake as IntakeForPrompt | undefined;

    if (revamp) {
      const { rows: current } = await pool.query<CurrentItem>(
        `SELECT pi.exercise_id AS "exerciseId", e.name, e.dosage_type AS "dosageType",
                pi.sets, pi.reps, pi.hold_secs AS "holdSecs",
                pi.duration_mins AS "durationMins", pi.intensity,
                pi.frequency_per_week AS "frequencyPerWeek", pi.location
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_id = $1 ORDER BY pi.sort, e.name`,
        [activePlan.id],
      );

      // A manually built plan can exist with no intake behind it. Rather than
      // refuse the revamp, stand one up from what the episode does know — the
      // condition, and the regions the current plan is already working.
      if (!promptIntake) {
        const {
          rows: [ep],
        } = await pool.query<{ condition: string; regions: string[] }>(
          `SELECT ep.condition,
                  COALESCE((
                    SELECT array_agg(DISTINCT s.r) FROM (
                      SELECT unnest(e.body_regions) AS r
                      FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
                      WHERE pi.plan_id = $2
                    ) s
                  ), '{}') AS regions
           FROM episodes ep WHERE ep.id = $1`,
          [episode.id, activePlan.id],
        );
        promptIntake = {
          condition: ep?.condition ?? "ongoing episode of care",
          body_regions: ep?.regions ?? [],
          onset_date: null,
          pain_now: null,
          pain_worst: null,
          goals: null,
          restrictions: null,
          narrative: null,
        };
      }

      const view = await loadAdherence(pool, episode.id, REVIEW_WINDOW_DAYS);
      const {
        rows: [request],
      } = await pool.query<CheckinRequest>(
        `SELECT kind, note, created_at::date::text AS "on"
         FROM checkin_requests WHERE episode_id = $1 AND resolved_at IS NULL`,
        [episode.id],
      );
      const chain = await progressionCandidates(
        pool,
        activePlan.id,
        episode.patientUserId,
        episode.clinicId,
      );

      progress = {
        daysOnPlan: view.plan
          ? Math.round(
              (Date.parse(view.today) - Date.parse(view.plan.approvedOn)) / 86_400_000,
            )
          : 0,
        // The same formatter the PT's on-screen AI summary uses, so the draft
        // and the paragraph above it read the identical numbers.
        facts: factSheet({
          condition: promptIntake.condition,
          windowDays: view.windowDays,
          compliance: view.compliance,
          pain: view.pain,
          flags: view.flags,
          visits: view.visits,
          adhoc: view.adhoc,
        }),
        current: current.map((c) => ({
          exerciseId: c.exerciseId,
          name: c.name,
          line: `${dosageLine(c)} · ${c.location}`,
        })),
        request: request ? { label: requestLabel(request.kind), note: request.note } : null,
        ptNote: body.note?.trim().slice(0, 500) || null,
        progressions: chain.map((c) => ({
          fromId: c.fromExerciseId,
          fromName: c.fromName,
          toId: c.toExerciseId,
          toName: c.toName,
          direction: c.direction,
        })),
      };
      kind = "plan-revamp";
    }

    if (!promptIntake) {
      return NextResponse.json({ error: "nothing to draft from" }, { status: 400 });
    }

    const started = Date.now();
    try {
      const result = await draftPlan({
        pool,
        intake: promptIntake,
        patientUserId: episode.patientUserId,
        clinicId: episode.clinicId,
        jwt: user.token,
        progress,
      });
      items = result.items;
      model = result.model;
      mode = result.mode;
      dropped = result.droppedItems;
      if (items.length === 0) {
        // All items dropped by grounding validation (or the model proposed
        // none) — an empty "AI draft" is a failure, not a plan.
        await pool.query(
          `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, dropped_items, error)
           VALUES ($1, $6, $2, $3, 'error', $4, $5, 'empty draft after validation')`,
          [user.id, mode, model, Date.now() - started, dropped, kind],
        );
        return NextResponse.json({ error: "draft came back empty — try again" }, { status: 502 });
      }
      await pool.query(
        `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, dropped_items)
         VALUES ($1, $6, $2, $3, 'ok', $4, $5)`,
        [user.id, mode, model, Date.now() - started, dropped, kind],
      );
    } catch (err) {
      const errMode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
      await pool.query(
        `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
         VALUES ($1, $6, $2, $3, 'error', $4, $5)`,
        [
          user.id,
          errMode,
          errMode === "lithe" ? planModel() : null,
          Date.now() - started,
          String((err as Error).message).slice(0, 500),
          kind,
        ],
      );
      return NextResponse.json({ error: "draft failed — try again" }, { status: 502 });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [plan],
    } = await client.query<{ id: string }>(
      `INSERT INTO plans (episode_id, status, source, model, created_by)
       VALUES ($1, 'draft', $2, $3, $4) RETURNING id`,
      [episode.id, source, model, user.id],
    );
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO plan_items
           (plan_id, exercise_id, sets, reps, hold_secs, duration_mins, intensity,
            frequency_per_week, location, rationale, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          plan.id,
          it.exercise_id,
          it.sets,
          it.reps,
          it.hold_secs,
          it.duration_mins,
          it.intensity,
          it.frequency_per_week,
          it.location,
          it.rationale,
          i,
        ],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json(
      { planId: plan.id, itemCount: items.length, mode, model, droppedItems: dropped, kind },
      { status: 201 },
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
