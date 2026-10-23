// "What might this person want back?" — ideas for the PT to offer, not
// anything the patient reads straight from a model.
//
// Same two-mode seam as the rest of lib/ai: CARRYOVER_AI_MODE=fixture returns
// the hand-written starter list, 'lithe' asks the model through Core. A PT
// reading an intake is the audience; they pick what fits and the patient rates
// it themselves. Every idea is screened in code (lib/goals/ideas.screenIdea) —
// short, plain, no numbers, no advice, no prediction — and any failure falls
// back to the starter list, so the button is never a dead end.
//
// The facts are only what the PT already typed into the intake form: the
// condition, side, regions, restrictions and assistive device. No name, no
// free-text narrative.

import { DEFAULT_PLAN_MODEL } from "@/lib/ai/plan";
import { cleanIdeas, starterIdeas } from "@/lib/goals/ideas";
import { goalKey } from "@/lib/goals/model";

export type IdeaInput = {
  condition: string;
  side: string | null;
  regions: string[];
  restrictions: string | null;
  assistiveDevice: string | null;
  /** Goals already on the list, so the model doesn't repeat them. */
  existing: string[];
};

export type IdeaResult = {
  ideas: string[];
  mode: "fixture" | "lithe";
  model: string | null;
  fellBack: boolean;
  reason: string | null;
};

export function ideasModel(): string {
  return process.env.CARRYOVER_IDEAS_MODEL || DEFAULT_PLAN_MODEL;
}

const IDEA_COUNT = 6;

export function ideaFacts(input: IdeaInput): string {
  const lines = [`Condition: ${input.condition.trim().slice(0, 300) || "not given"}`];
  if (input.side) lines.push(`Side: ${input.side}`);
  if (input.regions.length) lines.push(`Body regions: ${input.regions.join(", ")}`);
  if (input.restrictions?.trim()) {
    lines.push(`Restrictions and precautions from the PT: ${input.restrictions.trim().slice(0, 500)}`);
  }
  if (input.assistiveDevice?.trim()) {
    lines.push(`Assistive device: ${input.assistiveDevice.trim().slice(0, 120)}`);
  }
  if (input.existing.length) {
    lines.push(`Already on the goal list (do not repeat): ${input.existing.join("; ")}`);
  }
  return lines.join("\n");
}

export const IDEAS_SYSTEM_PROMPT = `You help a physical therapist think of everyday activities a patient might want to get back to, so the PT can ask about them at intake. The patient will rate each one themselves from 0 (can't do it) to 10 (no problem). Submit them with the submit_ideas tool.

Rules:
- Offer ${IDEA_COUNT} activities. Each is the ACTIVITY ITSELF in everyday words, 3 to 8 words, as the patient might say it ("Climbing stairs", "Sleeping through the night", "Getting in and out of the car").
- Pick things this person's situation plausibly affects. If the restrictions say weight bearing is limited, think about getting around, showering, and the car. If the problem is the neck, think about driving and screens.
- Mix the obvious with the easy-to-forget: sleep, getting dressed, work, caring for others, hobbies.
- These are not exercises, not advice, not targets. No numbers, no time frames, no promises, no words about recovery or healing.
- Do not repeat anything already on the list.`;

const IDEAS_TOOL = {
  name: "submit_ideas",
  description: "Submit the activity ideas for the PT.",
  input_schema: {
    type: "object" as const,
    properties: {
      ideas: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 8,
        description: "Short everyday activities, e.g. 'Climbing stairs'.",
      },
    },
    required: ["ideas"],
  },
};

type ContentBlock = { type: string; input?: unknown };

/** The ideas out of a forced-tool response; throws so the caller falls back. */
export function extractIdeas(res: { content: ContentBlock[]; stop_reason: string | null }): unknown[] {
  if (res.stop_reason === "max_tokens") throw new Error("ideas truncated (max_tokens)");
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error(`no tool call in response (stop_reason: ${res.stop_reason})`);
  const ideas = (tool.input as { ideas?: unknown } | undefined)?.ideas;
  if (!Array.isArray(ideas)) throw new Error("no ideas in tool call");
  return ideas;
}

async function callModel(input: IdeaInput, jwt: string): Promise<{ raw: unknown[]; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const coreUrl = (
    process.env.LITHE_CORE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
    "http://localhost:8081"
  ).replace(/\/+$/, "");
  const model = ideasModel();
  const client = new Anthropic({
    baseURL: `${coreUrl}/v1/ai`,
    authToken: jwt,
    apiKey: null,
    timeout: 30_000,
    maxRetries: 1,
  });
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: IDEAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${ideaFacts(input)}\n\nSuggest activities to ask about.` }],
    tools: [IDEAS_TOOL],
    tool_choice: { type: "tool", name: "submit_ideas" },
  });
  return { raw: extractIdeas(res as unknown as Parameters<typeof extractIdeas>[0]), model };
}

export async function suggestGoalIdeas(args: { input: IdeaInput; jwt: string }): Promise<IdeaResult> {
  const { input, jwt } = args;
  const starter = () => starterIdeas(input.regions, input.existing, IDEA_COUNT);
  const mode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
  if (mode !== "lithe") {
    return { ideas: starter(), mode, model: null, fellBack: false, reason: null };
  }

  let model: string | null = null;
  try {
    const attempt = await callModel(input, jwt);
    model = attempt.model;
    const ideas = cleanIdeas(attempt.raw, input.existing, IDEA_COUNT);
    // Too few survivors of the screen means the model wasn't following the
    // rules: top up from the starter list rather than show a thin tray.
    if (ideas.length >= 3) {
      return { ideas, mode, model, fellBack: false, reason: null };
    }
    const seen = new Set(ideas.map(goalKey));
    return {
      ideas: [...ideas, ...starter().filter((s) => !seen.has(goalKey(s)))].slice(0, IDEA_COUNT),
      mode: "fixture",
      model,
      fellBack: true,
      reason: `only ${ideas.length} of the model's ideas passed screening`,
    };
  } catch (err) {
    return {
      ideas: starter(),
      mode: "fixture",
      model,
      fellBack: true,
      reason: String((err as Error).message).slice(0, 300),
    };
  }
}
