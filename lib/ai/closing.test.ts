import { describe, expect, it } from "vitest";
import {
  closingFacts,
  CLOSING_SYSTEM_PROMPT,
  CLOSING_WORDS_MAX,
  extractClosingText,
  fixtureClosing,
  scrubNames,
  screenDraft,
  type ClosingInput,
} from "./closing";
import type { ClosingContext } from "@/lib/episodes/closing";

const ctx = (over: Partial<ClosingContext> = {}): ClosingContext => ({
  version: 1,
  openedOn: "2026-07-29",
  endedOn: "2026-09-02",
  daysInCare: 36,
  planVersions: 3,
  checkIns: 2,
  adherence: { scorable: true, completed: 41, expected: 60, percent: 68, windowDays: 36 },
  sessions: { daysLogged: 22, sessionsLogged: 41, flagged: 1, selfDirected: 3 },
  pain: { start: 4.5, end: 2, direction: "down", daysScored: 18 },
  goals: [
    { activity: "Climbing stairs", baseline: 3, current: 7, baselineOn: "2026-07-29", currentOn: "2026-08-26" },
    { activity: "Walking the dog", baseline: 5, current: null, baselineOn: "2026-07-29", currentOn: null },
  ],
  visits: { count: 3, firstOn: "2026-08-02", lastOn: "2026-08-20" },
  ...over,
});

const input = (over: Partial<ClosingInput> = {}): ClosingInput => ({
  condition: "Right knee, post-op",
  intakeGoals: "walk the dog without a limp",
  context: ctx(),
  start: {
    approvedOn: "2026-08-01",
    items: [
      { name: "Quad Set", line: "3 × 10s hold · daily", location: "home", kind: "exercise" },
      { name: "Heel Slide", line: "3×10 · 5/wk", location: "both", kind: "exercise" },
    ],
  },
  end: {
    approvedOn: "2026-08-20",
    items: [{ name: "Mini Squat", line: "3×10 · 5/wk", location: "home", kind: "exercise" }],
  },
  decisions: [
    { on: "2026-08-11", outcome: "progressed", note: "Dan moved well, stepping up" },
    { on: "2026-08-20", outcome: "revamped", note: null },
  ],
  patientNames: ["Dan", "Partika"],
  ...over,
});

