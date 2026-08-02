// AI adherence summary (PRD §2, build step 5). Same two-mode seam as the plan
// draft — 'fixture' for offline dev/tests/demos, 'lithe' for the platform
// /v1/ai gateway with the PT's JWT forwarded. Small model: this is a paragraph
// over a handful of rows, not a reasoning task.
//
// This output is PT-facing only and never reaches the patient, so the rules
// differ from the plan draft: it may say what the numbers show, but it must
// not diagnose, prescribe, or tell the PT what to change — the PT reads the
// logs and decides (PRD doctrine #1).
//
// The prompt deliberately carries no patient name. The dashboard already shows
// who this is; sending an identity to the model buys nothing and cuts against
// the PHI posture in PRD §6.

import type { Compliance, PainTrend } from "@/lib/adherence/stats";

export type FlagEntry = {
  date: string;
  exercise: string;
  pain: number | null;
  note: string | null;
  flagged: boolean;
};

export type SummaryInput = {
  condition: string;
  windowDays: number;
  compliance: Compliance;
  pain: PainTrend;
  flags: FlagEntry[];
};

export type SummaryResult = {
  body: string;
  mode: "fixture" | "lithe";
  model: string | null;
};

export const DEFAULT_SUMMARY_MODEL = "claude-haiku-4-5";

/** Single source of truth for the summary model — the error-path log must
 *  record the model litheSummary actually called. */
export function summaryModel(): string {
  return process.env.CARRYOVER_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Render the same facts the model gets, as prose. Used verbatim in fixture
 *  mode and as the model's input in lithe mode — one formatter, so an offline
 *  demo and a live call can never disagree about the numbers. */
export function factSheet(input: SummaryInput): string {
  const { compliance: c, pain, flags, windowDays } = input;
  const lines: string[] = [];
  lines.push(`Condition: ${input.condition}`);
  lines.push(`Window: last ${plural(windowDays, "day")} of home exercise`);

  if (!c.scorable) {
    lines.push("Adherence: too early to score — the plan has not been active long enough.");
  } else {
    lines.push(`Adherence: ${c.completed} of ${c.expected} expected sessions (${c.percent}%)`);
    for (const it of c.items) {
      lines.push(
        `  - ${it.name}: ${it.completed}/${it.expected} (${it.frequencyPerWeek}x/wk prescribed)` +
          `${it.lastDone ? `, last done ${it.lastDone}` : ", never logged"}`,
      );
    }
  }

  if (pain.direction === null) {
    lines.push(
      pain.points.length
        ? `Pain: ${plural(pain.points.length, "day")} scored, not enough for a trend`
        : "Pain: no scores logged",
    );
  } else {
    lines.push(
      `Pain: ${pain.start} -> ${pain.end} over the window (${pain.direction}), ` +
        `${plural(pain.points.length, "day")} scored`,
    );
  }

  if (flags.length === 0) {
    lines.push("Flags and notes: none");
  } else {
    lines.push("Flags and notes:");
    for (const f of flags) {
      lines.push(
        `  - ${f.date} ${f.exercise}${f.flagged ? " [FLAGGED FOR PT]" : ""}` +
          `${f.pain !== null ? `, pain ${f.pain}/10` : ""}${f.note ? `: "${f.note}"` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

/** Deterministic offline summary: the same facts, assembled into sentences.
 *  Deliberately dull — a fixture that reads like a model invites mistaking
 *  fixture output for a real call. */
function fixtureSummary(input: SummaryInput): string {
  const { compliance: c, pain, flags } = input;
  const parts: string[] = [];

  parts.push(
    c.scorable
      ? `Logged ${c.completed} of ${c.expected} expected home sessions (${c.percent}%) over the last ${plural(input.windowDays, "day")}.`
      : `The plan is too new to score adherence — ${plural(c.completed, "session")} logged so far.`,
  );

  const behind = c.items.filter((i) => i.expected > 0 && i.completed < i.expected * 0.6);
  if (behind.length) {
    parts.push(
      `Furthest behind: ${behind
        .slice(0, 3)
        .map((i) => `${i.name} (${i.completed}/${i.expected})`)
        .join(", ")}.`,
    );
  }

  if (pain.direction === "down") parts.push(`Pain is trending down, ${pain.start} to ${pain.end}.`);
  else if (pain.direction === "up") parts.push(`Pain is trending up, ${pain.start} to ${pain.end}.`);
  else if (pain.direction === "flat") parts.push(`Pain is flat around ${pain.end}.`);
  else parts.push("Not enough pain scores yet to read a trend.");

  const flagged = flags.filter((f) => f.flagged);
  if (flagged.length) {
    parts.push(
      `${plural(flagged.length, "item")} flagged for you: ${flagged
        .slice(0, 3)
        .map((f) => `${f.exercise} (${f.date})`)
        .join(", ")}.`,
    );
  } else if (flags.length) {
    parts.push(`${plural(flags.length, "note")} left, none flagged.`);
  } else {
    parts.push("Nothing flagged.");
  }

  return parts.join(" ");
}

const SYSTEM_PROMPT = `You summarize a physical therapy patient's at-home exercise logs for their treating physical therapist. The PT reads this before or during a visit.

Rules:
- Report only what the data shows. Never diagnose, never prescribe, never recommend a change to the plan — the PT decides.
- 3-5 sentences of plain prose. No headings, no bullet lists, no preamble.
- Lead with adherence, then the pain trend, then anything flagged or written by the patient.
- Quote the patient's own words when a note is telling.
- Say plainly when the data is too thin to support a read. Never fill a gap with a guess.
- Write for a clinician: concise, specific, no encouragement or filler.`;

async function litheSummary(input: SummaryInput, jwt: string): Promise<{ body: string; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const coreUrl = (
    process.env.LITHE_CORE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
    "http://localhost:8081"
  ).replace(/\/+$/, "");
  const model = summaryModel();

  const client = new Anthropic({ baseURL: `${coreUrl}/v1/ai`, authToken: jwt, apiKey: null });
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${factSheet(input)}\n\nSummarize for the PT.` }],
  });

  const body = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
  if (!body) {
    // Refusal, truncation, or an all-thinking response — fail loudly so the
    // route logs an error rather than storing an empty summary.
    throw new Error(`empty summary text (stop_reason: ${res.stop_reason})`);
  }
  return { body, model };
}

export async function summarizeAdherence(args: {
  input: SummaryInput;
  jwt: string;
}): Promise<SummaryResult> {
  const mode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
  if (mode === "lithe") {
    const { body, model } = await litheSummary(args.input, args.jwt);
    return { body, mode, model };
  }
  return { body: fixtureSummary(args.input), mode, model: null };
}
