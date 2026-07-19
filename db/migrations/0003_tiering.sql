-- Library curation tier (Dan's review, 2026-07-17): free-exercise-db is
-- gym-skewed, so the default library view shows only rehab-plausible content;
-- barbell/kettlebell/olympic/strongman work stays importable but behind an
-- explicit "gym extras" toggle. Rules mirror lib/db/seed.ts tierFor() —
-- this migration backfills rows imported before the column existed.

ALTER TABLE exercises ADD COLUMN tier text NOT NULL DEFAULT 'rehab'
  CHECK (tier IN ('rehab', 'gym-extra'));

UPDATE exercises e SET tier = 'gym-extra'
WHERE e.source = 'free-exercise-db' AND (
  -- whole categories that have no place in a PT library (category is tags[1])
  e.tags && ARRAY['powerlifting', 'olympic weightlifting', 'strongman']
  -- Smith-machine work reads as gym even when the muscles are relevant
  OR e.name ILIKE '%smith%'
  -- heavy-bar/kettlebell equipment
  OR EXISTS (
    SELECT 1 FROM exercise_equipment ee
    JOIN equipment_catalog ec ON ec.id = ee.equipment_id
    WHERE ee.exercise_id = e.id AND ec.slug IN ('barbell', 'ez-curl-bar', 'kettlebell')
  )
  -- plyometrics stay (return-to-sport phase) only in their bodyweight form
  OR ('plyometrics' = ANY(e.tags) AND NOT EXISTS (
    SELECT 1 FROM exercise_equipment ee
    JOIN equipment_catalog ec ON ec.id = ee.equipment_id
    WHERE ee.exercise_id = e.id AND ec.slug = 'none'
  ))
);

CREATE INDEX exercises_tier_idx ON exercises (tier);
