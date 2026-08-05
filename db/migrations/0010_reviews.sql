-- Progression check-ins (Dan's ask #2). "Dan had an intake and an initial plan,
-- but he's ready for the next stage and needs a whole revamp" — the app has to
-- notice that moment and make acting on it cheap.
--
-- The rule this schema exists to hold: the app surfaces a SIGNAL and never a
-- verdict. Nothing here records "this patient should progress". It records what
-- the PT decided, and what the numbers were when they decided it.
--
-- Three parts:
--   1. Plan lineage. A check-in produces a NEW plan; approved plans stay
--      immutable (doctrine #1 — the approved record is what the patient saw),
--      so even a one-exercise bump is a revision, not an edit.
--   2. plan_reviews — the decision record, and the clock the "due for review"
--      signal counts from. "No change today" is a real outcome and resets it.
--   3. checkin_requests — the patient raising a hand.

-- 'progression' = the one-tap swap of a single item for its charted successor
-- (or predecessor). Distinguishable from a full revamp in the record forever.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_source_check;
ALTER TABLE plans ADD CONSTRAINT plans_source_check
  CHECK (source IN ('ai-draft', 'manual', 'progression'));

-- Nullable: the first plan of an episode supersedes nothing. ON DELETE SET
-- NULL rather than CASCADE — discarding a draft must never take the plan it
-- would have replaced down with it.
ALTER TABLE plans ADD COLUMN supersedes_plan_id uuid REFERENCES plans(id) ON DELETE SET NULL;

CREATE TABLE plan_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  reviewed_by uuid NOT NULL REFERENCES users(id),
  -- 'regressed' is a first-class outcome, not a failure state: a check-in that
  -- can only make a plan harder has a verdict baked into it.
  outcome     text NOT NULL CHECK (outcome IN ('progressed', 'regressed', 'revamped', 'no_change')),
  plan_id     uuid REFERENCES plans(id) ON DELETE SET NULL,  -- the plan it produced, if any
  note        text,
  -- What the numbers said at the moment of the decision. Adherence logs stay
  -- editable after the fact, so this cannot be recomputed later and stay true.
  context     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_reviews_episode_idx ON plan_reviews (episode_id, created_at DESC);

CREATE TABLE checkin_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id      uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  patient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('too_easy', 'too_hard', 'something_changed')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id)
);
-- One open request per episode: raising a hand twice is the same hand, not a
-- queue. A second press updates the open row rather than stacking behind it.
CREATE UNIQUE INDEX checkin_requests_one_open
  ON checkin_requests (episode_id) WHERE resolved_at IS NULL;
