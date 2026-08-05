// AI plan drafting (PRD §2 AI surface). Two modes behind one seam, selected by
// CARRYOVER_AI_MODE: 'fixture' (deterministic heuristic — offline dev, tests,
// demos without spend) and 'lithe' (the platform /v1/ai gateway via the
// official Anthropic SDK, forwarding the signed-in PT's JWT — no direct
// Anthropic path exists, PRD §1 decision 3).
//
// Grounding guarantee (doctrine #1): the model may ONLY pick exercise ids from
// the library slice we send; validation drops anything else and the drop count
// is logged to ai_call_log. Home/both items must be doable with the patient's
// equipment — violations are demoted to office rather than dropped.

import type { Pool } from "pg";

export type SliceExercise = {
  id: string;
  name: string;
  source: string;
  difficulty: number | null;
  position: string | null;
  body_regions: string[];
  equipment: string[];
  home_eligible: boolean;
  dosage_type: "reps" | "hold" | "time";
  kind: "exercise" | "modality";
};

export type IntakeForPrompt = {
  condition: string;
  body_regions: string[];
  onset_date: string | null;
  pain_now: number | null;
  pain_worst: number | null;
  goals: string | null;
  restrictions: string | null;
  narrative: string | null;
};

export type DraftItem = {
  exercise_id: string;
  sets: number | null;
  reps: number | null;
  hold_secs: number | null;
  duration_mins: number | null;
  intensity: string | null;
  frequency_per_week: number;
  location: "office" | "home" | "both";
  rationale: string;
};

export type DraftResult = {
  items: DraftItem[];
  mode: "fixture" | "lithe";
  model: string | null;
  droppedItems: number;
};

/** What a revamp draft gets that a first draft can't have: six weeks of
 *  evidence (Dan's ask #2). Before this, "draft a new plan" re-read the intake
 *  and proposed a first plan again — a revision that can't see what the patient
 *  actually did is just a first draft with a later timestamp. */
export type ProgressContext = {
  daysOnPlan: number;
  /** The same fact sheet the PT's AI summary is written from. One formatter,
   *  so the paragraph on the dashboard and the draft below it can never
   *  describe different numbers. */
  facts: string;
  /** The plan being revised, so the model can carry an item forward by id. */
  current: { exerciseId: string; name: string; line: string }[];
  /** The patient's own words, when they asked for this. */
  request: { label: string; note: string | null } | null;
  /** What the PT typed when they started the revamp, if anything. */
  ptNote: string | null;
  progressions: {
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    direction: "up" | "down";
  }[];
};

// Household items every home is assumed to have; everything else must be in
// the patient's equipment inventory to count as home-available. Exported so
// the progression swap applies the same test — a successor that needs a band
// the patient doesn't own has to land in the office, not silently at home.
export const HOUSEHOLD_SLUGS = ["none", "wall", "chair", "towel", "step"];

const SLICE_LIMIT = 120;
const MAX_ITEMS = 10;

/** Single source of truth for the draft model — the error-path log in the
 *  plans route must record the same model litheDraft actually called. */
export const DEFAULT_PLAN_MODEL = "claude-sonnet-5";
export function planModel(): string {
  return process.env.CARRYOVER_PLAN_MODEL || DEFAULT_PLAN_MODEL;
}

/** Library slice: rehab-tier exercises matching the intake's body regions,
 *  knee-core first, with home-eligibility computed from the patient's
 *  inventory. Equipment links are alternatives, so ONE available option makes
 *  an exercise home-eligible; zero links means no equipment at all. */
