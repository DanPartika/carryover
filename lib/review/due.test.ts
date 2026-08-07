import { describe, expect, it } from "vitest";
import { effectiveWindowDays, type Compliance, type PainTrend } from "@/lib/adherence/stats";
import {
  computeReviewSignal,
  reasonLine,
  requestLabel,
  type ReviewInput,
} from "./due";

const compliance = (over: Partial<Compliance> = {}): Compliance => ({
  scorable: true,
  expected: 20,
  completed: 18,
  percent: 90,
  items: [],
  ...over,
});

const pain = (over: Partial<PainTrend> = {}): PainTrend => ({
  points: [
    { date: "2026-07-01", avgPain: 5 },
    { date: "2026-07-05", avgPain: 4 },
    { date: "2026-07-10", avgPain: 3 },
    { date: "2026-07-15", avgPain: 2 },
  ],
  start: 4.5,
  end: 2.5,
  direction: "down",
  ...over,
});

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  today: "2026-08-05",
  planApprovedOn: "2026-07-20",
  lastReviewOn: null,
  windowDays: 28,
  compliance: compliance(),
  pain: pain(),
  request: null,
  visitsSinceReview: 0,
  ...over,
});

describe("nothing to review", () => {
  it("is never due without an active plan", () => {
    const s = computeReviewSignal(input({ planApprovedOn: null }));
    expect(s.due).toBe(false);
    expect(s.line).toBe("");
    expect(s.daysOnPlan).toBeNull();
  });

  it("stays quiet in the first days of a plan, however good the numbers look", () => {
    // Five days in: real adherence, pain falling — and still nothing to say.
    // A check-in a PT didn't ask for on a week-old plan is noise.
    const s = computeReviewSignal(input({ planApprovedOn: "2026-08-01" }));
    expect(s.due).toBe(false);
    expect(s.daysOnPlan).toBe(5);
  });

  it("carries a reason line only when something is due", () => {
    expect(computeReviewSignal(input({ planApprovedOn: "2026-08-03" })).line).toBe("");
    expect(computeReviewSignal(input()).line).not.toBe("");
  });
});

describe("time trigger", () => {
  it("fires at 21 days on an unremarkable plan", () => {
    // Mid-range adherence, no pain trend: nothing in the data says anything,
    // which is exactly when a plan quietly runs past its usefulness.
    const flat = input({
      planApprovedOn: "2026-07-15",
      compliance: compliance({ percent: 65, completed: 13 }),
      pain: pain({ start: null, end: null, direction: null, points: [] }),
    });
    expect(computeReviewSignal(flat).codes).toEqual(["time"]);
    expect(computeReviewSignal({ ...flat, planApprovedOn: "2026-07-17" }).due).toBe(false);
  });

  it("counts from the last decision, not from the plan", () => {
    // Plan is two months old but the PT reviewed it a week ago and changed
    // nothing. That was a decision; don't ask again.
    const s = computeReviewSignal(
      input({
        planApprovedOn: "2026-06-06",
        lastReviewOn: "2026-07-29",
        compliance: compliance({ percent: 65 }),
        pain: pain({ start: null, end: null, direction: null, points: [] }),
      }),
    );
    expect(s.due).toBe(false);
    expect(s.daysSinceReview).toBe(7);
    expect(s.daysOnPlan).toBe(61);
  });

  it("counts the plan's age the way the scoring window does", () => {
    // Inclusive of the approval day, so this number matches the dashboard's
    // "N days, not the full 28" sitting directly beneath it. Off by one and
    // the two read as a bug.
    const s = computeReviewSignal(input({ planApprovedOn: "2026-07-20" }));
    expect(s.daysOnPlan).toBe(effectiveWindowDays(28, "2026-07-20", "2026-08-05"));
  });

  it("ignores a review older than the plan it predates", () => {
    // The review belongs to the previous plan; approving this one restarted
    // the clock, and the max() must not pick the stale date.
    const s = computeReviewSignal(
      input({ planApprovedOn: "2026-07-20", lastReviewOn: "2026-07-01" }),
    );
    expect(s.daysSinceReview).toBe(16);
  });
});

describe("data triggers", () => {
  it("fires on steady work with settled pain", () => {
    const s = computeReviewSignal(input({ planApprovedOn: "2026-07-24" }));
    expect(s.codes).toContain("steady");
    expect(s.codes).not.toContain("struggling");
  });

  it("does not call good adherence steady while pain is still high", () => {
    // 90% of every session done and pain sitting at 7 is not a plan to make
    // harder — and it is emphatically not "no signal" either.
    const s = computeReviewSignal(
      input({
        planApprovedOn: "2026-07-24",
        pain: pain({ start: 7.5, end: 7, direction: "flat" }),
      }),
    );
    expect(s.codes).not.toContain("steady");
    expect(s.due).toBe(false);
  });

  it("fires on rising pain even when every session is logged", () => {
    const s = computeReviewSignal(
      input({
        planApprovedOn: "2026-07-24",
        compliance: compliance({ percent: 100, completed: 20 }),
        pain: pain({ start: 2, end: 5, direction: "up" }),
      }),
    );
    expect(s.codes).toContain("struggling");
    expect(s.codes).not.toContain("steady");
  });

  it("fires on a plan going undone with no pain scores at all", () => {
    const s = computeReviewSignal(
      input({
        planApprovedOn: "2026-07-24",
        compliance: compliance({ percent: 20, completed: 4 }),
        pain: pain({ points: [], start: null, end: null, direction: null }),
      }),
    );
    expect(s.codes).toContain("struggling");
  });

  it("holds data triggers until the plan is old enough to read", () => {
    // 9 days: the same numbers that fire at 10 say nothing yet.
    const early = input({ planApprovedOn: "2026-07-28" });
    expect(computeReviewSignal(early).due).toBe(false);
    expect(computeReviewSignal({ ...early, planApprovedOn: "2026-07-26" }).due).toBe(true);
  });

  it("never reads adherence off an unscorable window", () => {
    // scorable=false means "too early to say", not 0% — treating the null as
    // a low score would fire "struggling" on every new plan.
    const s = computeReviewSignal(
      input({
        planApprovedOn: "2026-07-24",
        compliance: compliance({ scorable: false, expected: 0, completed: 0, percent: null }),
        pain: pain({ points: [], start: null, end: null, direction: null }),
      }),
    );
    expect(s.codes).not.toContain("struggling");
    expect(s.due).toBe(false);
  });
});

