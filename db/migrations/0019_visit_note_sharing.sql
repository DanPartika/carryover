-- A PT's per-exercise visit note is theirs until they say otherwise.
--
-- The editor prompts for it as a working note ("how it went, cues that worked,
-- what to try next time"), and nothing told the PT that the patient's In-office
-- tab was reading it back. A note is now shared only when the PT ticks "share
-- with the patient" on that note, and the default is no.
--
-- Existing notes default to private, so they stop reaching patients the moment
-- this applies; the PT can share any of them from the visit. The visit's own
-- one-line wrap-up is a different thing — it is written FOR the patient and is
-- labelled as such — and is unchanged.

ALTER TABLE visit_items
  ADD COLUMN note_shared boolean NOT NULL DEFAULT false,
  -- Sharing nothing is not a choice: a shared flag needs a note under it.
  ADD CONSTRAINT visit_items_shared_has_note CHECK (NOT note_shared OR note IS NOT NULL);
