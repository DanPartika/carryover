import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractRead,
  PICTURES_SYSTEM_PROMPT,
  protocolBlock,
  readPictures,
  screenRead,
  type CreateFn,
} from "./orders";

afterEach(() => vi.unstubAllEnvs());

// What a model might hand back for a protocol sheet: the shape of the real one
// (pathways + phases), with the content shortened.
const READ = {
  readable: true,
  title: "MACI Procedure Patella / Trochlea — Rehabilitation Protocol",
  pathways: [
    { name: "Pathway A (Isolated MACI)", rule: "Weight bearing as tolerated with brace; brace locked x 2 weeks, then unlock" },
    { name: "Pathway B (MACI + TTO)", rule: "Heel touch weight bearing x 4 weeks; brace locked x 4 weeks; no active knee extension x 6 weeks" },
  ],
  phases: [
    {
      name: "Phase I — Maximum Protection",
      timeframe: "Weeks 0-6",
      weight_bearing: "Per pathway (see above)",
      limits: "Brace locked in extension per pathway. CPM 6-8 hrs/day; Week 1: 0-60° (condylar)",
      interventions: "Quad sets, SLR (4-way), isometric quad at 60°, patellar mobilizations",
      criteria: "Pain controlled (0-2/10 with ADLs); full extension; flexion to 90°+",
    },
    { name: "Phase II — Early Rehab", timeframe: "Weeks 6-12", weight_bearing: "Progress to full WB without brace" },
  ],
  notes: ["Progression depends on graft location/size and individual healing response."],
};

const okReply = (input: unknown): CreateFn =>
  vi.fn(async () => ({ content: [{ type: "tool_use", input }], stop_reason: "tool_use" }));

const IMG = { mediaType: "image/png" as const, base64: "iVBORw0KGgo=" };

describe("what is sent", () => {
  it("is the pictures and a fixed instruction — never a file name or any patient text", async () => {
    const create = okReply(READ);
    await readPictures({ images: [IMG, { ...IMG, base64: "AAAA" }], jwt: "jwt", create });
    const call = (create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content = call.messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === "image")).toHaveLength(2);
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    const text = content.find((b: { type: string }) => b.type === "text").text as string;
    expect(text).toBe("These 2 pictures are from a clinical document. Transcribe it with the submit_protocol tool.");
    // The whole request carries nothing but the system prompt, the pictures and that line.
    expect(JSON.stringify(call.messages)).not.toMatch(/\.pdf|\.png|dob|patient name/i);
    expect(call.tool_choice).toEqual({ type: "tool", name: "submit_protocol" });
    expect(call.tools).toHaveLength(1);
  });

  it("tells the model to transcribe faithfully and to leave identifiers out", () => {
    expect(PICTURES_SYSTEM_PROMPT).toMatch(/Transcribe ONLY what is written/);
    expect(PICTURES_SYSTEM_PROMPT).toMatch(/\[unclear\]/);
    expect(PICTURES_SYSTEM_PROMPT).toMatch(/Do NOT transcribe anything that identifies a person/);
    expect(PICTURES_SYSTEM_PROMPT).toMatch(/readable to false/);
  });
});

