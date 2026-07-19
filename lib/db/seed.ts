// Boot-time library seeding (clientfirst pattern: idempotent, runs after
// migrations in instrumentation.ts). Two sources:
//   1. free-exercise-db (The Unlicense / public domain, 873 records) — vendored
//      JSON at db/seeds/free-exercise-db.json; images hotlink the upstream repo.
//   2. knee-core.json — the in-house authored knee-rehab corridor with
//      progression edges (no open dataset has these; PRD §2).
// Idempotency: skip-if-counted for the bulk import, ON CONFLICT for the rest.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

const FED_SOURCE = "free-exercise-db";
const FED_LICENSE = "The Unlicense (public domain)";
const FED_REPO = "https://github.com/yuhonas/free-exercise-db";
const FED_IMG_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

type FedRecord = {
  id: string;
  name: string;
  level: "beginner" | "intermediate" | "expert";
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
};

// Dataset muscles → coarse clinical body regions (approximate on purpose —
// good enough for filtering; PTs re-tag what they actually use).
const MUSCLE_REGION: Record<string, string[]> = {
  quadriceps: ["knee"],
  hamstrings: ["knee", "hip"],
  glutes: ["hip"],
  adductors: ["hip"],
  abductors: ["hip"],
  calves: ["ankle_foot"],
  abdominals: ["core"],
  "lower back": ["spine", "core"],
  "middle back": ["spine"],
  lats: ["spine", "shoulder"],
  traps: ["shoulder", "neck"],
  shoulders: ["shoulder"],
  chest: ["shoulder"],
  biceps: ["elbow"],
  triceps: ["elbow"],
  forearms: ["wrist_hand", "elbow"],
  neck: ["neck"],
};

// Dataset equipment strings → equipment_catalog slugs.
const EQUIPMENT_SLUG: Record<string, string> = {
  "body only": "none",
  bands: "resistance-band",
  dumbbell: "dumbbell",
  barbell: "barbell",
  kettlebells: "kettlebell",
  cable: "cable-machine",
  machine: "machine",
  "medicine ball": "medicine-ball",
  "exercise ball": "exercise-ball",
  "e-z curl bar": "ez-curl-bar",
  "foam roll": "foam-roller",
  other: "other",
};

const LEVEL_DIFFICULTY: Record<FedRecord["level"], number> = {
  beginner: 2,
  intermediate: 3,
  expert: 4,
};

// Curation tier (must mirror db/migrations/0003_tiering.sql): the default
// library view is rehab-plausible only; gym-flavored content imports behind
// the "gym extras" toggle.
const GYM_CATEGORIES = new Set(["powerlifting", "olympic weightlifting", "strongman"]);
const GYM_EQUIPMENT = new Set(["barbell", "e-z curl bar", "kettlebells"]);

function tierFor(r: FedRecord): "rehab" | "gym-extra" {
  if (GYM_CATEGORIES.has(r.category)) return "gym-extra";
  if (/smith/i.test(r.name)) return "gym-extra";
  if (r.equipment && GYM_EQUIPMENT.has(r.equipment)) return "gym-extra";
  if (r.category === "plyometrics" && r.equipment && r.equipment !== "body only")
    return "gym-extra";
  return "rehab";
}

function regionsFor(muscles: string[]): string[] {
  const out = new Set<string>();
  for (const m of muscles) for (const r of MUSCLE_REGION[m] ?? []) out.add(r);
  return out.size ? [...out] : ["full_body"];
}

async function equipmentIdBySlug(pool: Pool): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM equipment_catalog",
  );
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function linkEquipment(
  pool: Pool,
  exerciseId: string,
  slugs: string[],
  bySlug: Map<string, string>,
): Promise<void> {
  for (const slug of slugs) {
    const eqId = bySlug.get(slug);
    if (!eqId) continue;
    await pool.query(
      "INSERT INTO exercise_equipment (exercise_id, equipment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [exerciseId, eqId],
    );
  }
}

async function seedFreeExerciseDb(pool: Pool, bySlug: Map<string, string>): Promise<number> {
  const raw = await readFile(
    path.join(process.cwd(), "db", "seeds", "free-exercise-db.json"),
    "utf8",
  );
  const records = JSON.parse(raw) as FedRecord[];

  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM exercises WHERE source = $1",
    [FED_SOURCE],
  );
  if (Number(rows[0].n) >= records.length) return 0; // already imported

  let inserted = 0;
  for (const r of records) {
    const {
      rows: [row],
    } = await pool.query<{ id: string }>(
      `INSERT INTO exercises
         (source, source_key, name, instructions, body_regions, difficulty, tags,
          images, license, license_author, source_url, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (source, source_key) DO NOTHING
       RETURNING id`,
      [
        FED_SOURCE,
        r.id,
        r.name,
        JSON.stringify(r.instructions),
        regionsFor(r.primaryMuscles),
        LEVEL_DIFFICULTY[r.level] ?? 3,
        [r.category, ...r.primaryMuscles],
        JSON.stringify(r.images.map((p) => FED_IMG_BASE + p)),
        FED_LICENSE,
        "yuhonas/free-exercise-db contributors",
        FED_REPO,
        tierFor(r),
      ],
    );
    if (!row) continue;
    inserted++;
    const slug = r.equipment ? EQUIPMENT_SLUG[r.equipment] : "none";
    await linkEquipment(pool, row.id, [slug ?? "other"], bySlug);
  }
  return inserted;
}

type KneeCore = {
  exercises: {
    key: string;
    name: string;
    position: string;
    difficulty: number;
    body_regions: string[];
    tags: string[];
    equipment: string[];
    instructions: string[];
  }[];
  progressions: { from: string; to: string; note: string }[];
};

async function seedKneeCore(pool: Pool, bySlug: Map<string, string>): Promise<number> {
  const raw = await readFile(path.join(process.cwd(), "db", "seeds", "knee-core.json"), "utf8");
  const core = JSON.parse(raw) as KneeCore;

  const idByKey = new Map<string, string>();
  let inserted = 0;

  for (const e of core.exercises) {
    const {
      rows: [row],
    } = await pool.query<{ id: string }>(
      `INSERT INTO exercises
         (source, source_key, name, instructions, body_regions, position, difficulty,
          tags, images, license, license_author, source_url)
       VALUES ('carryover',$1,$2,$3,$4,$5,$6,$7,'[]',$8,$9,$10)
       ON CONFLICT (source, source_key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [
        e.key,
        e.name,
        JSON.stringify(e.instructions),
        e.body_regions,
        e.position,
        e.difficulty,
        e.tags,
        "Carryover original (authored in-house)",
        "Carryover",
        null,
      ],
    );
    idByKey.set(e.key, row.id);
    inserted++;
    await linkEquipment(pool, row.id, e.equipment, bySlug);
  }

  for (const p of core.progressions) {
    const from = idByKey.get(p.from);
    const to = idByKey.get(p.to);
    if (!from || !to) continue;
    await pool.query(
      `INSERT INTO exercise_progressions (from_exercise_id, to_exercise_id, note)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [from, to, p.note],
    );
  }
  return inserted;
}

export async function seedLibrary(pool: Pool): Promise<{ imported: number; core: number }> {
  const bySlug = await equipmentIdBySlug(pool);
  const imported = await seedFreeExerciseDb(pool, bySlug);
  const core = await seedKneeCore(pool, bySlug);
  return { imported, core };
}
