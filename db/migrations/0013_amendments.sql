-- Hand amendments (Dan's ask: "after the AI makes it and I approve the plan,
-- let me add new exercises as I see fit").
--
-- Approved plans stay immutable (doctrine #1 — the approved record is what the
-- patient saw), so adding one exercise is a REVISION like a progression swap:
-- a new plan that copies everything and appends one item. What needs schema is
-- only the vocabulary to record it honestly — calling it 'progression' would
-- claim a chain was walked, and 'revamped' would claim the AI redrew the phase.

ALTER TABLE plans DROP CONSTRAINT plans_source_check;
ALTER TABLE plans ADD CONSTRAINT plans_source_check
  CHECK (source IN ('ai-draft', 'manual', 'progression', 'amendment'));

ALTER TABLE plan_reviews DROP CONSTRAINT plan_reviews_outcome_check;
ALTER TABLE plan_reviews ADD CONSTRAINT plan_reviews_outcome_check
  CHECK (outcome IN ('progressed', 'regressed', 'revamped', 'no_change', 'amended'));