describe("what comes back", () => {
  it("is rendered into text by code, in the order the document gives it", async () => {
    const r = await readPictures({ images: [IMG], jwt: "x", create: okReply(READ) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.split("\n")).toEqual([
      "Protocol read from the attached picture (MACI Procedure Patella / Trochlea — Rehabilitation Protocol) — check against the page:",
      "Pathways:",
      "- Pathway A (Isolated MACI): Weight bearing as tolerated with brace; brace locked x 2 weeks, then unlock",
      "- Pathway B (MACI + TTO): Heel touch weight bearing x 4 weeks; brace locked x 4 weeks; no active knee extension x 6 weeks",
      "Phases:",
      "- Phase I — Maximum Protection (Weeks 0-6)",
      "  Weight bearing: Per pathway (see above)",
      "  Limits: Brace locked in extension per pathway. CPM 6-8 hrs/day; Week 1: 0-60° (condylar)",
      "  Interventions: Quad sets, SLR (4-way), isometric quad at 60°, patellar mobilizations",
      "  To progress: Pain controlled (0-2/10 with ADLs); full extension; flexion to 90°+",
      "- Phase II — Early Rehab (Weeks 6-12)",
      "  Weight bearing: Progress to full WB without brace",
      "Notes:",
      "- Progression depends on graft location/size and individual healing response.",
    ]);
  });

  it("is redacted again in code, in case the model transcribed an identifier anyway", () => {
    const read = screenRead({
      readable: true,
      pathways: [{ name: "Pathway A", rule: "Call (555) 123-4567 or jordan@example.com; DOB: 01/02/1990; MRN: 99887766" }],
    });
    const text = protocolBlock(read);
    expect(text).not.toMatch(/555|jordan@|01\/02\/1990|99887766/);
    expect(text).toContain("[phone removed]");
    expect(text).toContain("[email removed]");
  });

  it("never trusts the shape: junk is dropped, long text is cut, lists are capped", () => {
    const read = screenRead({
      readable: true,
      pathways: [{ name: "", rule: "no name" }, { name: "A", rule: "ok" }, "nonsense", null, ...Array.from({ length: 20 }, (_, i) => ({ name: `P${i}`, rule: "r" }))],
      phases: [{ timeframe: "no name" }, ...Array.from({ length: 30 }, (_, i) => ({ name: `Phase ${i}`, interventions: "x".repeat(5000) }))],
      notes: [42, "  ", "a note", ...Array.from({ length: 30 }, () => "n")],
    });
    expect(read.pathways.length).toBeLessThanOrEqual(6);
    expect(read.pathways[0]).toEqual({ name: "A", rule: "ok" });
    expect(read.phases.length).toBeLessThanOrEqual(12);
    expect(read.phases[0].interventions!.length).toBeLessThanOrEqual(900);
    expect(read.notes.length).toBeLessThanOrEqual(8);
    expect(read.notes).not.toContain("42");
  });

  it("treats an answer with nothing in it as unreadable", async () => {
    for (const input of [{ readable: false }, {}, { readable: true, phases: [] }, "string", null]) {
      const r = await readPictures({ images: [IMG], jwt: "x", create: okReply(input) });
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
  });
});

describe("when it can't read", () => {
  it("answers with a reason instead of throwing — the PT can always paste", async () => {
    const boom: CreateFn = async () => {
      throw new Error("upstream 529 overloaded");
    };
    const r = await readPictures({ images: [IMG], jwt: "x", create: boom });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/overloaded/);

    const cut: CreateFn = async () => ({ content: [], stop_reason: "max_tokens" });
    const r2 = await readPictures({ images: [IMG], jwt: "x", create: cut });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toMatch(/cut off/);

    const none: CreateFn = async () => ({ content: [{ type: "text" }], stop_reason: "end_turn" });
    expect((await readPictures({ images: [IMG], jwt: "x", create: none })).ok).toBe(false);
  });

  it("stays off outside lithe mode, and with nothing to read", async () => {
    vi.stubEnv("CARRYOVER_AI_MODE", "fixture");
    const r = await readPictures({ images: [IMG], jwt: "x" });
    expect(r).toMatchObject({ ok: false, mode: "fixture" });
    if (!r.ok) expect(r.reason).toMatch(/switched off/);
    expect((await readPictures({ images: [], jwt: "x", create: okReply(READ) })).ok).toBe(false);
  });
});

describe("extractRead", () => {
  it("returns the tool input, and throws on a cut-off or missing call", () => {
    expect(extractRead({ stop_reason: "tool_use", content: [{ type: "tool_use", input: { a: 1 } }] })).toEqual({ a: 1 });
    expect(() => extractRead({ stop_reason: "max_tokens", content: [] })).toThrow(/cut off/);
    expect(() => extractRead({ stop_reason: "end_turn", content: [] })).toThrow(/no tool call/);
  });
});
