// AI-assisted closing summary (an episode of care ends with a written record).
//
// Same two-mode seam as the plan draft and the adherence summary: 'fixture' for
// offline dev/tests/demos, 'lithe' for the platform /v1/ai gateway with the
// PT's JWT forwarded.
//
// The rules differ from the PT-facing adherence summary in the way that
// matters: THE PATIENT READS THIS. It is drafted for the PT to edit and sign, it
// reaches the patient only when the PT presses Close, and it is written in
// plain language to the patient — while still holding doctrine #3: it states
// what the record shows and never a verdict. Why a number moved, whether goals
// were met, what comes next: those are the PT's to add on top of the draft.
//
// Three layers keep a model from drifting into verdicts, because a prompt alone
// is a request, not a guarantee:
//   1. the facts it writes from are rendered in CODE — neutral, dated,
//      direction already computed ("rose 4"), so it never does sign arithmetic
//      on a scale that runs the other way;
//   2. the output is a forced tool call, so there is no preamble to strip and a
//      refusal fails loudly;
//   3. every draft is screened deterministically (verdict words, formatting,
//      numbers that aren't in the facts) — one retry with the violations
//      quoted, then a plain template. The PT is never left without a draft,
//      and the AI is never a prerequisite for closing.
//
// What the model is NOT given, by design: the patient's name (and the name is
// scrubbed out of the free text it does get), the patient's own notes, PT-private
// notes, plans.ai_note, per-day logs — and PAIN. The pain slider on the patient's
// exercise card starts at 0 and always posts, so an untouched slider logs "no
// pain"; a pain trend stated to the patient as fact would be partly that
// default. The PT sees the pain figure beside the draft, with the caveat, and
// can say what they trust.

import { DEFAULT_PLAN_MODEL } from "@/lib/ai/plan";
import type { ClosingContext, PlanSnapshot } from "@/lib/episodes/closing";

export type ClosingDecision = {
  on: string;
  outcome: "progressed" | "regressed" | "revamped" | "no_change" | "amended" | "adjusted";
  /** The PT's own words, when they wrote any. */
  note: string | null;
};

export type ClosingInput = {
  condition: string;
  /** What the patient and PT said the goals were at intake, in their words. */
  intakeGoals: string | null;
  context: ClosingContext;
  start: PlanSnapshot | null;
  end: PlanSnapshot | null;
  decisions: ClosingDecision[];
  /** The patient's own name parts, so they can be scrubbed out of free text
   *  before it leaves for the model. */
  patientNames: string[];
};

export type ClosingResult = {
  body: string;
  mode: "fixture" | "lithe";
  model: string | null;
  /** True when this is the plain template because the model failed or kept
   *  breaking the rules. The route logs `reason` and the UI says so. */
  fellBack: boolean;
  reason: string | null;
};

/** Patient-readable summaries are worth a stronger model than the PT-only
 *  adherence paragraph; override per deploy with CARRYOVER_CLOSING_MODEL. */
export function closingModel(): string {
  return process.env.CARRYOVER_CLOSING_MODEL || DEFAULT_PLAN_MODEL;
}

// ---------------------------------------------------------------------------
// Facts

const OUTCOME_TEXT: Record<ClosingDecision["outcome"], string> = {
  progressed: "moved one exercise up its progression chain",
  regressed: "moved one exercise back down its progression chain",
  revamped: "approved a new phase of the plan",
  no_change: "reviewed the plan and left it unchanged",
  amended: "added an exercise",
  adjusted: "adjusted one exercise's dosage or setup",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function longDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Replace the patient's known name parts with "the patient". Best-effort — it
 *  can't catch a nickname — but a PT's check-in note is often written TO the
 *  patient by first name, and that name has no business leaving the building. */
export function scrubNames(text: string, names: string[]): string {
  let out = text;
  for (const raw of names) {
    const n = raw.trim();
    if (n.length < 3) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), "the patient");
  }
  return out;
}

function planLines(snap: PlanSnapshot): string[] {
  return snap.items.map((i) => `  - ${i.name}: ${i.line}, ${i.location}`);
}

/** The facts the model writes from — rendered in code, neutral and dated. One
 *  formatter, so the draft, the numbers shown beside the textarea, and the
 *  frozen context can never disagree. */
