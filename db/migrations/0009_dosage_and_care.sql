-- Dosage types, modalities, and ad-hoc care logging.
--
-- Three of Dan's four asks land here, because they are one problem: the plan
-- could only express "sets x reps (x hold)". A bike at 10 minutes / level 2,
-- an ice pack for 15 minutes, and 20 minutes in compression boots are all the
-- same shape — a duration and an intensity — and none of them fit.

-- How an item is dosed. Lives on the exercise as the DEFAULT, so the plan
-- editor, the patient logger, and the AI all render the right fields without
-- guessing from which columns happen to be null.
ALTER TABLE exercises
  ADD COLUMN dosage_type text NOT NULL DEFAULT 'reps'
    CHECK (dosage_type IN ('reps', 'hold', 'time'));

-- 'modality' = ice, heat, TENS, compression. Deliberately the same table as
-- exercises rather than a parallel care system: they are prescribed, dosed,
-- logged, done in office or at home, and reasoned about by the AI in exactly
-- the same way. A second pipeline would double every surface to buy a word.
-- The library UI filters them out of normal browse and gives them a section.
ALTER TABLE exercises
  ADD COLUMN kind text NOT NULL DEFAULT 'exercise'
    CHECK (kind IN ('exercise', 'modality'));

-- PT-authored exercises start clinic-private and are promoted deliberately.
-- clinic_id already carried ownership (0002: "null = global library"); this is
-- the opt-in that lets a good one escape its clinic. Visibility rule:
--   clinic_id IS NULL  OR  shared  OR  clinic_id = one of the viewer's clinics
ALTER TABLE exercises ADD COLUMN shared boolean NOT NULL DEFAULT false;

-- Dosage on the prescription. intensity is TEXT on purpose: "level 2",
-- "2.5 mph", "yellow band", and "6/10 effort" are all real answers, and
-- flattening them to a number would lose which machine's scale is meant.
ALTER TABLE plan_items ADD COLUMN duration_mins int CHECK (duration_mins BETWEEN 1 AND 240);
ALTER TABLE plan_items ADD COLUMN intensity text;

ALTER TABLE visit_items ADD COLUMN duration_mins int CHECK (duration_mins BETWEEN 1 AND 240);
ALTER TABLE visit_items ADD COLUMN intensity text;

ALTER TABLE adherence_logs
  ADD COLUMN duration_done_mins int CHECK (duration_done_mins BETWEEN 0 AND 600);

-- --- Ad-hoc care logging -----------------------------------------------
-- "I iced because it felt tight" has no plan item behind it. Making
-- plan_item_id nullable is what lets that be recorded at all; exercise_id
-- becomes the thing every log always has.
ALTER TABLE adherence_logs ADD COLUMN exercise_id uuid REFERENCES exercises(id);
UPDATE adherence_logs al
   SET exercise_id = pi.exercise_id
  FROM plan_items pi
 WHERE pi.id = al.plan_item_id AND al.exercise_id IS NULL;
ALTER TABLE adherence_logs ALTER COLUMN exercise_id SET NOT NULL;
ALTER TABLE adherence_logs ALTER COLUMN plan_item_id DROP NOT NULL;

-- The old UNIQUE (plan_item_id, log_date) stops protecting anything once
-- plan_item_id can be NULL: Postgres treats every NULL as distinct, so a
-- patient could log "iced" ten times today. Two partial indexes instead —
-- one per case, each meaning "once per day".
ALTER TABLE adherence_logs DROP CONSTRAINT adherence_logs_plan_item_id_log_date_key;
CREATE UNIQUE INDEX adherence_logs_prescribed_key
  ON adherence_logs (plan_item_id, log_date) WHERE plan_item_id IS NOT NULL;
CREATE UNIQUE INDEX adherence_logs_adhoc_key
  ON adherence_logs (patient_user_id, exercise_id, log_date) WHERE plan_item_id IS NULL;