describe("the facts the model writes from", () => {
  const facts = closingFacts(input());

  it("states goal direction in code, on a scale where higher is easier", () => {
    expect(facts).toMatch(/0 = can't do it, 10 = no problem/);
    expect(facts).toMatch(/Climbing stairs: rated 3 on Jul 29, 2026, then 7 on Aug 26, 2026 \(rose 4\)/);
  });

  it("says 'not re-rated since' only for a goal never re-rated", () => {
    expect(facts).toMatch(/Walking the dog: rated 5 on Jul 29, 2026; not re-rated since/);
  });

  it("renders a falling rating as fell, not improved", () => {
    const f = closingFacts(
      input({
        context: ctx({
          goals: [{ activity: "Stairs", baseline: 7, current: 4, baselineOn: "2026-07-29", currentOn: "2026-08-26" }],
        }),
      }),
    );
    expect(f).toMatch(/\(fell 3\)/);
  });

  it("never contains pain — the slider's default of 0 makes it unreliable as fact", () => {
    expect(facts).not.toMatch(/pain/i);
  });

  it("describes plan decisions as neutral dated facts, not raw outcome words", () => {
    expect(facts).toMatch(/moved one exercise up its progression chain/);
    expect(facts).not.toMatch(/\bprogressed\b/);
    expect(facts).not.toMatch(/\bregressed\b/);
  });

  it("scrubs the patient's name out of free text before it leaves", () => {
    expect(facts).not.toMatch(/\bDan\b/);
    expect(facts).toMatch(/the patient moved well/);
  });

  it("carries none of the PT-only or private channels", () => {
    // Sentinels: these must not be reachable from ClosingInput at all.
    const keys = Object.keys(input()).join(" ");
    expect(keys).not.toMatch(/aiNote|ai_note|journal|privateNote|pain/i);
  });

  it("handles an episode where no plan was ever approved", () => {
    const f = closingFacts(
      input({ start: null, end: null, decisions: [], context: ctx({ planVersions: 0 }) }),
    );
    expect(f).toMatch(/Plan: none was ever approved/);
  });

  it("states what care ended on, not when it was closed", () => {
    expect(facts).toMatch(/Care ran Jul 29, 2026 to Sep 2, 2026 \(36 days\)/);
  });
});

describe("name scrubbing", () => {
  it("replaces name parts as whole words, case-insensitively", () => {
    expect(scrubNames("Dan reads this. dan, ok. Dana is different.", ["Dan"])).toBe(
      "the patient reads this. the patient, ok. Dana is different.",
    );
  });

  it("ignores very short fragments rather than mangling common words", () => {
    expect(scrubNames("go on", ["Jo"])).toBe("go on");
  });
});

describe("screening an AI draft", () => {
  const facts = closingFacts(input());
  const good =
    "This summary covers your care for Right knee, post-op, from Jul 29, 2026 to Sep 2, 2026 (36 days). You were seen in the office 3 times and logged 41 home sessions across 22 different days. Your plan began with 2 exercises and was changed 2 times along the way. On the goals you rated yourself, Climbing stairs went from 3 to 7 (it rose 4), and Walking the dog was rated 5 and not re-rated since.";

  it("passes a plain, factual draft", () => {
    expect(screenDraft(good, facts)).toEqual([]);
  });

  it.each([
    ["improved", "Your stairs improved a lot, which is great news and I am proud of the effort overall for you."],
    ["better", "You are doing better now and you are ready for the next steps in your recovery journey ahead."],
    ["recovered", "You recovered well from the surgery and have fully recovered your ability to walk the dog."],
    ["because", "Climbing stairs rose 4 because you worked hard on the home sessions every single day."],
    ["thanks to", "Thanks to your consistent effort, you logged 41 home sessions across 22 different days overall."],
    ["keep it up", "You logged 41 home sessions across 22 days. Keep it up and call if anything changes soon."],
    ["plateau", "Your stairs rating hit a plateau at 7 after rising 4 over the course of the 36 days overall."],
    ["only", "You logged only 41 home sessions across 22 different days during the 36 days of your care."],
  ])("flags evaluative or causal language: %s", (_label, text) => {
    expect(screenDraft(text, facts).some((v) => /evaluative|numbers/.test(v))).toBe(true);
  });

  it("allows the plain word 'progression' — it is a fact about the plan", () => {
    const t = `${good} One exercise moved along its progression chain.`;
    expect(screenDraft(t, facts).join()).not.toMatch(/evaluative/);
  });

  it("flags a number that isn't in the record", () => {
    const t = good.replace("41 home sessions", "47 home sessions");
    expect(screenDraft(t, facts).join()).toMatch(/numbers that are not in the record \(47\)/);
  });

  it("flags days restated as weeks — the facts only give days, so that is arithmetic", () => {
    // "5" happens to appear elsewhere in the record, so membership alone would
    // miss this; the unit is what gives it away.
    const t = good.replace("(36 days)", "(about 5 weeks)");
    expect(screenDraft(t, facts).join()).toMatch(/restates the record in weeks/);
  });

  it("flags markdown, bullets, a preamble, and length problems", () => {
    expect(screenDraft(`Here is the summary:\n\n${good}`, facts).join()).toMatch(/preamble/);
    expect(screenDraft(`- ${good}`, facts).join()).toMatch(/markdown/);
    expect(screenDraft(`**${good}**`, facts).join()).toMatch(/markdown/);
    expect(screenDraft("You logged 41 home sessions.", facts).join()).toMatch(/too short/);
    expect(screenDraft(`${good} ${"word ".repeat(CLOSING_WORDS_MAX)}`, facts).join()).toMatch(/too long/);
  });
});

describe("the offline template", () => {
  // The template is also the fallback when the model fails, so it must itself
  // pass the screen's verdict and number rules across thin and sparse records.
  const records: [string, ClosingInput][] = [
    ["full record", input()],
    ["no plan ever", input({ start: null, end: null, decisions: [], context: ctx({ planVersions: 0, goals: null }) })],
    ["no goals", input({ context: ctx({ goals: null }) })],
    ["no visits", input({ context: ctx({ visits: { count: 0, firstOn: null, lastOn: null } }) })],
    ["nothing logged", input({ context: ctx({ sessions: { daysLogged: 0, sessionsLogged: 0, flagged: 0, selfDirected: 0 } }) })],
    ["plan unchanged", input({ decisions: [], end: null })],
  ];

  it.each(records)("states no verdict and no invented number: %s", (_label, rec) => {
    const text = fixtureClosing(rec);
    const problems = screenDraft(text, closingFacts(rec)).filter((p) => !/too short/.test(p));
    expect(problems).toEqual([]);
  });

  it("is deterministic", () => {
    expect(fixtureClosing(input())).toBe(fixtureClosing(input()));
  });

  it("never mentions pain", () => {
    expect(fixtureClosing(input())).not.toMatch(/pain/i);
  });

  it("scrubs the patient's name from the condition and goals", () => {
    const text = fixtureClosing(input({ condition: "Dan's right knee" }));
    expect(text).not.toMatch(/\bDan\b/);
  });
});

describe("the system prompt holds the line", () => {
  it("forbids verdicts, causes and predictions", () => {
    expect(CLOSING_SYSTEM_PROMPT).toMatch(/Never diagnose\. Never predict\./);
    expect(CLOSING_SYSTEM_PROMPT).toMatch(/Never explain WHY a number moved/);
    expect(CLOSING_SYSTEM_PROMPT).toMatch(/Use only numbers that appear in the record/);
  });

  it("tells the model the PT writes the clinical read, not it", () => {
    expect(CLOSING_SYSTEM_PROMPT).toMatch(/PT adds their own reading/);
  });
});

describe("reading the model's tool call", () => {
  it("returns the summary text", () => {
    expect(
      extractClosingText({
        content: [{ type: "tool_use", input: { summary: "  Hello there.  " } }],
        stop_reason: "tool_use",
      }),
    ).toBe("Hello there.");
  });

  it("throws loudly on truncation, a missing tool call, or empty text", () => {
    expect(() => extractClosingText({ content: [], stop_reason: "max_tokens" })).toThrow(/truncated/);
    expect(() =>
      extractClosingText({ content: [{ type: "text", text: "I can't help with that" }], stop_reason: "end_turn" }),
    ).toThrow(/no tool call/);
    expect(() =>
      extractClosingText({ content: [{ type: "tool_use", input: { summary: "   " } }], stop_reason: "tool_use" }),
    ).toThrow(/empty/);
  });
});
