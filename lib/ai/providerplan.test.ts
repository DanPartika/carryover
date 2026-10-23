import { describe, expect, it } from "vitest";
import {
  buildDraftUserMessage,
  draftSystemPrompt,
  formatProviderPlan,
  HISTORY_RULES,
  PROVIDER_PLAN_RULES,
  type IntakeForPrompt,
  type PriorCare,
  type ProgressContext,
  type SliceExercise,
} from "./plan";

// The doctor's plan LIMITS a draft; it never makes one bolder. These pin the
// structure that keeps it a constraint: where it sits, when it appears, and
// that a prompt without one is exactly what it was before this existed.

const base: IntakeForPrompt = {
  condition: "Left knee cartilage repair",
  body_regions: ["knee"],
  onset_date: "2026-10-12",
  pain_now: 3,
  pain_worst: 6,
  goals: null,
  restrictions: null,
  narrative: null,
};

const slice: SliceExercise[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Quad Set",
    source: "carryover",
    difficulty: 1,
    position: "supine",
    body_regions: ["knee"],
    equipment: [],
    home_eligible: true,
    dosage_type: "hold",
    kind: "exercise",
  },
];

const ORDERS = "Weight Bearing Status: No weight bearing for 6 weeks.\nPathway B, phase 1: ankle pumps, quad sets.";
const withOrders: IntakeForPrompt = { ...base, provider_plan: ORDERS, today: "2026-10-22" };

const progress: ProgressContext = {
  daysOnPlan: 12,
  facts: "adherence facts",
  current: [{ exerciseId: slice[0].id, name: "Quad Set", line: "3×5s hold · home" }],
  request: null,
  ptNote: null,
  progressions: [],
};

const build = (intake: IntakeForPrompt, p?: ProgressContext, history?: PriorCare[]) =>
  buildDraftUserMessage({ intake, equipmentNames: [], catalog: [], slice, progress: p, history });

describe("the doctor's plan in the draft", () => {
  it("is absent without one — the prompt is byte-for-byte what it was", () => {
    expect(build(base)).toBe(build({ ...base, provider_plan: null, today: "2026-10-22" }));
    expect(build(base)).toBe(build({ ...base, provider_plan: "   \n ", today: "2026-10-22" }));
    expect(build(base)).not.toContain("REFERRING PROVIDER");
    expect(formatProviderPlan(base)).toBe("");
    expect(draftSystemPrompt(undefined, undefined)).toBe(draftSystemPrompt(undefined, undefined, false));
    expect(draftSystemPrompt(undefined, undefined)).not.toContain("REFERRING PROVIDER");
  });

  it("renders a labelled block with today's date, after the intake and before equipment", () => {
    const msg = build(withOrders);
    expect(msg).toContain("REFERRING PROVIDER'S PLAN");
    expect(msg).toContain("Today is 2026-10-22.");
    expect(msg).toContain(ORDERS);
    expect(msg.indexOf("INTAKE")).toBeLessThan(msg.indexOf("REFERRING PROVIDER"));
    expect(msg.indexOf("REFERRING PROVIDER")).toBeLessThan(msg.indexOf("PATIENT HOME EQUIPMENT"));
  });

  it("omits the date line when the caller gave none, and still renders the orders", () => {
    const msg = build({ ...base, provider_plan: ORDERS });
    expect(msg).toContain(ORDERS);
    expect(msg).not.toContain("Today is");
  });

  it("binds a revamp as much as a first draft", () => {
    expect(build(withOrders, progress)).toContain(ORDERS);
    expect(draftSystemPrompt(progress, undefined, true)).toContain(PROVIDER_PLAN_RULES);
    expect(draftSystemPrompt(undefined, undefined, true)).toContain(PROVIDER_PLAN_RULES);
  });

  it("stacks with prior care without disturbing it", () => {
    const prior: PriorCare[] = [{ condition: "Right knee", closedYear: 2024, watchFor: "no deep squats" }];
    const sys = draftSystemPrompt(undefined, prior, true);
    expect(sys).toContain(HISTORY_RULES);
    expect(sys).toContain(PROVIDER_PLAN_RULES);
    expect(sys.indexOf(HISTORY_RULES)).toBeLessThan(sys.indexOf(PROVIDER_PLAN_RULES));
    const msg = build(withOrders, undefined, prior);
    expect(msg).toContain("REFERRING PROVIDER");
    expect(msg).toContain("PRIOR CARE");
  });
});

describe("the rules keep the orders a limit", () => {
  it("treat them as limits, choose the earlier phase when unsure, and show the working", () => {
    expect(PROVIDER_PLAN_RULES).toMatch(/LIMITS you must stay inside/);
    expect(PROVIDER_PLAN_RULES).toMatch(/earlier, more restricted one/);
    expect(PROVIDER_PLAN_RULES).toMatch(/orders win/i);
    expect(PROVIDER_PLAN_RULES).toMatch(/pt_note \(PT-only\)/);
  });

  it("don't invent a protocol that was only named, and take the stricter of two readings", () => {
    expect(PROVIDER_PLAN_RULES).toMatch(/do not fill them in from memory/);
    expect(PROVIDER_PLAN_RULES).toMatch(/named a protocol|NAME a protocol/);
    expect(PROVIDER_PLAN_RULES).toMatch(/MORE restrictive/);
    expect(PROVIDER_PLAN_RULES).toMatch(/Never pick the looser reading/);
  });

  it("never let the orders set the dose, and keep them out of what the patient reads", () => {
    expect(PROVIDER_PLAN_RULES).toMatch(/do not tell you how much to prescribe/);
    expect(PROVIDER_PLAN_RULES).toMatch(/never quote the orders/);
  });
});