-- --- Backfill dosage_type ----------------------------------------------
-- Name matching, same pragmatic approach as 0003's tiering. Wrong guesses are
-- cheap: the PT overrides per prescription, and the library row is editable.
-- No bare "walk"/"jog": it swept up Walking Lunge, Monster Walk, Farmer's Walk
-- and Yoke Walk, which are rep work. The real cardio rows all carry treadmill
-- or running anyway. "Air Bike" in free-exercise-db is the abs bicycle crunch,
-- not the fan bike, so it is excluded by name.
UPDATE exercises SET dosage_type = 'time'
 WHERE name ~* '(bike|cycl|treadmill|elliptical|rowing|stair ?climb|nustep|jogging|running)'
   AND name !~* '(lunge|crunch|air bike)';

UPDATE exercises SET dosage_type = 'hold'
 WHERE dosage_type = 'reps'
   AND name ~* '(plank|wall sit|isometric|quad set|glute set|stretch|hold)';

-- --- Seed the modality catalog -----------------------------------------
-- Prescribable care, dosed in minutes. Each links to its equipment_catalog row
-- where one exists, so the existing home-eligibility check already works: the
-- AI cannot send someone home with compression boots they do not own.
INSERT INTO exercises
  (source, source_key, name, kind, dosage_type, instructions, body_regions,
   difficulty, license, license_author)
VALUES
  ('carryover', 'modality-ice', 'Ice / cold pack', 'modality', 'time',
   '["Wrap the pack in a thin towel — never place it directly on skin.","Rest it over the sore area.","Stop early if the skin goes numb or white."]',
   '{}', 1, 'owned', 'Carryover'),
  ('carryover', 'modality-heat', 'Heat pack', 'modality', 'time',
   '["Warm the pack and wrap it in a thin towel.","Rest it over the stiff area.","It should feel warm, never hot."]',
   '{}', 1, 'owned', 'Carryover'),
  ('carryover', 'modality-tens', 'TENS unit', 'modality', 'time',
   '["Place the pads as your PT showed you.","Turn the intensity up until it tingles strongly but never hurts.","Note the intensity setting you used."]',
   '{}', 1, 'owned', 'Carryover'),
  ('carryover', 'modality-compression-boots', 'Compression boots', 'modality', 'time',
   '["Put the boots on with the leg supported and elevated.","Run the cycle at the pressure your PT set.","Take them off if you feel pins and needles."]',
   '{}', 1, 'owned', 'Carryover'),
  ('carryover', 'modality-cold-compression', 'Cold compression machine', 'modality', 'time',
   '["In-clinic device — the PT sets the temperature and pressure.","Record the setting used and how the knee felt afterward."]',
   '{}', 1, 'owned', 'Carryover'),
  ('carryover', 'modality-elevation', 'Elevation', 'modality', 'time',
   '["Lie down and prop the leg above the level of your heart.","Support the whole leg, not just the heel."]',
   '{}', 1, 'owned', 'Carryover')
ON CONFLICT (source, source_key) DO NOTHING;

-- The clinic device needs a catalog row too, so that home-eligibility can tell
-- "the PT has one in the treatment room" from "the patient owns one". Without
-- it the machine has zero equipment links, which the slice reads as "needs
-- nothing", and the AI would cheerfully send it home.
INSERT INTO equipment_catalog (slug, name, kind)
VALUES ('cold-compression', 'Cold compression machine', 'modality')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO exercise_equipment (exercise_id, equipment_id)
SELECT e.id, ec.id
  FROM exercises e
  JOIN equipment_catalog ec
    ON ec.slug = CASE e.source_key
                   WHEN 'modality-ice'               THEN 'ice-pack'
                   WHEN 'modality-heat'              THEN 'heat-pad'
                   WHEN 'modality-tens'              THEN 'tens-unit'
                   WHEN 'modality-compression-boots' THEN 'compression-boots'
                   WHEN 'modality-cold-compression'  THEN 'cold-compression'
                 END
 WHERE e.source = 'carryover' AND e.kind = 'modality'
ON CONFLICT DO NOTHING;

CREATE INDEX exercises_kind_idx ON exercises (kind) WHERE archived_at IS NULL;