export async function buildLibrarySlice(
  pool: Pool,
  regions: string[],
  patientUserId: string,
  clinicId: string,
  /** Ids that must appear whatever the filters say — the current plan's own
   *  exercises during a revamp. Without this, an item the PT added by hand from
   *  outside the rehab tier would be missing from the slice, the model could
   *  not carry it forward, and validation would silently drop the attempt. */
  alwaysInclude: string[] = [],
): Promise<SliceExercise[]> {
  const { rows } = await pool.query<SliceExercise>(
    `SELECT e.id, e.name, e.source, e.difficulty, e.position, e.body_regions,
            e.dosage_type, e.kind,
            COALESCE(array_agg(ec.name) FILTER (WHERE ec.id IS NOT NULL), '{}') AS equipment,
            (count(ec.id) = 0 OR bool_or(
              ec.slug = ANY($3) OR pe.equipment_id IS NOT NULL
            )) AS home_eligible
     FROM exercises e
     LEFT JOIN exercise_equipment ee ON ee.exercise_id = e.id
     LEFT JOIN equipment_catalog ec ON ec.id = ee.equipment_id
     LEFT JOIN patient_equipment pe
       ON pe.equipment_id = ec.id AND pe.user_id = $2
     WHERE e.archived_at IS NULL
       -- Clinic-authored exercises are private to their clinic until shared.
       AND (e.clinic_id IS NULL OR e.shared OR e.clinic_id = $4)
       AND (
         e.id = ANY($5::uuid[])
         OR (
           e.tier = 'rehab'
           -- Modalities are not region-specific: you ice whatever hurts.
           -- Gating them on body_regions (which is empty for all of them)
           -- would hide every one of them from the draft.
           AND (e.kind = 'modality' OR e.body_regions && $1)
         )
       )
     GROUP BY e.id
     ORDER BY (e.id = ANY($5::uuid[])) DESC, (e.kind = 'modality'),
              (e.source = 'carryover') DESC, e.difficulty NULLS LAST, e.name
     LIMIT ${SLICE_LIMIT}`,
    [regions, patientUserId, HOUSEHOLD_SLUGS, clinicId, alwaysInclude],
  );
  return rows;
}

function clamp(n: unknown, lo: number, hi: number): number | null {
  if (n === null || n === undefined || n === "") return null; // null stays null — 0 must not clamp up to lo
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(v, lo), hi);
}

/** Enforce grounding + home-eligibility on whatever came back (model or
 *  fixture): unknown ids are dropped (counted), numbers clamped to the DB
 *  CHECK ranges, home/both items without workable equipment demoted to office. */
export function validateItems(
  raw: unknown[],
  slice: SliceExercise[],
): { items: DraftItem[]; dropped: number } {
  const byId = new Map(slice.map((e) => [e.id, e]));
  const items: DraftItem[] = [];
  let dropped = 0;
  const seen = new Set<string>();

  for (const entry of raw) {
    if (items.length >= MAX_ITEMS) break;
    const r = entry as Record<string, unknown>;
    const ex = byId.get(String(r.exercise_id));
    if (!ex || seen.has(ex.id)) {
      dropped++;
      continue;
    }
    seen.add(ex.id);
    let location = ["office", "home", "both"].includes(String(r.location))
      ? (String(r.location) as DraftItem["location"])
      : "home";
    if (location !== "office" && !ex.home_eligible) location = "office";

    // Dosage is whatever the exercise's type calls for. A model that returns
    // "3 sets of 15" for a stationary bike is answering the wrong question, so
    // the fields that don't belong to the type are dropped rather than stored
    // — otherwise the patient's logger would render a rep counter for a bike.
    const timed = ex.dosage_type === "time";
    const held = ex.dosage_type === "hold";
    items.push({
      exercise_id: ex.id,
      sets: timed ? null : clamp(r.sets, 1, 10),
      reps: timed || held ? null : clamp(r.reps, 1, 50),
      hold_secs: held ? clamp(r.hold_secs, 1, 300) : null,
      duration_mins: timed ? (clamp(r.duration_mins, 1, 240) ?? 10) : null,
      intensity: timed ? String(r.intensity ?? "").slice(0, 80) || null : null,
      frequency_per_week: clamp(r.frequency_per_week, 1, 14) ?? 5,
      location,
      rationale: String(r.rationale ?? "").slice(0, 500),
    });
  }
  return { items, dropped };
}

/** Deterministic offline draft: conservative difficulty ceiling from pain and
 *  recency, knee-core-first selection, isometric-aware dosage defaults. */