describe("visit-count trigger", () => {
  // Dan's "every 3 visits" instinct, as a fifth reason on the same chip.
  const quiet = {
    planApprovedOn: "2026-07-30", // 7 days in: time + data triggers all quiet
    compliance: compliance({ scorable: false, expected: 0, completed: 0, percent: null }),
    pain: pain({ points: [], start: null, end: null, direction: null }),
  };

  it("fires at 3 office visits since the last decision, however young the plan", () => {
    const s = computeReviewSignal(input({ ...quiet, visitsSinceReview: 3 }));
    expect(s.codes).toEqual(["visits"]);
    expect(computeReviewSignal(input({ ...quiet, visitsSinceReview: 2 })).due).toBe(false);
  });

  it("puts the count in the reason line, as a measurement", () => {
    const s = computeReviewSignal(input({ ...quiet, visitsSinceReview: 4 }));
    expect(s.line).toContain("4 visits since last review");
  });

  it("stays out of the line when it isn't the trigger", () => {
    expect(computeReviewSignal(input({ visitsSinceReview: 2 })).line).not.toContain("visits");
  });
});

describe("the patient raising a hand", () => {
  const request = { kind: "too_easy" as const, note: "bike feels easy", on: "2026-08-04" };

  it("is due immediately, whatever the numbers say", () => {
    const s = computeReviewSignal(
      input({ planApprovedOn: "2026-08-03", request, compliance: compliance({ percent: 50 }) }),
    );
    expect(s.due).toBe(true);
    expect(s.codes).toEqual(["requested"]);
    expect(s.request).toEqual(request);
  });

  it("is not silenced by a recent review", () => {
    // Reviewing resolves any open request, so an open one always post-dates
    // the last decision — the quiet period must not swallow it.
    const s = computeReviewSignal(
      input({ planApprovedOn: "2026-06-06", lastReviewOn: "2026-08-04", request }),
    );
    expect(s.due).toBe(true);
    expect(s.codes).toEqual(["requested"]);
  });
});

describe("the reason line", () => {
  it("reports measurements and nothing else", () => {
    const line = reasonLine(input(), 17);
    expect(line).toBe("17 days on this plan · 90% adherence over 28 days · pain 4.5 → 2.5");
  });

  it("names the window it actually scored, not the one that was asked for", () => {
    expect(reasonLine(input({ windowDays: 12 }), 12)).toContain("over 12 days");
  });

  it("says what is missing instead of implying a zero", () => {
    const line = reasonLine(
      input({
        compliance: compliance({ scorable: false, percent: null }),
        pain: pain({ points: [], start: null, end: null, direction: null }),
      }),
      21,
    );
    expect(line).toBe("21 days on this plan · not yet scorable · no pain scores");
  });

  it("quotes no percentage at all on a window too short to be a rate", () => {
    // A daily item on a plan approved this morning is already "0% of 1
    // expected session". True, meaningless, and read as failure.
    const line = reasonLine(
      input({ windowDays: 1, compliance: compliance({ expected: 2, completed: 0, percent: 0 }) }),
      1,
    );
    expect(line).toContain("too new to score");
    expect(line).not.toContain("0%");
  });

  it("distinguishes too-few-scores from no scores", () => {
    const line = reasonLine(
      input({
        pain: pain({ points: [{ date: "2026-08-01", avgPain: 3 }], start: null, end: null, direction: null }),
      }),
      21,
    );
    expect(line).toContain("pain scored 1 day, no trend yet");
  });

  it("never editorialises", () => {
    // The whole design rests on this: the PT reads the numbers and decides.
    const verdicts = ["ready", "should", "recommend", "progress the", "too easy", "consider"];
    const lines = [
      computeReviewSignal(input({ planApprovedOn: "2026-07-24" })).line,
      computeReviewSignal(
        input({
          planApprovedOn: "2026-07-24",
          compliance: compliance({ percent: 20 }),
          pain: pain({ start: 2, end: 6, direction: "up" }),
        }),
      ).line,
    ];
    for (const line of lines) {
      for (const v of verdicts) expect(line.toLowerCase()).not.toContain(v);
    }
  });
});

describe("request labels", () => {
  it("speaks in the patient's framing", () => {
    expect(requestLabel("too_easy")).toBe("this feels too easy now");
    expect(requestLabel("too_hard")).toBe("this is too much right now");
    expect(requestLabel("something_changed")).toBe("something has changed");
  });
});
