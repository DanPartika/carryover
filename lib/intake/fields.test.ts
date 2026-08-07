import { describe, expect, it } from "vitest";
import { parseIntakeFields, parseLimitedActivities } from "./fields";

describe("parseLimitedActivities", () => {
  it("keeps at most three, trimmed and range-checked", () => {
    const out = parseLimitedActivities([
      { activity: "  climbing stairs  ", rating: 4 },
      { activity: "sleeping", rating: 11 }, // out of range — dropped
      { activity: "", rating: 5 }, // empty — dropped
      { activity: "work", rating: 6 },
      { activity: "golf", rating: 7 },
      { activity: "a fourth thing", rating: 8 }, // over the cap
    ]);
    expect(out).toEqual([
      { activity: "climbing stairs", rating: 4 },
      { activity: "work", rating: 6 },
      { activity: "golf", rating: 7 },
    ]);
  });

  it("returns null for garbage or nothing usable", () => {
    expect(parseLimitedActivities("stairs")).toBeNull();
    expect(parseLimitedActivities([{ activity: "x", rating: "high" }])).toBeNull();
  });
});

describe("parseIntakeFields", () => {
  it("accepts only vocabulary values on the enums and slug arrays", () => {
    const f = parseIntakeFields({
      side: "right",
      onsetKind: "surgically", // not in vocabulary
      trajectory: "improving",
      painPattern: "constant",
      worstTime: "3am", // not in vocabulary
      conditions: ["diabetes", "vibes", "diabetes"],
      redFlags: ["night_pain_constant", "made_up"],
      bodyRegions: ["knee", "soul"],
    });
    expect(f.side).toBe("right");
    expect(f.onsetKind).toBeNull();
    expect(f.trajectory).toBe("improving");
    expect(f.painPattern).toBe("constant");
    expect(f.worstTime).toBeNull();
    expect(f.conditions).toEqual(["diabetes"]);
    expect(f.redFlags).toEqual(["night_pain_constant"]);
    expect(f.bodyRegions).toEqual(["knee"]);
  });

  it("range-checks the numbers and null-passes blanks", () => {
    const f = parseIntakeFields({ painAvg: 12, painNow: "6", birthYear: 1962, hadBefore: true });
    expect(f.painAvg).toBeNull();
    expect(f.painNow).toBe(6);
    expect(f.birthYear).toBe(1962);
    expect(f.hadBefore).toBe(true);
    expect(f.nightPain).toBeNull();
  });

  it("trims free text and turns empty strings into nulls", () => {
    const f = parseIntakeFields({ aggravators: "  stairs  ", easers: "   " });
    expect(f.aggravators).toBe("stairs");
    expect(f.easers).toBeNull();
  });
});
