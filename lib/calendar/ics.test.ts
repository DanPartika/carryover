import { describe, expect, it } from "vitest";
import { buildPatientFeed, type FeedItem } from "./ics";

const item = (over: Partial<FeedItem>): FeedItem => ({
  name: "Quad Set",
  kind: "exercise",
  careTiming: null,
  dosageType: "reps",
  sets: 3,
  reps: 10,
  holdSecs: null,
  durationMins: null,
  intensity: null,
  frequencyPerWeek: 7,
  ...over,
});

const PLAN = "00000000-0000-0000-0000-00000000000p";

describe("buildPatientFeed", () => {
  it("emits one daily recurring all-day event carrying the whole program", () => {
    const ics = buildPatientFeed({
      calendarName: "Carryover — Dan",
      planId: PLAN,
      anchorDay: "2026-08-01",
      items: [item({}), item({ name: "Step-Down", frequencyPerWeek: 3 })],
    });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("RRULE:FREQ=DAILY");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260801");
    expect(ics).toContain("DTEND;VALUE=DATE:20260802");
    expect(ics).toContain("SUMMARY:↪ PT home program — 2 to do");
    // Dosage + frequency ride in the description, the app's own wording.
    expect(ics).toContain("Quad Set — 3×10 · daily");
    expect(ics).toContain("Step-Down — 3×10 · 3/wk");
    expect(ics).toContain("TRANSP:TRANSPARENT");
  });

  it("orders care around the exercises the way Today does", () => {
    const ics = buildPatientFeed({
      calendarName: "Carryover",
      planId: PLAN,
      anchorDay: "2026-08-01",
      items: [
        item({ name: "Ice / cold pack", kind: "modality", careTiming: "after", dosageType: "time", sets: null, reps: null, durationMins: 15 }),
        item({}),
        item({ name: "Heat", kind: "modality", careTiming: "before", dosageType: "time", sets: null, reps: null, durationMins: 10 }),
      ],
    });
    const desc = ics.slice(ics.indexOf("DESCRIPTION"));
    const before = desc.indexOf("Before you start:");
    const main = desc.indexOf("Your exercises:");
    const after = desc.indexOf("After you finish:");
    expect(before).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(main);
  });

  it("is a valid empty calendar when there is no plan or no home items", () => {
    for (const opts of [
      { calendarName: "Carryover", planId: null, anchorDay: null, items: [item({})] },
      { calendarName: "Carryover", planId: PLAN, anchorDay: "2026-08-01", items: [] },
    ]) {
      const ics = buildPatientFeed(opts);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("END:VCALENDAR");
      expect(ics).not.toContain("BEGIN:VEVENT");
    }
  });

  it("escapes commas and semicolons in user-named exercises", () => {
    const ics = buildPatientFeed({
      calendarName: "Carryover",
      planId: PLAN,
      anchorDay: "2026-08-01",
      items: [item({ name: "Ice, then rest; elevate" })],
    });
    expect(ics).toContain("Ice\\, then rest\\; elevate");
  });

  it("is byte-identical across fetches of the same plan state", () => {
    const opts = {
      calendarName: "Carryover — Dan",
      planId: PLAN,
      anchorDay: "2026-08-01",
      items: [item({})],
    };
    expect(buildPatientFeed(opts)).toBe(buildPatientFeed(opts));
  });
});
