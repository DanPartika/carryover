// The corridor seeds are content, and content rots quietly: a typo'd region
// slug filters an exercise out of every AI draft, a dangling progression key
// silently drops the edge, and a missing art file falls back to the emoji
// forever. This suite makes each of those a red test instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CORRIDOR_DIR = path.join(process.cwd(), "db", "seeds", "corridors");
const ART_DIR = path.join(process.cwd(), "public", "exercise-art");

// Must mirror the app's vocabularies (lib/intake/fields REGION_OPTIONS slugs,
// the 0002 position CHECK, the equipment_catalog seeds, lib/dosage).
const REGIONS = new Set([
  "neck", "shoulder", "elbow", "wrist_hand", "spine",
  "core", "hip", "knee", "ankle_foot", "full_body",
]);
const POSITIONS = new Set(["standing", "seated", "supine", "prone", "side_lying", "quadruped"]);
const EQUIPMENT = new Set([
  "ankle-weights", "balance-pad", "barbell", "cable-machine", "chair",
  "cold-compression", "compression-boots", "dumbbell", "exercise-ball",
  "ez-curl-bar", "foam-roller", "heat-pad", "ice-pack", "kettlebell",
  "machine", "medicine-ball", "none", "other", "resistance-band",
  "stationary-bike", "step", "tens-unit", "towel", "wall",
]);
const DOSAGE_TYPES = new Set(["reps", "hold", "time"]);
const MODALITY_KEYS = [
  "modality-ice", "modality-heat", "modality-tens",
  "modality-compression-boots", "modality-cold-compression", "modality-elevation",
];

type Corridor = {
  exercises: {
    key: string; name: string; position: string; difficulty: number;
    dosage_type?: string; body_regions: string[]; tags: string[];
    equipment: string[]; instructions: string[];
  }[];
  progressions: { from: string; to: string; note: string }[];
};

const files = readdirSync(CORRIDOR_DIR).filter((f) => f.endsWith(".json")).sort();
const corridors = files.map((f) => ({
  file: f,
  data: JSON.parse(readFileSync(path.join(CORRIDOR_DIR, f), "utf8")) as Corridor,
}));

describe("corridor seeds", () => {
  it("found the corridor files", () => {
    expect(files).toContain("knee-core.json");
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it.each(corridors)("$file uses only vocabulary values", ({ data }) => {
    for (const e of data.exercises) {
      expect(e.key, e.key).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.trim().length).toBeGreaterThan(0);
      expect(POSITIONS.has(e.position), `${e.key} position ${e.position}`).toBe(true);
      expect(Number.isInteger(e.difficulty) && e.difficulty >= 1 && e.difficulty <= 5,
        `${e.key} difficulty ${e.difficulty}`).toBe(true);
      if (e.dosage_type !== undefined) {
        expect(DOSAGE_TYPES.has(e.dosage_type), `${e.key} dosage ${e.dosage_type}`).toBe(true);
      }
      expect(e.body_regions.length).toBeGreaterThan(0);
      for (const r of e.body_regions) expect(REGIONS.has(r), `${e.key} region ${r}`).toBe(true);
      expect(e.equipment.length).toBeGreaterThan(0);
      for (const q of e.equipment) expect(EQUIPMENT.has(q), `${e.key} equipment ${q}`).toBe(true);
      expect(e.tags.length).toBeGreaterThanOrEqual(2);
      expect(e.instructions.length).toBeGreaterThanOrEqual(3);
      expect(e.instructions.length).toBeLessThanOrEqual(5);
      for (const step of e.instructions) expect(step.trim().length).toBeGreaterThan(0);
    }
  });

  it("keys are unique across ALL corridor files (they share one source namespace)", () => {
    const seen = new Map<string, string>();
    for (const { file, data } of corridors) {
      for (const e of data.exercises) {
        expect(seen.has(e.key), `${e.key} in both ${seen.get(e.key)} and ${file}`).toBe(false);
        seen.set(e.key, file);
      }
    }
  });

  it.each(corridors)("$file progression edges resolve and form real chains", ({ data }) => {
    const keys = new Set(data.exercises.map((e) => e.key));
    for (const p of data.progressions) {
      expect(keys.has(p.from), `dangling from ${p.from}`).toBe(true);
      expect(keys.has(p.to), `dangling to ${p.to}`).toBe(true);
      expect(p.from).not.toBe(p.to);
      expect(p.note.trim().length).toBeGreaterThan(0);
    }
    expect(data.progressions.length).toBeGreaterThanOrEqual(5);
  });

  it("every corridor exercise and every modality has its owned art file", () => {
    const wanted = [
      ...corridors.flatMap(({ data }) => data.exercises.map((e) => e.key)),
      ...MODALITY_KEYS,
    ];
    for (const key of wanted) {
      expect(
        () => statSync(path.join(ART_DIR, `${key}.svg`)),
        `missing art: ${key}.svg`,
      ).not.toThrow();
    }
  });
});

describe("exercise art", () => {
  const svgs = readdirSync(ART_DIR).filter((f) => f.endsWith(".svg"));

  it("exists at all", () => {
    expect(svgs.length).toBeGreaterThan(0);
  });

  it.each(svgs.map((f) => ({ f })))("$f obeys the line-art spec", ({ f }) => {
    const body = readFileSync(path.join(ART_DIR, f), "utf8");
    expect(body.trimStart().startsWith('<svg viewBox="0 0 240 180"'), "viewBox").toBe(true);
    expect(body).not.toMatch(/<text/i);
    expect(body).not.toMatch(/<image/i);
    expect(body).not.toMatch(/gradient/i);
    // Palette lockdown: any hex outside the three approved colors is a defect.
    const ALLOWED = new Set(["#44403A", "#2E7D4F", "#B8B2A8"]);
    for (const hex of body.match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
      expect(ALLOWED.has(hex.toUpperCase()), `color ${hex} in ${f}`).toBe(true);
    }
    expect(body.length, "keep art lean — it ships to phones").toBeLessThan(4000);
  });
});