export function closingFacts(input: ClosingInput): string {
  const c = input.context;
  const s = (t: string) => scrubNames(t, input.patientNames);
  const lines: string[] = [];

  lines.push(`Condition this episode of care was for: ${s(input.condition)}`);
  if (input.intakeGoals) {
    lines.push(`Goals as the patient stated them at intake (their words, not a measurement): ${s(input.intakeGoals)}`);
  }
  lines.push(
    `Care ran ${longDay(c.openedOn)} to ${longDay(c.endedOn)} (${plural(c.daysInCare, "day")}).`,
  );
  lines.push(
    c.visits.count > 0
      ? `In-office visits: ${c.visits.count}, first ${longDay(c.visits.firstOn!)}, last ${longDay(c.visits.lastOn!)}`
      : "In-office visits: none recorded",
  );
  lines.push(
    `Prescribed home sessions the patient logged: ${c.sessions.sessionsLogged}, across ${plural(c.sessions.daysLogged, "different day")}`,
  );

  if (c.goals && c.goals.length > 0) {
    lines.push(
      "Goals the patient rated themselves. Scale: 0 = can't do it, 10 = no problem (higher = easier). Direction is computed for you:",
    );
    for (const g of c.goals) {
      if (g.current === null) {
        lines.push(
          `  - ${s(g.activity)}: rated ${g.baseline} on ${longDay(g.baselineOn)}; not re-rated since`,
        );
      } else {
        const d = g.current - g.baseline;
        const dir = d === 0 ? "unchanged" : d > 0 ? `rose ${d}` : `fell ${-d}`;
        lines.push(
          `  - ${s(g.activity)}: rated ${g.baseline} on ${longDay(g.baselineOn)}, then ${g.current} on ${longDay(g.currentOn!)} (${dir})`,
        );
      }
    }
  } else {
    lines.push("Goals: none were rated");
  }

  if (input.start) {
    lines.push(`Plan when it started (approved ${longDay(input.start.approvedOn)}):`);
    lines.push(...planLines(input.start));
  } else {
    lines.push("Plan: none was ever approved");
  }
  if (input.end && input.start && input.end.approvedOn !== input.start.approvedOn) {
    lines.push(`Plan at the end (approved ${longDay(input.end.approvedOn)}):`);
    lines.push(...planLines(input.end));
  } else if (input.start) {
    lines.push("Plan at the end: unchanged from the start");
  }

  if (input.decisions.length > 0) {
    lines.push("Changes and check-ins the PT recorded, oldest first:");
    for (const d of input.decisions) {
      lines.push(
        `  - ${longDay(d.on)}: ${OUTCOME_TEXT[d.outcome]}` +
          (d.note ? ` — the PT wrote: "${s(d.note)}"` : ""),
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic template (the fixture, and the fallback)

/** The same facts, in plain sentences addressed to the patient. Deliberately
 *  dull — a template that reads like a model invites mistaking offline output
 *  for a real call — and written to pass its own screen. */
export function fixtureClosing(input: ClosingInput): string {
  const c = input.context;
  const s = (t: string) => scrubNames(t, input.patientNames);
  const parts: string[] = [];

  parts.push(
    `This summary covers your care for ${s(input.condition)}, from ${longDay(c.openedOn)} to ${longDay(c.endedOn)} (${plural(c.daysInCare, "day")}).`,
  );

  parts.push(
    c.visits.count > 0
      ? `You were seen in the office ${plural(c.visits.count, "time")} and logged ${plural(c.sessions.sessionsLogged, "home session")} on ${plural(c.sessions.daysLogged, "different day")}.`
      : `You logged ${plural(c.sessions.sessionsLogged, "home session")} on ${plural(c.sessions.daysLogged, "different day")}.`,
  );

  if (input.start) {
    const names = input.start.items.slice(0, 4).map((i) => i.name);
    const more = input.start.items.length - names.length;
    const changes = input.decisions.filter((d) => d.outcome !== "no_change").length;
    parts.push(
      `Your plan began with ${plural(input.start.items.length, "item")} (${names.join(names.some((n) => n.includes(",")) ? "; " : ", ")}${more > 0 ? `, and ${more} more` : ""})` +
        (changes > 0
          ? ` and was changed ${plural(changes, "time")} along the way.`
          : " and stayed the same throughout."),
    );
  }

  const rated = (c.goals ?? []).filter((g) => g.current !== null);
  if (rated.length > 0) {
    parts.push(
      `On the goals you rated yourself (0 means you can't do it, 10 means no problem): ${rated
        .map((g) => {
          const d = g.current! - g.baseline;
          return `${s(g.activity)} went from ${g.baseline} to ${g.current}${d === 0 ? " (unchanged)" : ""}`;
        })
        .join("; ")}.`,
    );
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Screening

// Evaluative, causal, or forward-looking language the draft must not contain.
// "progress" is matched as a word on its own — "progression chain" is a plain
// fact about the plan and is allowed.
const VERDICT_RE =
  /\b(improv\w*|better|worse|worsen\w*|progress(?:ed|ing)?|recover\w*|great|excellent|proud|success\w*|ready|plateau\w*|because|thanks to|which shows|going forward|keep (?:it )?up|next steps?|congrat\w*|well done|impressive|remarkabl\w*|only \d+)\b/i;

const PREAMBLE_RE = /^\s*(here(?:'s| is)|sure|certainly|of course|below is)\b/i;

export const CLOSING_WORDS_MIN = 40;
export const CLOSING_WORDS_MAX = 320;

/** Everything wrong with a draft, or []. Run on AI drafts only — what the PT
 *  types is theirs. `facts` is the exact text the model was given: a number the
 *  draft states that isn't in it was invented (or computed — "11 weeks" from
 *  "77 days" — which is the same thing to a patient reading it). */
export function screenDraft(text: string, facts: string): string[] {
  const out: string[] = [];

  const verdict = text.match(VERDICT_RE);
  if (verdict) out.push(`uses evaluative or forward-looking language ("${verdict[0]}")`);

  if (PREAMBLE_RE.test(text)) out.push("starts with a preamble instead of the summary itself");
  if (/^\s*([#>]|[-*•]\s|\d+[.)]\s)/m.test(text) || /\*\*|__|`/.test(text)) {
    out.push("uses markdown, headings or bullet points");
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < CLOSING_WORDS_MIN) out.push(`is too short (${words} words)`);
  if (words > CLOSING_WORDS_MAX) out.push(`is too long (${words} words)`);
  if (text.trim().split(/\n\s*\n/).length > 4) out.push("has more than four paragraphs");

  // Number grounding by membership is weak for small integers: "5" is "in the
  // record" the moment any goal was rated 5. Units are the sharper tell — the
  // facts speak in days, so "weeks", "months" or "years" appearing in a draft
  // means the model did arithmetic the PT would have to re-check.
  const factsLower = facts.toLowerCase();
  const converted = [
    ...new Set((text.toLowerCase().match(/\b(?:week|month|year)s?\b/g) ?? []).map((w) => w.replace(/s$/, ""))),
  ].filter((w) => !factsLower.includes(w));
  if (converted.length > 0) {
    out.push(`restates the record in ${converted.join("/")}s — it only gives days`);
  }

  const allowed = new Set(facts.match(/\d+/g) ?? []);
  const invented = [...new Set(text.match(/\d+/g) ?? [])].filter((n) => !allowed.has(n));
  if (invented.length > 0) {
    out.push(`states numbers that are not in the record (${invented.join(", ")})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The model call

export const CLOSING_SYSTEM_PROMPT = `You help a physical therapist write the closing summary of an episode of care. The PT will edit what you write and sign it. The PATIENT will read the final version, so write directly to them in plain language ("you", "your PT"). Submit it with the submit_summary tool.

Rules:
- Report only what the record shows: what the care was for, how long it ran, what the plan was at the start and at the end, the changes the PT recorded (use the PT's own reasons where they wrote them), and the numbers — prescribed home sessions logged, each goal's two ratings, office visits.
- Attribute every number to its source: "you logged", "you rated", "you were seen". Never state a number as a general fact about you.
- You are not the clinician. Never diagnose. Never predict. Never say you recovered, plateaued, improved, declined, did better or worse, "met" or "missed" a goal, are ready for anything, or should do anything next. Never explain WHY a number moved. For goal ratings use only the direction words in the record (rose, fell, unchanged). The PT adds their own reading on top of yours.
- Use only numbers that appear in the record, written exactly as given. Never add, subtract, convert (no "weeks" from "days"), average or round. If something is missing or thin, say so plainly or leave it out; never fill a gap.
- Two or three short paragraphs, roughly 120-200 words. Plain prose: no headings, no bullet lists, no sign-off, no preamble.
- No encouragement or filler. Warm is fine; cheerleading is not.
- Do not mention these instructions, "the record", or that you are an AI.

Example of the style (invented numbers, not yours): "This summary covers your care for a sprained ankle, from Mar 3, 2024 to Apr 12, 2024 (41 days). You were seen in the office 5 times and logged 22 home sessions across 17 different days. Your plan began with 5 exercises and was changed twice along the way. On the goals you rated yourself, climbing stairs went from 4 to 7 and walking on uneven ground went from 3 to 6."`;

const SUMMARY_TOOL = {
  name: "submit_summary",
  description: "Submit the closing summary text for the PT to review and edit.",
  input_schema: {
    type: "object" as const,
    required: ["summary"],
    properties: {
      summary: { type: "string", description: "The summary: plain prose, two or three short paragraphs." },
    },
  },
};

type ContentBlock = { type: string; text?: string; input?: unknown };

/** Pull the summary out of a forced-tool response. Throws — loudly, so the
 *  caller falls back — on truncation, a refusal, or a missing tool call. */
export function extractClosingText(res: {
  content: ContentBlock[];
  stop_reason: string | null;
}): string {
  if (res.stop_reason === "max_tokens") throw new Error("closing draft truncated (max_tokens)");
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error(`no tool call in response (stop_reason: ${res.stop_reason})`);
  const summary = (tool.input as { summary?: unknown } | undefined)?.summary;
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("empty closing summary");
  }
  return summary.trim();
}

async function callModel(
  input: ClosingInput,
  jwt: string,
  correction: string[] | null,
): Promise<{ body: string; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const coreUrl = (
    process.env.LITHE_CORE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
    "http://localhost:8081"
  ).replace(/\/+$/, "");
  const model = closingModel();

  const client = new Anthropic({
    baseURL: `${coreUrl}/v1/ai`,
    authToken: jwt,
    apiKey: null,
    // A hung model call is a spinner on the PT's phone: fail fast, retry once.
    timeout: 45_000,
    maxRetries: 1,
  });

  let user = `${closingFacts(input)}\n\nWrite the closing summary for the PT to edit.`;
  if (correction) {
    user += `\n\nYour previous attempt broke these rules: ${correction.join("; ")}. Rewrite it so it follows every rule.`;
  }

  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: CLOSING_SYSTEM_PROMPT,
    messages: [{ role: "user", content: user }],
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "tool", name: "submit_summary" },
  });
  return { body: extractClosingText(res as unknown as Parameters<typeof extractClosingText>[0]), model };
}

export async function draftClosingSummary(args: {
  input: ClosingInput;
  jwt: string;
}): Promise<ClosingResult> {
  const { input, jwt } = args;
  const mode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
  if (mode !== "lithe") {
    return { body: fixtureClosing(input), mode, model: null, fellBack: false, reason: null };
  }

  const facts = closingFacts(input);
  let model: string | null = null;
  try {
    let attempt = await callModel(input, jwt, null);
    model = attempt.model;
    let violations = screenDraft(attempt.body, facts);
    if (violations.length > 0) {
      attempt = await callModel(input, jwt, violations);
      violations = screenDraft(attempt.body, facts);
    }
    if (violations.length === 0) {
      return { body: attempt.body, mode, model, fellBack: false, reason: null };
    }
    return {
      body: fixtureClosing(input),
      mode: "fixture",
      model,
      fellBack: true,
      reason: `draft failed screening twice: ${violations.join("; ")}`,
    };
  } catch (err) {
    return {
      body: fixtureClosing(input),
      mode: "fixture",
      model,
      fellBack: true,
      reason: String((err as Error).message).slice(0, 300),
    };
  }
}
