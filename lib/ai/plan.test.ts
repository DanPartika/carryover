import { describe, expect, it } from "vitest";
import {
  validateEquipmentSuggestions,
  validateItems,
  type SliceExercise,
} from "./plan";

const ex = (over: Partial<SliceExercise>): SliceExercise => ({
  id: "00000000-0000-0000-0000-000000000001",
  name: "Quad Set",
  source: "carryover",
  difficulty: 1,
  position: null,
  body_regions: ["knee"],
  equipment: [],
  home_eligible: true,
  dosage_type: "hold",
  kind: "exercise",
  ...over,
});

describe("care_timing validation", () => {
  const ice = ex({
    id: "00000000-0000-0000-0000-00000000000a",
    name: "Ice / cold pack",
    dosage_type: "time",
    kind: "modality",
  });

  it("keeps before/after on a modality", () => {
    const { items } = validateItems(
      [{ exercise_id: ice.id, frequency_per_week: 7, location: "home", rationale: "r", duration_mins: 15, care_timing: "after" }],
      [ice],
    );
    expect(items[0].care_timing).toBe("after");
  });

  it("strips timing from an exercise — squats don't happen 'after exercises'", () => {
    const quad = ex({});
    const { items } = validateItems(
      [{ exercise_id: quad.id, sets: 3, hold_secs: 20, frequency_per_week: 5, location: "home", rationale: "r", care_timing: "after" }],
      [quad],
    );
    expect(items[0].care_timing).toBeNull();
  });

  it("drops a timing value outside the vocabulary", () => {
    const { items } = validateItems(
      [{ exercise_id: ice.id, frequency_per_week: 7, location: "home", rationale: "r", duration_mins: 15, care_timing: "during" }],
      [ice],
    );
    expect(items[0].care_timing).toBeNull();
  });
});

describe("equipment suggestion validation", () => {
  const catalog = [
    { slug: "ice-pack", name: "Ice pack / ice machine" },
    { slug: "resistance-band", name: "Resistance band" },
    { slug: "heat-pad", name: "Heating pad" },
  ];

  it("keeps only real, unowned slugs, capped at two", () => {
    const out = validateEquipmentSuggestions(
      [
        { slug: "ice-pack", reason: "ice at home after sessions" },
        { slug: "peloton", reason: "invented" }, // not in catalog
        { slug: "resistance-band", reason: "banded TKE at home" },
        { slug: "heat-pad", reason: "third — over the cap" },
      ],
      catalog,
      new Set(),
    );
    expect(out.map((s) => s.slug)).toEqual(["ice-pack", "resistance-band"]);
    expect(out[0].name).toBe("Ice pack / ice machine");
  });

  it("never suggests what the patient already owns", () => {
    const out = validateEquipmentSuggestions(
      [{ slug: "ice-pack", reason: "…" }],
      catalog,
      new Set(["ice-pack"]),
    );
    expect(out).toEqual([]);
  });

  it("tolerates a missing or malformed field from the model", () => {
    expect(validateEquipmentSuggestions(undefined, catalog, new Set())).toEqual([]);
    expect(validateEquipmentSuggestions("ice-pack", catalog, new Set())).toEqual([]);
  });
});
