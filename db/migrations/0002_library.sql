-- Library layer (PRD build step 1): exercises with facets + progression chains,
-- equipment catalog (exercise gear + home modality devices), patient inventory.
-- Plans/visits/adherence land in later migrations.

-- Curated equipment catalog. 'modality' = home devices (TENS, compression) that
-- are inventory-only — they gate what a PT can assign, not exercise mechanics.
CREATE TABLE equipment_catalog (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug  text UNIQUE NOT NULL,
  name  text NOT NULL,
  kind  text NOT NULL DEFAULT 'exercise' CHECK (kind IN ('exercise', 'modality'))
);

-- Every row carries license bookkeeping (PRD §2): the library permanently mixes
-- regimes (public-domain imports, in-house authored, clinic uploads).
CREATE TABLE exercises (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source         text NOT NULL,             -- 'free-exercise-db' | 'carryover' | 'clinic'
  source_key     text,                      -- stable id within source (dataset id / authored slug)
  clinic_id      uuid REFERENCES clinics(id), -- null = global library; set = clinic-scoped custom
  name           text NOT NULL,
  instructions   jsonb NOT NULL DEFAULT '[]',  -- array of step strings
  body_regions   text[] NOT NULL DEFAULT '{}', -- neck|shoulder|elbow|wrist_hand|spine|core|hip|knee|ankle_foot|full_body
  position       text CHECK (position IN ('standing','seated','supine','prone','side_lying','quadruped')),
  difficulty     int CHECK (difficulty BETWEEN 1 AND 5),
  tags           text[] NOT NULL DEFAULT '{}',
  images         jsonb NOT NULL DEFAULT '[]',  -- array of URL strings
  video_url      text,
  license        text NOT NULL,
  license_author text,
  source_url     text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  UNIQUE (source, source_key)
);

CREATE INDEX exercises_body_regions_gin ON exercises USING gin (body_regions);
CREATE INDEX exercises_tags_gin ON exercises USING gin (tags);

CREATE TABLE exercise_equipment (
  exercise_id  uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment_catalog(id) ON DELETE CASCADE,
  PRIMARY KEY (exercise_id, equipment_id)
);

-- Progression chains: directed easier→harder edges with a clinical note per edge
-- (PRD §1 decision 13). The plan editor offers chain-mates as one-tap swaps.
CREATE TABLE exercise_progressions (
  from_exercise_id uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  to_exercise_id   uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  note             text,
  PRIMARY KEY (from_exercise_id, to_exercise_id),
  CHECK (from_exercise_id <> to_exercise_id)
);

-- Patient-owned home equipment (PRD: the verified market differentiator) —
-- constrains home assignments and the AI draft.
CREATE TABLE patient_equipment (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES equipment_catalog(id) ON DELETE CASCADE,
  note         text,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, equipment_id)
);

INSERT INTO equipment_catalog (slug, name, kind) VALUES
  ('none',              'No equipment',          'exercise'),
  ('resistance-band',   'Resistance band',       'exercise'),
  ('dumbbell',          'Dumbbell',              'exercise'),
  ('barbell',           'Barbell',               'exercise'),
  ('kettlebell',        'Kettlebell',            'exercise'),
  ('cable-machine',     'Cable machine',         'exercise'),
  ('machine',           'Gym machine',           'exercise'),
  ('medicine-ball',     'Medicine ball',         'exercise'),
  ('exercise-ball',     'Exercise ball',         'exercise'),
  ('ez-curl-bar',       'E-Z curl bar',          'exercise'),
  ('foam-roller',       'Foam roller',           'exercise'),
  ('step',              'Step / stair',          'exercise'),
  ('chair',             'Chair',                 'exercise'),
  ('wall',              'Wall',                  'exercise'),
  ('towel',             'Towel / strap',         'exercise'),
  ('ankle-weights',     'Ankle weights',         'exercise'),
  ('balance-pad',       'Balance pad / BOSU',    'exercise'),
  ('stationary-bike',   'Stationary bike',       'exercise'),
  ('other',             'Other',                 'exercise'),
  ('tens-unit',         'TENS unit',             'modality'),
  ('compression-boots', 'Compression boots',     'modality'),
  ('ice-pack',          'Ice pack / ice machine','modality'),
  ('heat-pad',          'Heating pad',           'modality');
