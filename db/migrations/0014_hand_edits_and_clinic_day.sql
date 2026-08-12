-- Three small schema words for Dan's bug round, plus the clock fix.

-- 1. The app's day is the clinic's day, not UTC. The containers run UTC,
--    where the date flips at 8pm Eastern — so an evening log landed on
--    tomorrow and "logged today" went to zero at dinner time. Keep in sync
--    with APP_TZ in lib/dates.ts.
ALTER TABLE adherence_logs
  ALTER COLUMN log_date SET DEFAULT ((now() AT TIME ZONE 'America/New_York')::date);

-- 2. Editing one item of the active plan in place ("let me edit it") is its
--    own kind of revision — calling it 'amendment' would claim an exercise
--    was added, and 'progression' that a chain was walked.
ALTER TABLE plans DROP CONSTRAINT plans_source_check;
ALTER TABLE plans ADD CONSTRAINT plans_source_check
  CHECK (source IN ('ai-draft', 'manual', 'progression', 'amendment', 'adjustment'));

ALTER TABLE plan_reviews DROP CONSTRAINT plan_reviews_outcome_check;
ALTER TABLE plan_reviews ADD CONSTRAINT plan_reviews_outcome_check
  CHECK (outcome IN ('progressed', 'regressed', 'revamped', 'no_change', 'amended', 'adjusted'));

-- 3. PT-authored progression edges ("exercises should be seen as a chain").
--    NULL = the global authored corridors, same ownership convention as
--    exercises.clinic_id. A clinic's own edges are visible only to it; the
--    (from, to) primary key means a clinic can't duplicate a global edge,
--    which is the right answer anyway.
ALTER TABLE exercise_progressions
  ADD COLUMN clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE;
