import { describe, expect, it } from "vitest";
import {
  computeCompliance,
  computePainTrend,
  daysBetween,
  effectiveWindowDays,
  windowStart,
  type StatItem,
  type StatLog,
} from "./stats";

const item = (over: Partial<StatItem> & { id: string }): StatItem => ({
  exerciseId: `ex-${over.id}`,
  name: over.id,
  frequencyPerWeek: 7,
  location: "home",
  ...over,
});

const log = (planItemId: string, logDate: string, over: Partial<StatLog> = {}): StatLog => ({
  planItemId,
  logDate,
  completed: true,
  pain: null,
  ...over,
});

describe("date math", () => {
  it("counts whole days between date-only strings", () => {
    expect(daysBetween("2026-07-01", "2026-07-08")).toBe(7);
    expect(daysBetween("2026-07-08", "2026-07-08")).toBe(0);
  });

  it("survives a DST boundary", () => {
    // US DST ends 2026-11-01; a local-time subtraction would give 30.96 days.
    expect(daysBetween("2026-10-25", "2026-11-25")).toBe(31);
  });

  it("clamps the window to the plan's age, inclusive of today", () => {
    expect(effectiveWindowDays(28, "2026-07-24", "2026-07-26")).toBe(3);
    expect(effectiveWindowDays(28, "2026-07-26", "2026-07-26")).toBe(1);
    expect(effectiveWindowDays(28, "2026-01-01", "2026-07-26")).toBe(28);
  });

  it("never returns a zero-length window for a plan approved in the future", () => {
    expect(effectiveWindowDays(28, "2026-08-01", "2026-07-26")).toBe(1);
  });

  it("derives the window's first day", () => {
    expect(windowStart(14, "2026-07-26")).toBe("2026-07-13");
    expect(windowStart(1, "2026-07-26")).toBe("2026-07-26");
  });
});

describe("compliance", () => {
  it("scores only home work — office items are the visit flow's business", () => {
    const items = [
      item({ id: "home-1", location: "home", frequencyPerWeek: 7 }),
      item({ id: "both-1", location: "both", frequencyPerWeek: 7 }),
      item({ id: "office-1", location: "office", frequencyPerWeek: 7 }),
    ];
    const c = computeCompliance(items, [], 7);
    expect(c.items.map((i) => i.id).sort()).toEqual(["both-1", "home-1"]);
    expect(c.expected).toBe(14);
  });

  it("prorates weekly frequency across the window", () => {
    const c = computeCompliance([item({ id: "a", frequencyPerWeek: 5 })], [], 28);
    expect(c.items[0].expected).toBe(20);
  });

  it("counts one session per calendar day, not per row", () => {
    const logs = [log("a", "2026-07-20"), log("a", "2026-07-20"), log("a", "2026-07-21")];
    const c = computeCompliance([item({ id: "a" })], logs, 7);
    expect(c.completed).toBe(2);
    expect(c.items[0].lastDone).toBe("2026-07-21");
  });

  it("ignores logs marked not-completed", () => {
    const logs = [log("a", "2026-07-20", { completed: false }), log("a", "2026-07-21")];
    expect(computeCompliance([item({ id: "a" })], logs, 7).completed).toBe(1);
  });

  it("is unscorable rather than 0% when the window is too young to expect a session", () => {
    // 2/wk over one day = 0.29 expected. Reporting "0 of 0 = 0%" would brand a
    // patient non-compliant on the day their plan was approved.
    const c = computeCompliance([item({ id: "a", frequencyPerWeek: 2 })], [], 1);
    expect(c.expected).toBe(0);
    expect(c.scorable).toBe(false);
    expect(c.percent).toBeNull();
  });

  it("reports over-compliance honestly instead of capping at 100", () => {
    const logs = ["18", "19", "20", "21", "22"].map((d) => log("a", `2026-07-${d}`));
    const c = computeCompliance([item({ id: "a", frequencyPerWeek: 3 })], logs, 7);
    expect(c.expected).toBe(3);
    expect(c.completed).toBe(5);
    expect(c.percent).toBe(167);
  });

  it("sorts the worst-adhered item first — that's what the PT is looking for", () => {
    const items = [
      item({ id: "good", frequencyPerWeek: 7 }),
      item({ id: "bad", frequencyPerWeek: 7 }),
    ];
    const logs = ["20", "21", "22", "23", "24", "25", "26"].map((d) => log("good", `2026-07-${d}`));
    const c = computeCompliance(items, logs, 7);
    expect(c.items[0].id).toBe("bad");
  });

  it("has no items and no score when the plan is office-only", () => {
    const c = computeCompliance([item({ id: "a", location: "office" })], [], 28);
    expect(c.items).toEqual([]);
    expect(c.scorable).toBe(false);
  });
});

describe("pain trend", () => {
  it("averages same-day scores and orders oldest first", () => {
    const logs = [
      log("b", "2026-07-21", { pain: 5 }),
      log("a", "2026-07-20", { pain: 4 }),
      log("b", "2026-07-20", { pain: 6 }),
    ];
    expect(computePainTrend(logs).points).toEqual([
      { date: "2026-07-20", avgPain: 5 },
      { date: "2026-07-21", avgPain: 5 },
    ]);
  });

  it("omits days with no pain score rather than scoring them zero", () => {
    const logs = [log("a", "2026-07-20", { pain: null }), log("a", "2026-07-21", { pain: 3 })];
    const t = computePainTrend(logs);
    expect(t.points).toEqual([{ date: "2026-07-21", avgPain: 3 }]);
  });

  it("stays silent about direction until four days of data exist", () => {
    const logs = ["20", "21", "22"].map((d) => log("a", `2026-07-${d}`, { pain: 5 }));
    const t = computePainTrend(logs);
    expect(t.points).toHaveLength(3);
    expect(t.direction).toBeNull();
    expect(t.start).toBeNull();
  });

  it("compares halves, so one bad morning is not a trend", () => {
    const pains = [3, 3, 3, 3, 3, 9]; // last day spikes
    const logs = pains.map((p, i) => log("a", `2026-07-2${i}`, { pain: p }));
    const t = computePainTrend(logs);
    expect(t.start).toBe(3);
    expect(t.end).toBe(5); // (3+3+9)/3
    expect(t.direction).toBe("up");
  });

  it("reads a genuine improvement as down", () => {
    const pains = [7, 6, 7, 3, 2, 3];
    const logs = pains.map((p, i) => log("a", `2026-07-2${i}`, { pain: p }));
    const t = computePainTrend(logs);
    expect(t.direction).toBe("down");
    expect(t.start).toBeGreaterThan(t.end!);
  });

  it("calls a sub-point wobble flat", () => {
    const pains = [4, 4, 5, 4, 4, 4];
    const logs = pains.map((p, i) => log("a", `2026-07-2${i}`, { pain: p }));
    expect(computePainTrend(logs).direction).toBe("flat");
  });
});
