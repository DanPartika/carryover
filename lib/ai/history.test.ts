import { describe, expect, it } from "vitest";
import {
  buildDraftUserMessage,
  draftSystemPrompt,
  formatHistory,
  HISTORY_RULES,
  historyEchoes,
  type IntakeForPrompt,
  type PriorCare,
  type ProgressContext,
  type SliceExercise,
} from "./plan";

// Dan's rule, in his words: "every time the same patient comes in, that patient
// has different issues. Just because last time by week 6 they were doing lunges
// doesn't mean this round they will be doing lunges by week 6." These tests pin
// the structure that makes history context and never a template.

const intake: IntakeForPrompt = {
  condition: "Left shoulder pain",
  body_regions: ["shoulder"],
  onset_date: "2026-09-01",
  pain_now: 4,
  pain_worst: 7,
  goals: "reach a high shelf",
  restrictions: null,
  narrative: null,
};

const slice: SliceExercise[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Pendulum",
    source: "carryover",
    difficulty: 1,
    position: null,
    body_regions: ["shoulder"],
    equipment: [],
    home_eligible: true,
    dosage_type: "reps",
    kind: "exercise",
  },
];

const prior: PriorCare[] = [
  {
    condition: "Right knee, post-op",
    closedYear: 2024,
    watchFor: "pain with deep squats; no kneeling on hard floors",
  },
];

const build = (history?: PriorCare[], progress?: ProgressContext) =>
  buildDraftUserMessage({ intake, equipmentNames: [], catalog: [], slice, history, progress });

describe("prior care in the first draft", () => {
  it("is absent when there is no history — the prompt is what it was before", () => {
    expect(build(undefined)).toBe(build([]));
    expect(build(undefined)).not.toContain("PRIOR CARE");
    expect(draftSystemPrompt(undefined, undefined)).not.toContain("PRIOR CARE");
  });

  it("ignores a prior episode with nothing to watch for — no block, no rules", () => {
    const blank: PriorCare[] = [{ condition: "Right knee", closedYear: 2024, watchFor: "  " }];
    expect(formatHistory(blank)).toBe("");
    expect(build(blank)).toBe(build(undefined));
    expect(draftSystemPrompt(undefined, blank)).toBe(draftSystemPrompt(undefined, undefined));
  });

  it("carries only the condition, the year, and the PT's watch-for line", () => {
    const block = formatHistory(prior);
    expect(block).toContain("Right knee, post-op");
    expect(block).toContain("closed 2024");
    expect(block).toContain("pain with deep squats");
    // No dates beyond the year, no durations, no plan or exercise content.
    expect(block).not.toMatch(/\b(week|month|day|session)s?\b/i);
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("never carries a trajectory: the closing-summary story is not an input", () => {
    // The PriorCare shape has no field for it — the point of the type. A summary
    // line like this must not be reachable from anything history() accepts.
    const smuggled = "by week 6 you were doing lunges";
    const msg = build(prior);
    expect(msg).not.toContain(smuggled);
    expect(Object.keys(prior[0]).sort()).toEqual(["closedYear", "condition", "watchFor"]);
  });

  it("sits AFTER the intake, so today's evidence leads", () => {
    const msg = build(prior);
    expect(msg.indexOf("INTAKE")).toBeGreaterThanOrEqual(0);
    expect(msg.indexOf("PRIOR CARE")).toBeGreaterThan(msg.indexOf("INTAKE"));
    expect(msg.indexOf("PRIOR CARE")).toBeLessThan(msg.indexOf("PATIENT HOME EQUIPMENT"));
  });

  it("labels each prior episode a DIFFERENT problem and not evidence about today", () => {
    expect(formatHistory(prior)).toMatch(/DIFFERENT problem/);
    expect(formatHistory(prior)).toMatch(/NOT evidence about today/);
  });

  it("is dropped entirely from a revamp — six weeks of evidence about now wins", () => {
    const progress: ProgressContext = {
      daysOnPlan: 30,
      facts: "adherence facts",
      current: [{ exerciseId: slice[0].id, name: "Pendulum", line: "3x10" }],
      request: null,
      ptNote: null,
      progressions: [],
    };
    const msg = build(prior, progress);
    expect(msg).not.toContain("PRIOR CARE");
    expect(msg).not.toContain("pain with deep squats");
    expect(draftSystemPrompt(progress, prior)).not.toContain("PRIOR CARE");
  });
});

describe("the rule is asymmetric — history can only make a draft more careful", () => {
  const sys = draftSystemPrompt(undefined, prior);

  it("attaches the rules to a first draft that has history", () => {
    expect(sys).toContain(HISTORY_RULES);
  });

  it("forbids raising level, dose, frequency or pace from history", () => {
    expect(HISTORY_RULES).toMatch(/only make you MORE careful/);
    expect(HISTORY_RULES).toMatch(/never raise a starting level, dose, frequency or pace/);
  });

  it("forbids choosing an item because it worked before, or copying an earlier plan", () => {
    expect(HISTORY_RULES).toMatch(/never be the reason you pick an item/);
    expect(HISTORY_RULES).toMatch(/never be copied from an earlier plan/);
  });

  it("starts the draft from the intake, not from how a past round went", () => {
    expect(HISTORY_RULES).toMatch(/starts where the INTAKE says the patient is today/);
    expect(HISTORY_RULES).toMatch(/people do not recover the same way twice/);
  });

  it("keeps earlier care out of everything the patient reads", () => {
    expect(HISTORY_RULES).toMatch(/pt_note only/);
    expect(HISTORY_RULES).toMatch(/rationale or equipment_suggestions reason/);
  });
});

describe("catching an echo of earlier care in patient-facing text", () => {
  it("flags phrases that talk about earlier care", () => {
    expect(historyEchoes(["Gentle pendulum swings, like last time."])).toHaveLength(1);
    expect(historyEchoes(["You tolerated this previously."])).toHaveLength(1);
    expect(historyEchoes(["Skip overhead work, as before."])).toHaveLength(1);
    expect(historyEchoes(["Same as your last episode."])).toHaveLength(1);
  });

  it("leaves ordinary rationales alone — no false alarm on plain clinical prose", () => {
    expect(
      historyEchoes([
        "Warm up the shoulder before loading it.",
        "Builds control of the shoulder blade.",
        "A gentle start while it is still sore.",
        "Performed daily for the first two weeks, then reassessed.",
      ]),
    ).toEqual([]);
  });
});