function fixtureDraft(intake: IntakeForPrompt, slice: SliceExercise[]): unknown[] {
  const pain = intake.pain_now ?? 5;
  const daysSince = intake.onset_date
    ? Math.max(0, Math.floor((Date.now() - new Date(intake.onset_date).getTime()) / 86_400_000))
    : 90;
  const ceiling = pain >= 6 || daysSince < 21 ? 2 : pain >= 3 || daysSince < 60 ? 3 : 4;

  return slice
    .filter((e) => (e.difficulty ?? 3) <= ceiling)
    .sort((a, b) =>
      a.source === b.source
        ? (a.difficulty ?? 3) - (b.difficulty ?? 3)
        : a.source === "carryover"
          ? -1
          : 1,
    )
    .slice(0, 8)
    .map((e) => ({
      exercise_id: e.id,
      sets: e.dosage_type === "time" ? null : 3,
      reps: e.dosage_type === "reps" ? 10 : null,
      hold_secs: e.dosage_type === "hold" ? 10 : null,
      duration_mins: e.dosage_type === "time" ? 10 : null,
      intensity: null,
      frequency_per_week: (e.difficulty ?? 3) <= 2 ? 7 : 5,
      location: e.home_eligible ? "both" : "office",
      rationale: `Level ${e.difficulty ?? "?"} ${e.body_regions.join("/") || "general"} work within current pain and recovery stage.`,
    }));
}

/** Deterministic offline revamp: carry forward everything still in the library
 *  slice, then walk any charted "up" edge. Deliberately mechanical — it can't
 *  read the evidence, and a fixture that looked like judgment would invite
 *  mistaking an offline demo for a real call. */
function fixtureRevamp(
  progress: ProgressContext,
  intake: IntakeForPrompt,
  slice: SliceExercise[],
): unknown[] {
  const inSlice = new Map(slice.map((e) => [e.id, e]));
  const step = new Map(
    progress.progressions.filter((p) => p.direction === "up").map((p) => [p.fromId, p.toId]),
  );

  const carried: unknown[] = [];
  const used = new Set<string>();
  for (const cur of progress.current) {
    const targetId = step.get(cur.exerciseId) ?? cur.exerciseId;
    const ex = inSlice.get(targetId) ?? inSlice.get(cur.exerciseId);
    if (!ex || used.has(ex.id)) continue;
    used.add(ex.id);
    carried.push({
      exercise_id: ex.id,
      sets: ex.dosage_type === "time" ? null : 3,
      reps: ex.dosage_type === "reps" ? 10 : null,
      hold_secs: ex.dosage_type === "hold" ? 10 : null,
      duration_mins: ex.dosage_type === "time" ? 10 : null,
      intensity: null,
      frequency_per_week: 5,
      location: ex.home_eligible ? "both" : "office",
      rationale:
        ex.id === cur.exerciseId
          ? "Carried forward from the current plan."
          : `Charted next step up from ${cur.name}.`,
    });
  }
  // Nothing from the old plan survives in the slice (regions changed, items
  // archived) — fall back rather than return an empty "revamp".
  return carried.length > 0 ? carried : fixtureDraft(intake, slice);
}

