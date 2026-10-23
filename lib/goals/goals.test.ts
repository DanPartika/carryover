import { describe, expect, it } from "vitest";
import { cleanIdeas, GENERAL_IDEAS, screenIdea, STARTER_IDEAS, starterIdeas } from "./ideas";
import { goalKey, GOAL_TEXT_MAX, MAX_GOALS, parseNewGoal } from "./model";

describe("parseNewGoal", () => {
  it("accepts a plain goal and a whole-number rating", () => {
    expect(parseNewGoal({ activity: "Sleeping through the night", rating: 4 })).toEqual({
      activity: "Sleeping through the night",
      rating: 4,
    });
  });

  it("collapses whitespace and strips control characters", () => {
    expect(parseNewGoal({ activity: "  climbing \n\t stairs\u0007 ", rating: "7" })).toEqual({
      activity: "climbing stairs",
      rating: 7,
    });
  });

  it("rounds a fractional rating and keeps the edges", () => {
    expect(parseNewGoal({ activity: "x y", rating: 6.6 })?.rating).toBe(7);
    expect(parseNewGoal({ activity: "x y", rating: 0 })?.rating).toBe(0);
    expect(parseNewGoal({ activity: "x y", rating: 10 })?.rating).toBe(10);
  });

  it("refuses a goal with nothing to it or no rating of its own", () => {
    expect(parseNewGoal({ activity: "   ", rating: 5 })).toBeNull();
    expect(parseNewGoal({ activity: "stairs" })).toBeNull();
    // A missing rating must never quietly become a 0 ("can't do it at all").
    expect(parseNewGoal({ activity: "stairs", rating: null })).toBeNull();
    expect(parseNewGoal({ activity: "stairs", rating: "" })).toBeNull();
    expect(parseNewGoal({ activity: "stairs", rating: 11 })).toBeNull();
    expect(parseNewGoal({ activity: "stairs", rating: -1 })).toBeNull();
    expect(parseNewGoal({ activity: "stairs", rating: "lots" })).toBeNull();
    expect(parseNewGoal({ activity: 42, rating: 5 })).toBeNull();
    expect(parseNewGoal(null)).toBeNull();
    expect(parseNewGoal("stairs")).toBeNull();
  });

  it("caps the text at what the database column accepts", () => {
    const long = parseNewGoal({ activity: "a".repeat(500), rating: 3 });
    expect(long?.activity.length).toBe(GOAL_TEXT_MAX);
  });
});

describe("goalKey", () => {
  it("treats case and spacing as the same goal", () => {
    expect(goalKey("  Sleeping   through the NIGHT ")).toBe(goalKey("sleeping through the night"));
    expect(goalKey("stairs")).not.toBe(goalKey("stair"));
  });

  it("the list holds enough for the intake's three plus several more", () => {
    expect(MAX_GOALS).toBeGreaterThan(3);
  });
});

describe("starterIdeas", () => {
  it("serves the regions asked for, round-robin, never past the limit", () => {
    const out = starterIdeas(["spine", "hip"], [], 6);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe(STARTER_IDEAS.spine[0]);
    expect(out[1]).toBe(STARTER_IDEAS.hip[0]);
    expect(new Set(out.map(goalKey)).size).toBe(out.length);
  });

  it("leaves out what is already a goal, however it was typed", () => {
    const out = starterIdeas(["knee"], ["  CLIMBING stairs "], 10);
    expect(out.map(goalKey)).not.toContain("climbing stairs");
  });

  it("falls back to the general list for a region it has nothing for", () => {
    const out = starterIdeas(["not_a_region"], [], 3);
    expect(out).toEqual(GENERAL_IDEAS.slice(0, 3));
    expect(starterIdeas([], [], 2)).toEqual(GENERAL_IDEAS.slice(0, 2));
  });

  it("is stable, so the chips never shuffle between renders", () => {
    expect(starterIdeas(["knee", "ankle_foot"])).toEqual(starterIdeas(["knee", "ankle_foot"]));
  });
});

describe("the fixed lists obey the same rules the model's ideas must", () => {
  const all = [...Object.values(STARTER_IDEAS).flat(), ...GENERAL_IDEAS];
  it.each(all.map((i) => ({ i })))("$i", ({ i }) => {
    expect(screenIdea(i)).toBe(i);
  });
});

describe("screenIdea", () => {
  it("cleans and capitalises a good idea", () => {
    expect(screenIdea("  getting in and out of the car. ")).toBe("Getting in and out of the car");
  });

  it("drops anything that isn't a plain activity", () => {
    for (const bad of [
      "",
      "Run",
      "x".repeat(80),
      "Walk 10,000 steps",
      "Run a 5k by week 8",
      "Be pain-free",
      "You should rest more",
      "Heal fully",
      "Full recovery",
      "**Climbing stairs**",
      "Stairs: up and down",
      "Back to normal",
      "Walking again within six weeks",
      "A very long and rambling goal that goes on and on about nothing in particular here",
      "Ready to progress",
      "See https://example.com/x",
    ]) {
      expect(screenIdea(bad), bad).toBeNull();
    }
    expect(screenIdea(42)).toBeNull();
    expect(screenIdea(null)).toBeNull();
  });

  it("keeps ordinary phrases that merely contain a time word as a noun", () => {
    expect(screenIdea("A full day at work")).toBe("A full day at work");
  });
});

describe("cleanIdeas", () => {
  it("screens, de-duplicates, drops existing goals and honours the limit", () => {
    const out = cleanIdeas(
      [
        "Climbing stairs",
        "climbing  stairs",
        "Sleeping through the night",
        "Run 5k in 8 weeks",
        "Getting dressed",
        "Driving to work",
        "Carrying the shopping",
        "Walking the dog",
      ],
      ["sleeping through the night"],
      4,
    );
    expect(out).toEqual(["Climbing stairs", "Getting dressed", "Driving to work", "Carrying the shopping"]);
  });

  it("answers an empty list for anything that isn't a list", () => {
    expect(cleanIdeas("Climbing stairs")).toEqual([]);
    expect(cleanIdeas(undefined)).toEqual([]);
  });
});
