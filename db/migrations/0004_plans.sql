-- Plans layer (PRD build step 3): episodes of care, intakes, AI-drafted plans
-- with the PT approval gate, and the ai_call_log (clientfirst pattern).
-- Visits/adherence land in later migrations.

-- Episode of care: a patient's tracked condition. Plans and intakes hang off
-- an episode, not the patient, so a second injury later doesn't collide
-- (PRD §3). MVP UI auto-creates one open episode per patient on first intake.
CREATE TABLE episodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  condition       text NOT NULL,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);
CREATE INDEX episodes_patient_idx ON episodes (patient_user_id) WHERE closed_at IS NULL;

-- Intake: structured fields + narrative (PRD §1 decision 9). Structured parts
-- power library filtering and clean AI prompts; the narrative catches the rest.
CREATE TABLE intakes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  condition      text NOT NULL,
  body_regions   text[] NOT NULL DEFAULT '{}',
  onset_date     date,                       -- surgery date or symptom onset
  pain_now       int CHECK (pain_now BETWEEN 0 AND 10),
  pain_worst     int CHECK (pain_worst BETWEEN 0 AND 10),
  goals          text,
  restrictions   text,                       -- precautions, weight-bearing status, ROM limits
  narrative      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A plan is a draft until a PT approves it; nothing patient-facing unsigned
-- (PRD doctrine #1). One active plan per episode at a time.
CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('ai-draft', 'manual')),
  model       text,                          -- AI model id when source = 'ai-draft'
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  retired_at  timestamptz
);
CREATE INDEX plans_episode_idx ON plans (episode_id);

CREATE TABLE plan_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  exercise_id        uuid NOT NULL REFERENCES exercises(id),
  sets               int CHECK (sets BETWEEN 1 AND 10),
  reps               int CHECK (reps BETWEEN 1 AND 50),
  hold_secs          int CHECK (hold_secs BETWEEN 1 AND 300),
  frequency_per_week int NOT NULL DEFAULT 5 CHECK (frequency_per_week BETWEEN 1 AND 14),
  location           text NOT NULL DEFAULT 'home' CHECK (location IN ('office', 'home', 'both')),
  rationale          text,                   -- patient-readable after PT approval (PT edits first)
  sort               int NOT NULL DEFAULT 0
);
CREATE INDEX plan_items_plan_idx ON plan_items (plan_id);

-- Every /v1/ai call is logged app-side (clientfirst pattern) — latency,
-- validation drops, and errors are the observability for the draft feature.
CREATE TABLE ai_call_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id),
  kind          text NOT NULL,               -- 'plan-draft' (adherence-summary later)
  mode          text NOT NULL,               -- 'lithe' | 'fixture'
  model         text,
  status        text NOT NULL,               -- 'ok' | 'error'
  latency_ms    int,
  dropped_items int NOT NULL DEFAULT 0,      -- hallucinated/invalid items removed by validation
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
