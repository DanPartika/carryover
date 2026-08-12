-- Two hardenings the bug-round review demanded.

-- 1. ONE active plan per episode, enforced by the database. Every revision
--    route retires-then-activates inside a transaction, but two concurrent
--    revisions (two tabs, PT + patient's PT both acting) could each read
--    status='active' before either committed and leave two active plans —
--    after which every "the active plan" query picks one nondeterministically.
--    Retire the older duplicates first so the index can build on any
--    existing data.
UPDATE plans p SET status = 'retired', retired_at = now()
WHERE p.status = 'active' AND EXISTS (
  SELECT 1 FROM plans p2
  WHERE p2.episode_id = p.episode_id AND p2.status = 'active'
    AND (p2.approved_at > p.approved_at
         OR (p2.approved_at = p.approved_at AND p2.id > p.id))
);

CREATE UNIQUE INDEX plans_one_active ON plans (episode_id) WHERE status = 'active';

-- 2. Re-date the logs UTC mis-stamped. Until 0014, log_date came from
--    CURRENT_DATE on a UTC clock, so anything logged 8pm-midnight Eastern
--    carries the NEXT day's date — holes in the streak strip, sessions
--    attributed a day late, and (worst) a "today" row the new
--    one-row-per-exercise-per-day upsert would silently merge tomorrow's log
--    into. created_at (timestamptz) still knows the truth — but ONLY for rows
--    the default stamped: a row whose log_date differs from created_at's UTC
--    date was written with an explicit date (seeded demo data) and must not
--    be collapsed onto its insert moment. Rows whose corrected date would
--    collide with an existing row are also left alone — a duplicate is worth
--    less than a lost log.
UPDATE adherence_logs al
SET log_date = (al.created_at AT TIME ZONE 'America/New_York')::date
WHERE al.log_date = (al.created_at AT TIME ZONE 'UTC')::date
  AND al.log_date <> (al.created_at AT TIME ZONE 'America/New_York')::date
  AND NOT EXISTS (
    SELECT 1 FROM adherence_logs x
    WHERE x.id <> al.id
      AND x.log_date = (al.created_at AT TIME ZONE 'America/New_York')::date
      AND ((al.plan_item_id IS NOT NULL AND x.plan_item_id = al.plan_item_id)
        OR (al.plan_item_id IS NULL AND x.plan_item_id IS NULL
            AND x.patient_user_id = al.patient_user_id
            AND x.exercise_id = al.exercise_id))
  );
