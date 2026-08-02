-- Notes, both sides (PRD build step 7, and PRD §1's privacy decision).
--
-- Two different things share one table because they are the same shape and
-- the PT reads them in one stream:
--   * PT notes are PRIVATE by default with a per-note share toggle. A PT has
--     to be able to write "suspect she's guarding the knee, watch it" without
--     the patient reading it.
--   * The patient's journal is ALWAYS visible to the PT. There is no private
--     patient note — writing one would be writing into a void, since the whole
--     point is telling the clinician something.
--
-- That asymmetry is a CHECK constraint, not a convention: a route bug must not
-- be able to create a patient note the PT can never see.
CREATE TABLE notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  author_role    text NOT NULL CHECK (author_role IN ('pt', 'patient')),
  body           text NOT NULL,
  shared         boolean NOT NULL DEFAULT false,
  -- Set when the note was written during a session, so a visit can show its
  -- own notes. SET NULL on delete: losing the visit must not lose the note.
  visit_id       uuid REFERENCES visits(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_patient_notes_are_always_shared
    CHECK (author_role <> 'patient' OR shared)
);

CREATE INDEX notes_episode_idx ON notes (episode_id, created_at DESC);
