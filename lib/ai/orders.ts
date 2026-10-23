// Reading a PICTURE of a doctor's document — a protocol table, a scanned
// order — for the PT to check.
//
// The text of a PDF is read in code (lib/intake/orders). Some of what matters
// is not text: a surgeon's protocol is often a flat image of a table. This sends
// those pictures to the model and gets back a typed transcription.
//
// What goes in, and what doesn't:
//   * only the picture(s) — never the PDF's text layer (its running header
//     carries the patient's name and DOB) and never the FILE NAME (people name
//     files after the patient). Nothing about who the patient is is in the prompt.
//   * a pixel can't be redacted, so a photo of a whole referral shows the model
//     whatever is printed on it. That is why this runs only when a PT clicks it,
//     after being told so — and why the model is told not to transcribe
//     identifiers, and the result is redacted again in code.
//
// What comes out is a DRAFT: it is rendered into text by code from a typed
// structure (capped, redacted), shown to the PT beside the page, and only enters
// the doctor's-plan box if they choose to add it.

import { DEFAULT_PLAN_MODEL } from "@/lib/ai/plan";
import { redactIdentifiers } from "@/lib/intake/redact";

export type PictureInput = { mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string };

export type ProtocolRead = {
  readable: boolean;
  title: string | null;
  pathways: { name: string; rule: string }[];
  phases: {
    name: string;
    timeframe: string | null;
    weightBearing: string | null;
    limits: string | null;
    interventions: string | null;
    criteria: string | null;
  }[];
  notes: string[];
};

export type PicturesResult =
  | { ok: true; block: string; read: ProtocolRead; mode: "lithe"; model: string }
  | { ok: false; reason: string; mode: "fixture" | "lithe"; model: string | null };

export function ordersModel(): string {
  return process.env.CARRYOVER_ORDERS_MODEL || DEFAULT_PLAN_MODEL;
}

export const PICTURES_SYSTEM_PROMPT = `You read a picture of a clinical document for a physical therapist: a surgeon's rehabilitation protocol, a referral, or a physician's instructions. The therapist will check your transcription against the original, so accuracy matters more than polish. Submit it with the submit_protocol tool.

Rules:
- Transcribe ONLY what is written. Never add, infer, summarise away, or "correct" anything. If a cell or word is hard to read, write [unclear] rather than guessing.
- Keep every number, range, unit, angle and duration exactly as printed ("0-90°", "x 4 weeks", "6-8 hrs/day").
- Weight-bearing rules, brace rules and range-of-motion limits are the most important content: put them where the tool asks for them, in the document's own words.
- If the document is a table of phases, give one entry per phase, in order, with the columns it has. If it is not a protocol, use "notes" for what it says.
- Do NOT transcribe anything that identifies a person: no patient name, date of birth, record, insurance or ID numbers, home address, phone, fax or email. Leave out the practice's contact details too — only the clinical content is wanted.
- If the picture is not a readable clinical document, set readable to false and submit nothing else.`;

const SUBMIT_TOOL = {
  name: "submit_protocol",
  description: "Submit the transcription of the document.",
  input_schema: {
    type: "object" as const,
    required: ["readable"],
    properties: {
      readable: { type: "boolean", description: "False if the picture is not a legible clinical document." },
      title: { type: "string", description: "The document's title or protocol name, as printed." },
      pathways: {
        type: "array",
        description: "Named weight-bearing (or similar) pathways the document defines, e.g. 'Pathway A'.",
        items: {
          type: "object",
          required: ["name", "rule"],
          properties: {
            name: { type: "string" },
            rule: { type: "string", description: "The rule in the document's own words." },
          },
        },
      },
      phases: {
        type: "array",
        description: "One entry per phase or stage, in order.",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "e.g. 'Phase I — Maximum Protection'." },
            timeframe: { type: "string", description: "e.g. 'Weeks 0-6'." },
            weight_bearing: { type: "string" },
            limits: { type: "string", description: "Brace, ROM, CPM and other limits for the phase." },
            interventions: { type: "string", description: "Exercises and treatments, as listed." },
            criteria: { type: "string", description: "Goals / criteria to progress, as listed." },
          },
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Any other stated rule or note, e.g. 'avoid aggressive loading until…'.",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Turning the typed answer into bounded, redacted text

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? redactIdentifiers(t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};

/** Normalise whatever the tool returned into ProtocolRead, dropping anything
 *  malformed and capping everything. Never trusts the model's shape. */
export function screenRead(raw: unknown): ProtocolRead {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const pathways = list(r.pathways)
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const name = str(o.name, 120);
      const rule = str(o.rule, 600);
      return name && rule ? { name, rule } : null;
    })
    .filter((p): p is { name: string; rule: string } => p !== null)
    .slice(0, 6);
  const phases = list(r.phases)
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const name = str(o.name, 120);
      if (!name) return null;
      return {
        name,
        timeframe: str(o.timeframe, 80),
        weightBearing: str(o.weight_bearing, 400),
        limits: str(o.limits, 500),
        interventions: str(o.interventions, 900),
        criteria: str(o.criteria, 700),
      };
    })
    .filter((p): p is ProtocolRead["phases"][number] => p !== null)
    .slice(0, 12);
  const notes = list(r.notes)
    .map((n) => str(n, 500))
    .filter((n): n is string => n !== null)
    .slice(0, 8);
  const title = str(r.title, 160);
  const readable = r.readable !== false && (pathways.length > 0 || phases.length > 0 || notes.length > 0);
  return { readable, title, pathways, phases, notes };
}

