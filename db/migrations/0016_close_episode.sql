-- Closing an episode of care.
--
-- An episode is one course of care for one problem. Until now nothing ever set
-- closed_at, so a returning patient could only ever be a continuation of the
-- last round. Closing is a PT act with a written record: the summary is what
-- closes it, it is shared with the patient, and the numbers behind it are frozen
-- (adherence logs stay editable, so recomputing later would quietly rewrite
-- history — the same rule plan_reviews.context follows).

ALTER TABLE episodes
  ADD COLUMN closed_by           uuid REFERENCES users(id),
  -- The day care actually ENDED, which is not always the day the PT got round
  -- to closing it: a patient who stopped coming in September and is closed out
  -- in October must not be scored for the weeks they were gone.
  ADD COLUMN ended_on            date,
  ADD COLUMN closing_summary     text,
  -- A short, PT-written line for the NEXT episode's AI draft: pain with a
  -- movement, a precaution, equipment that doesn't work. Deliberately NOT the
  -- summary — the summary is a story about how this round went, and story is
  -- exactly what must not anchor the next round's pace.
  ADD COLUMN closing_watch_for   text,
  -- Provenance only: true when the PT started from a real AI draft. The text
  -- itself is always the PT's — they edited it and pressed Close.
  ADD COLUMN closing_ai_assisted boolean NOT NULL DEFAULT false,
  ADD COLUMN closing_context     jsonb,
  -- The plan that was in force when care closed. Identifies "where it ended"
  -- exactly (approval timestamps are transaction-start times and can tie or
  -- invert under concurrent revisions) and is what a reopen puts back.
  ADD COLUMN closing_plan_id     uuid REFERENCES plans(id) ON DELETE SET NULL;

-- Defensive, as 0015 was: the unique index below fails the whole boot if a
-- duplicate open episode already exists (a PT intake and a patient pre-fill can
-- race — the very thing the index closes). Keep the one with an active plan,
-- else the newest; close the rest as merged.
WITH ranked AS (
  SELECT e.id,
         row_number() OVER (
           PARTITION BY e.clinic_id, e.patient_user_id
           ORDER BY EXISTS (SELECT 1 FROM plans p
                             WHERE p.episode_id = e.id AND p.status = 'active') DESC,
                    e.opened_at DESC, e.id DESC
         ) AS rn
  FROM episodes e
  WHERE e.closed_at IS NULL
)
UPDATE episodes e
SET closed_at = now(),
    closed_by = e.patient_user_id,
    ended_on = (now() AT TIME ZONE 'America/New_York')::date,
    closing_summary = 'Merged into a newer episode by migration 0016.'
FROM ranked r
WHERE r.id = e.id AND r.rn > 1;

-- A closed episode always carries its summary, who closed it, and when care
-- ended. The API enforces this too; the constraint keeps a future code path
-- honest.
ALTER TABLE episodes ADD CONSTRAINT episodes_closed_has_summary CHECK (
  closed_at IS NULL
  OR (closing_summary IS NOT NULL AND btrim(closing_summary) <> ''
      AND closed_by IS NOT NULL AND ended_on IS NOT NULL)
);

-- One open episode per patient per clinic. The intake routes SELECT ... FOR
-- UPDATE then INSERT when none is open, which does not stop two concurrent
-- first intakes (PT + patient pre-fill) from each inserting — and every
-- "the open episode" query would then pick one of them arbitrarily.
CREATE UNIQUE INDEX episodes_one_open
  ON episodes (clinic_id, patient_user_id) WHERE closed_at IS NULL;

-- A closed episode takes no NEW rows. Application guards check this first, but
-- a check-then-insert races a concurrent close: the child INSERT blocks behind
-- the close's row lock on episodes (its foreign key needs a share lock on the
-- same row) and then succeeds once the close commits, because the key never
-- changed. Taking the share lock here and re-reading closed_at AFTER the wait
-- is what makes "closed means closed" a property of the database, including
-- for code paths that don't exist yet.
CREATE FUNCTION episode_must_be_open() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM episodes WHERE id = NEW.episode_id AND closed_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'episode % is closed', NEW.episode_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER plans_episode_open BEFORE INSERT ON plans
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER plan_reviews_episode_open BEFORE INSERT ON plan_reviews
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER visits_episode_open BEFORE INSERT ON visits
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER notes_episode_open BEFORE INSERT ON notes
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER intakes_episode_open BEFORE INSERT ON intakes
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER goal_ratings_episode_open BEFORE INSERT ON goal_ratings
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
CREATE TRIGGER checkin_requests_episode_open BEFORE INSERT ON checkin_requests
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();

-- Append-only record of every close. A reopen (the escape hatch for a mis-tap)
-- clears the episode's own closing_* columns, but the patient may already have
-- read the summary — so what was published is never silently lost.
CREATE TABLE episode_closures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  closed_by     uuid NOT NULL REFERENCES users(id),
  closed_at     timestamptz NOT NULL,
  ended_on      date NOT NULL,
  summary       text NOT NULL,
  watch_for     text,
  ai_assisted   boolean NOT NULL,
  context       jsonb,
  reopened_by   uuid REFERENCES users(id),
  reopened_at   timestamptz
);
CREATE INDEX episode_closures_episode_idx ON episode_closures (episode_id, closed_at DESC);
