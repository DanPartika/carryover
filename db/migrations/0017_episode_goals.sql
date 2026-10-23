-- Goals added after the intake.
--
-- Until now an episode's goals were the (up to three) activities rated on the
-- intake, and nobody could add one later — even though what people want back
-- tends to surface over the following days ("I'd love to sleep through the
-- night" comes after the first appointment, not during it).
--
-- A row here is one extra goal: an everyday activity, the patient's own 0-10
-- rating of it WHEN IT WAS NAMED (its baseline), and who named it. Re-ratings
-- stay where they always were — append-only goal_ratings, matched to a goal by
-- its text — so a late goal's "now" reads the same way an intake goal's does.
--
-- Retiring is soft (the row stays; it just stops being a live goal) because a
-- mistyped or changed-my-mind goal needs a way out, but anything a PT or a
-- closing summary has already read should not vanish from the record.

CREATE TABLE episode_goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  activity       text NOT NULL CHECK (char_length(btrim(activity)) BETWEEN 1 AND 120),
  baseline       smallint NOT NULL CHECK (baseline BETWEEN 0 AND 10),
  author_user_id uuid NOT NULL REFERENCES users(id),
  author_role    text NOT NULL CHECK (author_role IN ('patient', 'pt')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz,
  retired_by     uuid REFERENCES users(id),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);

CREATE INDEX episode_goals_episode_idx ON episode_goals (episode_id, created_at);

-- One LIVE goal per activity per episode, however it was capitalised or
-- spaced. Retired rows don't count, so a retired goal can be named again.
CREATE UNIQUE INDEX episode_goals_one_live
  ON episode_goals (episode_id, lower(btrim(activity))) WHERE retired_at IS NULL;

-- A closed episode takes no new goals — same backstop as every other child
-- table (0016), so "closed means closed" holds for code paths not written yet.
CREATE TRIGGER episode_goals_episode_open BEFORE INSERT ON episode_goals
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