/** The text that can go in the doctor's-plan box. */
export function protocolBlock(p: ProtocolRead): string {
  const lines: string[] = [`Protocol read from the attached picture${p.title ? ` (${p.title})` : ""} — check against the page:`];
  if (p.pathways.length) {
    lines.push("Pathways:");
    for (const w of p.pathways) lines.push(`- ${w.name}: ${w.rule}`);
  }
  if (p.phases.length) {
    lines.push("Phases:");
    for (const ph of p.phases) {
      lines.push(`- ${ph.name}${ph.timeframe ? ` (${ph.timeframe})` : ""}`);
      if (ph.weightBearing) lines.push(`  Weight bearing: ${ph.weightBearing}`);
      if (ph.limits) lines.push(`  Limits: ${ph.limits}`);
      if (ph.interventions) lines.push(`  Interventions: ${ph.interventions}`);
      if (ph.criteria) lines.push(`  To progress: ${ph.criteria}`);
    }
  }
  if (p.notes.length) {
    lines.push("Notes:");
    for (const n of p.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The call

type ContentBlock = { type: string; input?: unknown };
type CreateArgs = {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  tools: unknown[];
  tool_choice: unknown;
};
export type CreateFn = (args: CreateArgs) => Promise<{ content: ContentBlock[]; stop_reason: string | null }>;

/** The submitted structure out of a forced-tool response. Throws on truncation
 *  or a missing call so the caller reports instead of guessing. */
export function extractRead(res: { content: ContentBlock[]; stop_reason: string | null }): unknown {
  if (res.stop_reason === "max_tokens") throw new Error("the transcription was cut off (too long)");
  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error(`no tool call in response (stop_reason: ${res.stop_reason})`);
  return tool.input;
}

async function liveCreate(jwt: string): Promise<CreateFn> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const coreUrl = (
    process.env.LITHE_CORE_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_LITHE_CORE_URL ||
    "http://localhost:8081"
  ).replace(/\/+$/, "");
  const client = new Anthropic({
    baseURL: `${coreUrl}/v1/ai`,
    authToken: jwt,
    apiKey: null,
    timeout: 90_000,
    maxRetries: 1,
  });
  return (args) =>
    client.messages.create(args as never) as unknown as ReturnType<CreateFn>;
}

export async function readPictures(args: {
  images: PictureInput[];
  jwt: string;
  /** Test seam: replaces the network call. */
  create?: CreateFn;
}): Promise<PicturesResult> {
  const mode = process.env.CARRYOVER_AI_MODE === "lithe" ? "lithe" : "fixture";
  if (mode !== "lithe" && !args.create) {
    return { ok: false, mode, model: null, reason: "AI reading is switched off in this environment." };
  }
  if (args.images.length === 0) {
    return { ok: false, mode, model: null, reason: "There is no picture to read." };
  }

  const model = ordersModel();
  try {
    const create = args.create ?? (await liveCreate(args.jwt));
    const res = await create({
      model,
      max_tokens: 4096,
      system: PICTURES_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...args.images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.base64 },
            })),
            {
              type: "text",
              text: `${args.images.length === 1 ? "This picture is" : `These ${args.images.length} pictures are`} from a clinical document. Transcribe it with the submit_protocol tool.`,
            },
          ],
        },
      ],
      tools: [SUBMIT_TOOL],
      tool_choice: { type: "tool", name: "submit_protocol" },
    });
    const read = screenRead(extractRead(res));
    if (!read.readable) {
      return { ok: false, mode: "lithe", model, reason: "That didn't look like a readable clinical document." };
    }
    return { ok: true, block: protocolBlock(read), read, mode: "lithe", model };
  } catch (err) {
    return {
      ok: false,
      mode: "lithe",
      model,
      reason: String((err as Error).message).slice(0, 300) || "The AI couldn't read that.",
    };
  }
}
