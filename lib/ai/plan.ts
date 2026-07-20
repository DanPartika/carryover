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

// Household items every home is assumed to have; everything else must be in
// the patient's equipment inventory to count as home-available.
const HOUSEHOLD_SLUGS = ["none", "wall", "chair", "towel", "step"];

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
): Promise<SliceExercise[]> {
  const { rows } = await pool.query<SliceExercise>(
    `SELECT e.id, e.name, e.source, e.difficulty, e.position, e.body_regions,
            COALESCE(array_agg(ec.name) FILTER (WHERE ec.id IS NOT NULL), '{}') AS equipment,
            (count(ec.id) = 0 OR bool_or(
              ec.slug = ANY($3) OR pe.equipment_id IS NOT NULL
            )) AS home_eligible
     FROM exercises e
     LEFT JOIN exercise_equipment ee ON ee.exercise_id = e.id
     LEFT JOIN equipment_catalog ec ON ec.id = ee.equipment_id
     LEFT JOIN patient_equipment pe
       ON pe.equipment_id = ec.id AND pe.user_id = $2
     WHERE e.archived_at IS NULL AND e.tier = 'rehab' AND e.body_regions && $1
     GROUP BY e.id
     ORDER BY (e.source = 'carryover') DESC, e.difficulty NULLS LAST, e.name
     LIMIT ${SLICE_LIMIT}`,
    [regions, patientUserId, HOUSEHOLD_SLUGS],
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
    items.push({
      exercise_id: ex.id,
      sets: clamp(r.sets, 1, 10),
      reps: clamp(r.reps, 1, 50),
      hold_secs: clamp(r.hold_secs, 1, 300),
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
    .map((e) => {
      const isometric = /set|sit|plank|hold/i.test(e.name);
      return {
        exercise_id: e.id,
        sets: 3,
        reps: isometric ? null : 10,
        hold_secs: isometric ? 10 : null,
        frequency_per_week: (e.difficulty ?? 3) <= 2 ? 7 : 5,
        location: e.home_eligible ? "both" : "office",
        rationale: `Level ${e.difficulty ?? "?"} ${e.body_regions.join("/")} work within current pain and recovery stage.`,
      };
    });
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
            sets: { type: "integer" },
            reps: { type: "integer", description: "omit for pure isometric holds" },
            hold_secs: { type: "integer", description: "hold duration for isometrics" },
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
- Dosage: isometrics get hold_secs (no reps); everything else gets sets x reps. Daily frequency only for gentle early-phase work.
- Each rationale is ONE plain-English sentence a patient can understand.`;

async function litheDraft(
  intake: IntakeForPrompt,
  equipmentNames: string[],
  slice: SliceExercise[],
  jwt: string,
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
        `${e.id} | ${e.name} | difficulty ${e.difficulty ?? "?"}/5 | ${e.position ?? "-"} | ${e.body_regions.join(",")} | equipment: ${e.equipment.join("+") || "none"} | home_eligible=${e.home_eligible}`,
    )
    .join("\n");

  const user = `INTAKE
Condition: ${intake.condition}
Body regions: ${intake.body_regions.join(", ")}
Surgery/onset date: ${intake.onset_date ?? "not given"}
Pain now: ${intake.pain_now ?? "?"}/10 · worst: ${intake.pain_worst ?? "?"}/10
Goals: ${intake.goals || "not given"}
Restrictions/precautions: ${intake.restrictions || "none stated"}
Narrative: ${intake.narrative || "none"}

PATIENT HOME EQUIPMENT: ${equipmentNames.join(", ") || "none recorded"} (plus assumed household: wall, chair, towel, a step)

LIBRARY (id | name | difficulty | position | regions | equipment | home_eligible)
${libraryLines}

Propose the plan via the propose_plan tool.`;

  const res = await client.messages.create({
    model,
    // Headroom over the tool JSON — adaptive thinking shares this budget.
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
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
  jwt: string;
}): Promise<DraftResult> {
  const { pool, intake, patientUserId, jwt } = args;
  const regions = intake.body_regions.length ? intake.body_regions : ["knee"];
  const slice = await buildLibrarySlice(pool, regions, patientUserId);

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
    const out = await litheDraft(intake, equipmentNames, slice, jwt);
    raw = out.raw;
    model = out.model;
  } else {
    raw = fixtureDraft(intake, slice);
  }

  const { items, dropped } = validateItems(raw, slice);
  return { items, mode, model, droppedItems: dropped };
}
