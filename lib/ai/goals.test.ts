import { afterEach, describe, expect, it, vi } from "vitest";
import { extractIdeas, ideaFacts, IDEAS_SYSTEM_PROMPT, suggestGoalIdeas, type IdeaInput } from "./goals";

const input: IdeaInput = {
  condition: "Left knee cartilage repair",
  side: "left",
  regions: ["knee"],
  restrictions: "No weight bearing for six weeks",
  assistiveDevice: "crutches",
  existing: ["Sleeping through the night"],
};

afterEach(() => vi.unstubAllEnvs());

describe("ideaFacts", () => {
  it("renders only what the PT entered, with the existing goals to avoid", () => {
    const facts = ideaFacts(input);
    expect(facts).toContain("Condition: Left knee cartilage repair");
    expect(facts).toContain("Side: left");
    expect(facts).toContain("Body regions: knee");
    expect(facts).toContain("No weight bearing for six weeks");
    expect(facts).toContain("Assistive device: crutches");
    expect(facts).toContain("do not repeat): Sleeping through the night");
  });

  it("leaves out what wasn't given", () => {
    const facts = ideaFacts({ ...input, side: null, restrictions: null, assistiveDevice: "  ", existing: [] });
    expect(facts).not.toMatch(/Side:|Restrictions|Assistive|Already on/);
  });
});

describe("the prompt", () => {
  it("keeps the model to activities: no numbers, advice or promises", () => {
    expect(IDEAS_SYSTEM_PROMPT).toMatch(/not exercises, not advice, not targets/);
    expect(IDEAS_SYSTEM_PROMPT).toMatch(/No numbers, no time frames/);
  });
});

describe("extractIdeas", () => {
  it("reads a forced tool call", () => {
    expect(
      extractIdeas({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", input: { ideas: ["Climbing stairs"] } }],
      }),
    ).toEqual(["Climbing stairs"]);
  });

  it("throws on truncation, a missing call or a malformed one", () => {
    expect(() => extractIdeas({ stop_reason: "max_tokens", content: [] })).toThrow(/truncated/);
    expect(() => extractIdeas({ stop_reason: "end_turn", content: [{ type: "text" }] })).toThrow(/no tool call/);
    expect(() =>
      extractIdeas({ stop_reason: "tool_use", content: [{ type: "tool_use", input: { ideas: "x" } }] }),
    ).toThrow(/no ideas/);
  });
});

describe("suggestGoalIdeas in fixture mode", () => {
  it("answers the fixed starter list, minus what is already a goal, without calling a model", async () => {
    vi.stubEnv("CARRYOVER_AI_MODE", "fixture");
    const r = await suggestGoalIdeas({ input, jwt: "unused" });
    expect(r.mode).toBe("fixture");
    expect(r.fellBack).toBe(false);
    expect(r.model).toBeNull();
    expect(r.ideas.length).toBeGreaterThan(0);
    expect(r.ideas.map((i) => i.toLowerCase())).not.toContain("sleeping through the night");
  });
});

describe("suggestGoalIdeas when the model fails", () => {
  it("falls back to the starter list and says why", async () => {
    vi.stubEnv("CARRYOVER_AI_MODE", "lithe");
    vi.stubEnv("LITHE_CORE_INTERNAL_URL", "http://127.0.0.1:9");
    const r = await suggestGoalIdeas({ input, jwt: "bad" });
    expect(r.fellBack).toBe(true);
    expect(r.mode).toBe("fixture");
    expect(r.reason).toBeTruthy();
    expect(r.ideas.length).toBeGreaterThan(0);
  }, 30_000);
});
