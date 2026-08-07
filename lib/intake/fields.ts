// The intake vocabulary — one source for the PT form, the patient pre-visit
// form, both API routes, and the AI prompt. The DB deliberately CHECKs only
// the single-value enums; the slug arrays (conditions, red flags) are
// validated here, same pattern as body_regions since 0004: growing the
// vocabulary is a TS edit, not a migration.

export const REGION_OPTIONS = [
  ["knee", "Knee"],
  ["hip", "Hip"],
  ["ankle_foot", "Ankle/foot"],
  ["spine", "Spine"],
  ["core", "Core"],
  ["shoulder", "Shoulder"],
  ["elbow", "Elbow"],
  ["wrist_hand", "Wrist/hand"],
  ["neck", "Neck"],
  ["full_body", "Full body"],
] as const;

export const SIDE_OPTIONS = [
  ["left", "Left"],
  ["right", "Right"],
  ["both", "Both"],
  ["na", "Not one-sided"],
] as const;

export const ONSET_KIND_OPTIONS = [
  ["gradual", "Came on gradually"],
  ["sudden", "Started suddenly"],
  ["injury", "From an injury"],
  ["surgery", "After surgery"],
] as const;

export const TRAJECTORY_OPTIONS = [
  ["improving", "Getting better"],
  ["worsening", "Getting worse"],
  ["unchanged", "About the same"],
] as const;

export const PAIN_PATTERN_OPTIONS = [
  ["constant", "Constant"],
  ["intermittent", "Comes and goes"],
  ["with_motion", "Only with certain movements"],
] as const;

export const WORST_TIME_OPTIONS = [
  ["morning", "Morning"],
  ["midday", "Midday"],
  ["evening", "Evening"],
  ["night", "At night"],
  ["varies", "It varies"],
] as const;

// Medical-history checkboxes — the system-grouped screen every real intake
// packet carries. Phrasing is patient-facing; the PT sees the same labels.
export const CONDITION_OPTIONS = [
  ["heart_condition", "Heart condition"],
  ["high_blood_pressure", "High blood pressure"],
  ["diabetes", "Diabetes"],
  ["cancer_history", "Cancer (past or present)"],
  ["osteoporosis", "Osteoporosis"],
  ["arthritis", "Arthritis"],
  ["blood_clots", "Blood clots / DVT"],
  ["stroke", "Stroke or TIA"],
  ["respiratory", "Asthma / COPD"],
  ["neuropathy", "Nerve problems / neuropathy"],
  ["pregnancy", "Pregnancy"],
  ["anxiety_depression", "Anxiety or depression"],
] as const;

// Red-flag screen. These don't diagnose anything here — a checked box makes
// the PT's intake summary wave, because in a real clinic these are the
// answers that route a patient OUT of exercise and toward a conversation.
export const RED_FLAG_OPTIONS = [
  ["weight_loss", "Unexplained weight loss"],
  ["night_pain_constant", "Night pain that doesn't ease with position"],
  ["chest_pain", "Chest pain or pressure"],
  ["breathless", "Unusual shortness of breath"],
  ["dizziness", "Dizziness or fainting"],
  ["fever", "Fever or night sweats"],
  ["bowel_bladder", "New bowel or bladder problems"],
  ["saddle_numbness", "Numbness in the groin / saddle area"],
  ["progressive_weakness", "Weakness that keeps getting worse"],
  ["recent_trauma", "A recent fall or accident"],
] as const;

export function labelFor(
  options: ReadonlyArray<readonly [string, string]>,
  slug: string,
): string {
  return options.find(([v]) => v === slug)?.[1] ?? slug;
}

const REGION_SET = new Set<string>(REGION_OPTIONS.map(([v]) => v));
const CONDITION_SET = new Set<string>(CONDITION_OPTIONS.map(([v]) => v));
const RED_FLAG_SET = new Set<string>(RED_FLAG_OPTIONS.map(([v]) => v));

/** Up to 3 activities the patient can't do, each rated 0-10 (PSFS-shaped).
 *  These are the numbered goals every later progress report compares. */
export type LimitedActivity = { activity: string; rating: number };

export const MAX_LIMITED_ACTIVITIES = 3;

export function parseLimitedActivities(v: unknown): LimitedActivity[] | null {
  if (!Array.isArray(v)) return null;
  const out: LimitedActivity[] = [];
  for (const raw of v) {
    if (out.length >= MAX_LIMITED_ACTIVITIES) break;
    const activity =
      typeof (raw as { activity?: unknown })?.activity === "string"
        ? (raw as { activity: string }).activity.trim().slice(0, 120)
        : "";
    if (!activity) continue;
    const n = Math.round(Number((raw as { rating?: unknown }).rating));
    if (!Number.isFinite(n) || n < 0 || n > 10) continue;
    out.push({ activity, rating: n });
  }
  return out.length ? out : null;
}

function intOrNull(v: unknown, lo: number, hi: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

function textOrNull(v: unknown, max = 2000): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function oneOf(v: unknown, options: ReadonlyArray<readonly [string, string]>): string | null {
  return typeof v === "string" && options.some(([s]) => s === v) ? v : null;
}

function slugs(v: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((s): s is string => typeof s === "string" && allowed.has(s)))];
}

/** Everything an intake body can carry beyond condition/authorship, normalized
 *  to what the columns accept. Shared verbatim by the PT route and the
 *  patient's self-intake route so the two can never drift. */
export type IntakeFields = ReturnType<typeof parseIntakeFields>;

