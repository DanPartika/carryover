import { describe, expect, it } from "vitest";
import { doneText, dosageLine, dosageText, dosageTypeOf, metPrescription } from "./dosage";

const base = { sets: null, reps: null, holdSecs: null, durationMins: null, intensity: null };

describe("dosage type inference", () => {
  it("trusts the exercise's declared type", () => {
    expect(dosageTypeOf({ ...base, dosageType: "time" })).toBe("time");
  });

  it("infers from the numbers when the type is missing (pre-0009 rows)", () => {
    expect(dosageTypeOf({ ...base, durationMins: 10 })).toBe("time");
    expect(dosageTypeOf({ ...base, holdSecs: 20 })).toBe("hold");
    expect(dosageTypeOf({ ...base, sets: 3, reps: 10 })).toBe("reps");
  });

  it("prefers the declared type over the numbers when they disagree", () => {
    // A bike row that still carries stale sets/reps must not read as reps.
    expect(dosageTypeOf({ ...base, dosageType: "time", sets: 3, reps: 15 })).toBe("time");
  });
});

describe("dosage text", () => {
  it("renders a timed item as minutes and intensity", () => {
    expect(dosageText({ ...base, dosageType: "time", durationMins: 10, intensity: "level 2" }))
      .toBe("10 min · level 2");
  });

  it("drops the intensity when none was set", () => {
    expect(dosageText({ ...base, dosageType: "time", durationMins: 15 })).toBe("15 min");
  });

  it("renders holds as sets × seconds", () => {
    expect(dosageText({ ...base, dosageType: "hold", sets: 3, holdSecs: 20 })).toBe("3 × 20s hold");
  });

  it("renders reps as sets×reps", () => {
    expect(dosageText({ ...base, dosageType: "reps", sets: 3, reps: 10 })).toBe("3×10");
  });

  it("never renders an empty dosage", () => {
    expect(dosageText({ ...base, dosageType: "reps" })).toBe("as directed");
    expect(dosageText({ ...base, dosageType: "time" })).toBe("as directed");
  });
});

describe("dosage line", () => {
  it("says daily rather than 7/wk", () => {
    expect(dosageLine({ ...base, dosageType: "reps", sets: 3, reps: 10, frequencyPerWeek: 7 }))
      .toBe("3×10 · daily");
  });

  it("otherwise counts per week", () => {
    expect(dosageLine({ ...base, dosageType: "time", durationMins: 20, frequencyPerWeek: 3 }))
      .toBe("20 min · 3/wk");
  });
});

describe("what they actually did", () => {
  const nothing = { setsDone: null, repsDone: null, durationDoneMins: null };

  it("mirrors the prescription's shape so the two can be read side by side", () => {
    expect(doneText("reps", { ...nothing, setsDone: 3, repsDone: 8 })).toBe("3×8");
    expect(doneText("time", { ...nothing, durationDoneMins: 12 })).toBe("12 min");
  });

  it("says sets for a held item, because seconds are never logged", () => {
    // The patient's logger shows "holding 20s each" and asks only how many
    // sets — inventing a duration here would be reporting data nobody entered.
    expect(doneText("hold", { ...nothing, setsDone: 2 })).toBe("2 sets");
  });

  it("falls back to marked done rather than an empty string", () => {
    expect(doneText("reps", nothing)).toBe("marked done");
    expect(doneText("time", nothing)).toBe("marked done");
  });

  it("compares reps by volume, not sets and reps separately", () => {
    const rx = { ...base, dosageType: "reps" as const, sets: 3, reps: 10 };
    expect(metPrescription("reps", rx, { ...nothing, setsDone: 2, repsDone: 15 })).toBe(true);
    expect(metPrescription("reps", rx, { ...nothing, setsDone: 3, repsDone: 8 })).toBe(false);
  });

  it("compares time by minutes and holds by sets", () => {
    expect(
      metPrescription("time", { ...base, dosageType: "time", durationMins: 10 }, { ...nothing, durationDoneMins: 12 }),
    ).toBe(true);
    expect(
      metPrescription("hold", { ...base, dosageType: "hold", sets: 3 }, { ...nothing, setsDone: 2 }),
    ).toBe(false);
  });

  it("refuses to judge what it cannot compare", () => {
    // Unprescribed care has no target, and a session logged with no numbers
    // is not a shortfall — both must read as "no comparison", never as under.
    expect(metPrescription("reps", null, { ...nothing, setsDone: 3, repsDone: 10 })).toBeNull();
    expect(metPrescription("reps", { ...base, dosageType: "reps", sets: 3, reps: 10 }, nothing)).toBeNull();
    expect(metPrescription("time", { ...base, dosageType: "time" }, { ...nothing, durationDoneMins: 5 })).toBeNull();
  });
});
