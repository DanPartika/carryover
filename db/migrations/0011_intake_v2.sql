-- Intake v2 + progress-report plumbing + care timing.
--
-- The old intake was 8 fields — a fraction of a real first PT session. Real
-- clinics split the eval: the patient pre-fills the facts on a form before
-- the visit, and the PT re-asks what matters in the room, adding the parts
-- that need a trained eye (precautions, irritability). This migration gives
-- both halves somewhere to live. Everything stays on the append-only intakes
-- table — editing is by superseding, same as before; who authored a row is
-- already recorded (author_user_id), so "patient-submitted" is derived, not
-- stored.

-- ── Demographics ────────────────────────────────────────────────────────────
-- Age is a user attribute, not an episode attribute: a second injury next
-- year should not have to re-ask it. Year, not full DOB — dosage needs
-- "is this patient 19 or 80", not a birthday.
ALTER TABLE users ADD COLUMN birth_year int
  CHECK (birth_year BETWEEN 1900 AND 2100);

-- ── Intake: the full subjective exam ───────────────────────────────────────
ALTER TABLE intakes
  -- which side — today laterality lives only inside the condition string
  ADD COLUMN side text CHECK (side IN ('left', 'right', 'both', 'na')),

  -- onset & course
  ADD COLUMN onset_kind text CHECK (onset_kind IN ('sudden', 'gradual', 'injury', 'surgery')),
  ADD COLUMN trajectory text CHECK (trajectory IN ('improving', 'worsening', 'unchanged')),
  ADD COLUMN had_before boolean,
  ADD COLUMN mechanism  text,                 -- "twisted landing from a jump" — what actually happened

  -- pain characteristics beyond now/worst
  ADD COLUMN pain_avg     int CHECK (pain_avg BETWEEN 0 AND 10),   -- clinics ask "average over the last 48h"
  ADD COLUMN pain_pattern text CHECK (pain_pattern IN ('constant', 'intermittent', 'with_motion')),
  ADD COLUMN aggravators  text,
  ADD COLUMN easers       text,
  ADD COLUMN night_pain   boolean,
  ADD COLUMN worst_time   text CHECK (worst_time IN ('morning', 'midday', 'evening', 'night', 'varies')),

  -- function: up to 3 activities the patient can't do, each rated 0-10
  -- (PSFS-shaped). These ARE the numbered goals — every progress report
  -- compares a fresh rating of these against this baseline. Shape:
  -- [{"activity": "climbing stairs", "rating": 4}]
  ADD COLUMN limited_activities jsonb,
  ADD COLUMN assistive_device   text,         -- cane, walker, brace — null = none

  -- medical history & screening. Slug arrays validated app-side, same
  -- pattern as body_regions (0004 has no DB check either): the vocabulary
  -- lives in one TS constant, not in a CHECK that needs a migration to grow.
  ADD COLUMN conditions  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN red_flags   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN medications text,
  ADD COLUMN surgeries   text,

  -- what came before this intake
  ADD COLUMN imaging         text,            -- "MRI June — partial meniscus tear"
  ADD COLUMN prior_treatment text,            -- prior PT, chiro, injections — and whether they helped

  -- life demands the plan has to survive
  ADD COLUMN occupation     text,
  ADD COLUMN activity_level text;             -- "runs 3x/week, rec soccer"

-- ── Goal re-rates ───────────────────────────────────────────────────────────
-- The patient (from Today, when a check-in is due) or the PT (in the room)
-- re-rates the intake's limited activities. Append-only; the newest row per
-- episode is "current", the intake row is the baseline. Ratings mirror the
-- intake's limited_activities by activity text, not index, so a superseding
-- intake that reorders them can't silently shift the comparison.
CREATE TABLE goal_ratings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  ratings        jsonb NOT NULL,              -- [{"activity": text, "rating": 0-10}]
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goal_ratings_episode_idx ON goal_ratings (episode_id, created_at DESC);

-- ── Care timing ─────────────────────────────────────────────────────────────
-- "Ice before or after?" — a modality item can now say. Null means untimed
-- (elevation, TENS whenever). Only meaningful when the exercise is
-- kind='modality'; enforced app-side because the DB would need a trigger to
-- see across the FK, and every other cross-table rule here is app-side too.
ALTER TABLE plan_items ADD COLUMN care_timing text
  CHECK (care_timing IN ('before', 'after'));

-- ── Equipment worth acquiring ───────────────────────────────────────────────
-- The AI may suggest 1-2 cheap acquisitions that would unlock better home
-- care ("an ice pack would let you ice after sessions"). Frozen on the plan
-- at draft time as [{"slug", "name", "reason"}]; the PT prunes them in the
-- draft and they reach the patient only with approval — same gate as
-- everything else. patient_equipment stays strictly "what IS owned".
ALTER TABLE plans ADD COLUMN equipment_suggestions jsonb;

-- One short model-authored note for the PT's eyes only ("screening answers
-- worth a look before loading"), frozen at draft time. Never rendered on any
-- patient surface — the patient-visible channel stays rationale, which the
-- PT edits before approval.
ALTER TABLE plans ADD COLUMN ai_note text;