export function parseIntakeFields(body: Record<string, unknown>) {
  return {
    bodyRegions: slugs(body.bodyRegions, REGION_SET),
    onsetDate:
      typeof body.onsetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.onsetDate)
        ? body.onsetDate
        : null,
    side: oneOf(body.side, SIDE_OPTIONS),
    onsetKind: oneOf(body.onsetKind, ONSET_KIND_OPTIONS),
    trajectory: oneOf(body.trajectory, TRAJECTORY_OPTIONS),
    hadBefore: boolOrNull(body.hadBefore),
    mechanism: textOrNull(body.mechanism),
    painNow: intOrNull(body.painNow, 0, 10),
    painWorst: intOrNull(body.painWorst, 0, 10),
    painAvg: intOrNull(body.painAvg, 0, 10),
    painPattern: oneOf(body.painPattern, PAIN_PATTERN_OPTIONS),
    aggravators: textOrNull(body.aggravators),
    easers: textOrNull(body.easers),
    nightPain: boolOrNull(body.nightPain),
    worstTime: oneOf(body.worstTime, WORST_TIME_OPTIONS),
    limitedActivities: parseLimitedActivities(body.limitedActivities),
    assistiveDevice: textOrNull(body.assistiveDevice, 200),
    conditions: slugs(body.conditions, CONDITION_SET),
    redFlags: slugs(body.redFlags, RED_FLAG_SET),
    medications: textOrNull(body.medications),
    surgeries: textOrNull(body.surgeries),
    imaging: textOrNull(body.imaging),
    priorTreatment: textOrNull(body.priorTreatment),
    occupation: textOrNull(body.occupation, 200),
    activityLevel: textOrNull(body.activityLevel, 500),
    goals: textOrNull(body.goals),
    restrictions: textOrNull(body.restrictions),
    narrative: textOrNull(body.narrative),
    birthYear: intOrNull(body.birthYear, 1900, 2100),
  };
}

/** The INSERT shared by both intake routes. Returns the new intake id.
 *  `restrictions` is PT territory — the patient route passes null for it. */
export const INTAKE_INSERT_SQL = `
  INSERT INTO intakes
    (episode_id, author_user_id, condition, body_regions, onset_date,
     side, onset_kind, trajectory, had_before, mechanism,
     pain_now, pain_worst, pain_avg, pain_pattern, aggravators, easers,
     night_pain, worst_time, limited_activities, assistive_device,
     conditions, red_flags, medications, surgeries, imaging, prior_treatment,
     occupation, activity_level, goals, restrictions, narrative)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
  RETURNING id`;

export function intakeInsertValues(
  episodeId: string,
  authorUserId: string,
  condition: string,
  f: IntakeFields,
  opts: { restrictions?: string | null } = {},
): unknown[] {
  return [
    episodeId,
    authorUserId,
    condition,
    f.bodyRegions,
    f.onsetDate,
    f.side,
    f.onsetKind,
    f.trajectory,
    f.hadBefore,
    f.mechanism,
    f.painNow,
    f.painWorst,
    f.painAvg,
    f.painPattern,
    f.aggravators,
    f.easers,
    f.nightPain,
    f.worstTime,
    f.limitedActivities ? JSON.stringify(f.limitedActivities) : null,
    f.assistiveDevice,
    f.conditions,
    f.redFlags,
    f.medications,
    f.surgeries,
    f.imaging,
    f.priorTreatment,
    f.occupation,
    f.activityLevel,
    f.goals,
    opts.restrictions !== undefined ? opts.restrictions : f.restrictions,
    f.narrative,
  ];
}

/** An intake row as every reader returns it (INTAKE_SELECT_COLS shape). */
export type IntakeRecord = {
  id: string;
  authorUserId: string;
  condition: string;
  bodyRegions: string[];
  onsetDate: string | null;
  side: string | null;
  onsetKind: string | null;
  trajectory: string | null;
  hadBefore: boolean | null;
  mechanism: string | null;
  painNow: number | null;
  painWorst: number | null;
  painAvg: number | null;
  painPattern: string | null;
  aggravators: string | null;
  easers: string | null;
  nightPain: boolean | null;
  worstTime: string | null;
  limitedActivities: LimitedActivity[] | null;
  assistiveDevice: string | null;
  conditions: string[];
  redFlags: string[];
  medications: string | null;
  surgeries: string | null;
  imaging: string | null;
  priorTreatment: string | null;
  occupation: string | null;
  activityLevel: string | null;
  goals: string | null;
  restrictions: string | null;
  narrative: string | null;
  createdAt: string;
};

/** The SELECT column list every intake reader shares, camelCased. */
export const INTAKE_SELECT_COLS = `
  i.id, i.author_user_id AS "authorUserId", i.condition,
  i.body_regions AS "bodyRegions", i.onset_date::text AS "onsetDate",
  i.side, i.onset_kind AS "onsetKind", i.trajectory,
  i.had_before AS "hadBefore", i.mechanism,
  i.pain_now AS "painNow", i.pain_worst AS "painWorst", i.pain_avg AS "painAvg",
  i.pain_pattern AS "painPattern", i.aggravators, i.easers,
  i.night_pain AS "nightPain", i.worst_time AS "worstTime",
  i.limited_activities AS "limitedActivities", i.assistive_device AS "assistiveDevice",
  i.conditions, i.red_flags AS "redFlags", i.medications, i.surgeries,
  i.imaging, i.prior_treatment AS "priorTreatment",
  i.occupation, i.activity_level AS "activityLevel",
  i.goals, i.restrictions, i.narrative, i.created_at AS "createdAt"`;
