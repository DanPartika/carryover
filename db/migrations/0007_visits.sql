-- In-office visits (PRD build step 6): what the PT actually did with the
-- patient in the room. This is the other half of the office/home split the
-- patient's Today view and the PT dashboard have both been carrying a
-- placeholder for since step 4.
--
-- It is also the seam PRD §4 reserves for scheduling: a visit here is a
-- RECORD of work done, never an appointment. Nothing in this table implies a
-- future date, so a calendar can land on top of it later without a rewrite.

CREATE TABLE visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  pt_user_id  uuid NOT NULL REFERENCES users(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,                 -- NULL = the visit is open right now
  note        text,                        -- the PT's one-line wrap-up, patient-visible
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_episode_idx ON visits (episode_id, started_at DESC);

-- One open visit per episode. Doctrine #2 ("the PT never does homework"): a
-- forgotten open visit from last week must not silently collect today's taps,
-- and "Start visit" has to be safe to hit twice on a laggy tablet. The partial
-- unique index makes both of those the database's problem, not the UI's.
CREATE UNIQUE INDEX visits_one_open_per_episode
  ON visits (episode_id) WHERE ended_at IS NULL;

CREATE TABLE visit_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     uuid NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  exercise_id  uuid NOT NULL REFERENCES exercises(id),
  -- Which plan row this came from, when it came from the plan at all. NULL is
  -- the quick-add case: the PT reached for something mid-session that isn't
  -- prescribed. ON DELETE SET NULL so re-planning never erases visit history.
  plan_item_id uuid REFERENCES plan_items(id) ON DELETE SET NULL,
  sets         int CHECK (sets BETWEEN 0 AND 20),
  reps         int CHECK (reps BETWEEN 0 AND 100),
  hold_secs    int CHECK (hold_secs BETWEEN 1 AND 300),
  pain         int CHECK (pain BETWEEN 0 AND 10),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Tap-done is a toggle, so the same exercise can't appear twice in one visit —
-- and the upsert the toggle relies on needs this to conflict against.
CREATE UNIQUE INDEX visit_items_visit_exercise_key ON visit_items (visit_id, exercise_id);
