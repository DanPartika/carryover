import { describe, expect, it } from "vitest";
import { dosageLine, dosageText, dosageTypeOf } from "./dosage";

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
