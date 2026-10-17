import { describe, expect, it } from "vitest";
import type { ClosingContext } from "./closing";
import { isDay } from "./closing";
import { forPatient, type PastEpisode } from "./history";
import { patientPlan, patientStats } from "./shape";

const context: ClosingContext = {
  version: 1,
  openedOn: "2026-07-29",
  endedOn: "2026-09-02",
  daysInCare: 36,
  planVersions: 3,
  checkIns: 2,
  adherence: { scorable: true, completed: 41, expected: 60, percent: 68, windowDays: 36 },
  sessions: { daysLogged: 22, sessionsLogged: 41, flagged: 7, selfDirected: 3 },
  pain: { start: 4.5, end: 2, direction: "down", daysScored: 18 },
  goals: [
    { activity: "Climbing stairs", baseline: 3, current: 7, baselineOn: "2026-07-29", currentOn: "2026-08-26" },
  ],
  visits: { count: 3, firstOn: "2026-08-02", lastOn: "2026-08-20" },
};

const episode: PastEpisode = {
  id: "11111111-1111-1111-1111-111111111111",
  clinicId: "22222222-2222-2222-2222-222222222222",
  condition: "Right knee, post-op",
  openedOn: "2026-07-29",
  endedOn: "2026-09-02",
  closedOn: "2026-10-16",
  closedAt: "2026-10-16 15:00:00+00",
  recent: true,
  closedByName: "Dana PT",
  aiAssisted: true,
  summary: "Care for the right knee ran five weeks.",
  watchFor: "SENTINEL-WATCH-FOR pain with deep squats",
  context,
  startPlan: { approvedOn: "2026-08-01", items: [] },
  finalPlan: {
    approvedOn: "2026-08-20",
    items: [{ name: "Mini Squat", line: "3×10 · 5/wk", location: "home", kind: "exercise" }],
  },
  intake: {
    id: "i",
    authorUserId: "u",
    condition: "SENTINEL-INTAKE",
    restrictions: "SENTINEL-RESTRICTIONS no weight bearing",
    redFlags: ["SENTINEL-REDFLAG"],
  } as unknown as PastEpisode["intake"],
  reopenableUntil: "2026-10-19 15:00:00+00",
};

describe("what a patient sees of their own closed episode", () => {
  const json = JSON.stringify(forPatient(episode, [{ on: "2026-08-05", body: "Ice after every session." }]));

  it("never includes the PT-only fields, whatever the PT shape gains later", () => {
    // Sentinels planted in every PT-only field: none may reach the patient.
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toMatch(/watchFor|restrictions|redFlags|intake/);
    expect(json).not.toMatch(/adherence|percent|expected/);
    expect(json).not.toMatch(/"pain"|painStart|daysScored/);
    expect(json).not.toMatch(/flagged|checkIns|selfDirected|planVersions/);
    expect(json).not.toMatch(/reopenableUntil|aiAssisted|clinicId|closedAt/);
  });

  it("carries the summary, the plain counts and the shared messages", () => {
    const p = forPatient(episode, [{ on: "2026-08-05", body: "Ice after every session." }]);
    expect(p.summary).toBe("Care for the right knee ran five weeks.");
    expect(p.stats).toEqual({
      daysInCare: 36,
      daysLogged: 22,
      sessionsLogged: 41,
      visits: 3,
      goals: [{ activity: "Climbing stairs", baseline: 3, current: 7 }],
    });
    expect(p.messages).toEqual([{ on: "2026-08-05", body: "Ice after every session." }]);
    expect(p.finalPlan?.items).toEqual([
      { name: "Mini Squat", line: "3×10 · 5/wk", location: "home" },
    ]);
  });

  it("exposes only the allowlisted keys", () => {
    expect(Object.keys(patientStats(context)).sort()).toEqual([
      "daysInCare",
      "daysLogged",
      "goals",
      "sessionsLogged",
      "visits",
    ]);
    expect(Object.keys(patientPlan(episode.finalPlan!)).sort()).toEqual(["approvedOn", "items"]);
  });

  it("copes with an episode that never had a plan or frozen numbers", () => {
    const bare = forPatient({ ...episode, context: null, finalPlan: null, startPlan: null });
    expect(bare.stats).toBeNull();
    expect(bare.finalPlan).toBeNull();
    expect(bare.messages).toEqual([]);
  });
});

describe("clinic-day strings", () => {
  it("accepts real dates and rejects the rest", () => {
    expect(isDay("2026-10-16")).toBe(true);
    expect(isDay("2026-13-45")).toBe(false);
    expect(isDay("10/16/2026")).toBe(false);
    expect(isDay(undefined)).toBe(false);
    expect(isDay(20261016)).toBe(false);
  });
});