const PLAN_TOOL = {
  name: "propose_plan",
  description: "Propose the exercise plan draft for the PT to review.",
  input_schema: {
    type: "object" as const,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["exercise_id", "frequency_per_week", "location", "rationale"],
          properties: {
            exercise_id: { type: "string", description: "MUST be an id from the LIBRARY list" },
            sets: { type: "integer", description: "dosage_type=reps only" },
            reps: { type: "integer", description: "dosage_type=reps only" },
            hold_secs: { type: "integer", description: "dosage_type=hold only" },
            duration_mins: {
              type: "integer",
              description: "dosage_type=time only — minutes on the bike, under the ice, etc.",
            },
            intensity: {
              type: "string",
              description:
                "dosage_type=time only. Free text in the units that item uses: 'level 2', '2.5 mph', 'low pressure'. Omit if the PT should decide.",
            },
            frequency_per_week: { type: "integer" },
            location: { type: "string", enum: ["office", "home", "both"] },
            rationale: {
              type: "string",
              description:
                "One sentence, patient-readable (shown to the patient after PT approval)",
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You draft exercise-plan PROPOSALS for a licensed physical therapist to review, edit, and approve. You never prescribe: the PT is the decision-maker and nothing you produce reaches a patient without their sign-off.

Rules:
- Select ONLY exercise ids that appear in the LIBRARY list. Never invent ids.
- Propose 6-10 items forming a coherent early plan: activation/range work before loading, bilateral before unilateral.
- Be conservative: respect days since surgery/onset, current pain, and every stated restriction verbatim.
- Items marked home_eligible=false can only be location "office".
- Dosage follows each item's dosage_type, and nothing else: reps -> sets + reps; hold -> sets + hold_secs; time -> duration_mins (+ intensity if you can name a sensible starting setting). Never prescribe sets and reps for a timed item.
- MODALITY items (ice, heat, TENS, compression, elevation) are care, not exercise. Include them only when the stage of recovery genuinely calls for one; they are always dosage_type=time. Do not pad a plan with them.
- Daily frequency only for gentle early-phase work.
- Each rationale is ONE plain-English sentence a patient can understand.`;

const REVAMP_SYSTEM_PROMPT = `You draft REVISED exercise-plan proposals for a licensed physical therapist to review, edit, and approve. The patient already has an approved plan and has been working it; you are proposing what the next phase should be. You never prescribe: the PT decides, and nothing you produce reaches a patient without their sign-off.

Rules:
- Select ONLY exercise ids that appear in the LIBRARY list. Never invent ids.
- This is a REVISION, not a fresh start. An item in the current plan that is being done and tolerated should usually carry forward; say so in its rationale.
- Read the DIRECTION from the evidence rather than assuming one. Sessions being done and pain settling is a case for more. Sessions going undone, pain climbing, or a patient saying it is too much is a case for LESS — fewer items, lighter dosage, or a step back down the chain. A revision is not automatically a harder plan.
- CHARTED PROGRESSIONS are this clinic's own successor and predecessor pairs. When one fits the direction the evidence points, prefer it over an unrelated exercise of similar difficulty.
- An item that was never logged once has already told you something. Propose replacing it or dropping it rather than repeating it unchanged.
- Propose 6-10 items total. Items marked home_eligible=false can only be location "office".
- Dosage follows each item's dosage_type, and nothing else: reps -> sets + reps; hold -> sets + hold_secs; time -> duration_mins (+ intensity). Never prescribe sets and reps for a timed item.
- MODALITY items (ice, heat, TENS, compression, elevation) are care, not exercise. Carry one forward or add one only when the stage of recovery calls for it.
- Each rationale is ONE plain-English sentence a patient can understand.
- Do not diagnose, and do not comment on prognosis or on whether the patient is doing well. Propose the plan; the PT reads the evidence themselves.`;

function progressSection(progress: ProgressContext): string {
  const lines: string[] = [];
  lines.push(`PROGRESS SO FAR (${progress.daysOnPlan} days on the current plan)`);
  lines.push(progress.facts);
  lines.push("");
  lines.push("CURRENT PLAN (exercise_id | name | prescribed)");
  for (const c of progress.current) {
    lines.push(`${c.exerciseId} | ${c.name} | ${c.line}`);
  }
  if (progress.progressions.length > 0) {
    lines.push("");
    lines.push("CHARTED PROGRESSIONS off items in the current plan (direction | from -> to | id)");
    for (const p of progress.progressions) {
      lines.push(`${p.direction} | ${p.fromName} -> ${p.toName} | ${p.toId}`);
    }
  }
  if (progress.request) {
    lines.push("");
    lines.push(
      `THE PATIENT ASKED FOR THIS CHECK-IN: "${progress.request.label}"` +
        (progress.request.note ? ` — they wrote: "${progress.request.note}"` : ""),
    );
  }
  if (progress.ptNote) {
    lines.push("");
    lines.push(`THE PT'S STEER FOR THIS REVISION: "${progress.ptNote}"`);
  }
  return lines.join("\n");
}

async function litheDraft(
  intake: IntakeForPrompt,
  equipmentNames: string[],
  slice: SliceExercise[],
  jwt: string,
  progress?: ProgressContext,
): Promise<{ raw: unknown[]; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const coreUrl = (
    process.env.LITHE_CORE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
    "http://localhost:8081"
  ).replace(/\/+$/, "");
  const model = planModel();

  const client = new Anthropic({ baseURL: `${coreUrl}/v1/ai`, authToken: jwt, apiKey: null });

  const libraryLines = slice
    .map(
      (e) =>
        `${e.id} | ${e.name} | ${e.kind} | dosage_type=${e.dosage_type} | difficulty ${e.difficulty ?? "?"}/5 | ${e.position ?? "-"} | ${e.body_regions.join(",")} | equipment: ${e.equipment.join("+") || "none"} | home_eligible=${e.home_eligible}`,
    )
    .join("\n");

  const user = `${progress ? `${progressSection(progress)}\n\n` : ""}INTAKE
Condition: ${intake.condition}
Body regions: ${intake.body_regions.join(", ")}
Surgery/onset date: ${intake.onset_date ?? "not given"}
Pain now: ${intake.pain_now ?? "?"}/10 · worst: ${intake.pain_worst ?? "?"}/10
Goals: ${intake.goals || "not given"}
Restrictions/precautions: ${intake.restrictions || "none stated"}
Narrative: ${intake.narrative || "none"}

PATIENT HOME EQUIPMENT: ${equipmentNames.join(", ") || "none recorded"} (plus assumed household: wall, chair, towel, a step)

LIBRARY (id | name | kind | dosage_type | difficulty | position | regions | equipment | home_eligible)
${libraryLines}

${progress ? "Propose the REVISED plan via the propose_plan tool." : "Propose the plan via the propose_plan tool."}`;

  const res = await client.messages.create({
    model,
    // Headroom over the tool JSON — adaptive thinking shares this budget.
    max_tokens: 8192,
    system: progress ? REVAMP_SYSTEM_PROMPT : SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
    tools: [PLAN_TOOL],
    tool_choice: { type: "tool", name: "propose_plan" },
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    // Truncation, refusal, or schema-violating output — fail loudly so the
    // route logs an error instead of minting a silent empty draft.
    throw new Error(`no tool_use block in response (stop_reason: ${res.stop_reason})`);
  }
  const items = (toolUse.input as { items?: unknown }).items;
  const raw = Array.isArray(items) ? items : [];
  return { raw, model };
}

export async function draftPlan(args: {
  pool: Pool;
  intake: IntakeForPrompt;
  patientUserId: string;
  clinicId: string;
  jwt: string;
  /** Present for a revamp: what the patient has actually done since the
   *  current plan was approved. Absent for a first draft. */
  progress?: ProgressContext;
}): Promise<DraftResult> {
  const { pool, intake, patientUserId, clinicId, jwt, progress } = args;
  const regions = intake.body_regions.length ? intake.body_regions : ["knee"];
  const slice = await buildLibrarySlice(
    pool,
    regions,
    patientUserId,
    clinicId,
    progress?.current.map((c) => c.exerciseId) ?? [],
  );

  const { rows: eq } = await pool.query<{ name: string }>(
    `SELECT ec.name FROM patient_equipment pe
     JOIN equipment_catalog ec ON ec.id = pe.equipment_id
     WHERE pe.user_id = $1 ORDER BY ec.name`,
    [patientUserId],
  );
  const equipmentNames = eq.map((r) => r.name);

  const mode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
  let raw: unknown[];
  let model: string | null = null;
  if (mode === "lithe") {
    const out = await litheDraft(intake, equipmentNames, slice, jwt, progress);
    raw = out.raw;
    model = out.model;
  } else {
    raw = progress ? fixtureRevamp(progress, intake, slice) : fixtureDraft(intake, slice);
  }

  const { items, dropped } = validateItems(raw, slice);
  return { items, mode, model, droppedItems: dropped };
}
