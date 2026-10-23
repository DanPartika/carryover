-- A doctor's plan on the intake.
--
-- A referral, a surgeon's protocol, an order sheet: the referring provider often
-- has a plan the PT is expected to follow, and until now it had nowhere to go —
-- the first real one got pasted into the "condition" box. Two pieces, kept apart
-- on purpose:
--
--   intakes.provider_plan   the pasted TEXT. It travels with the intake like any
--                           other field (a superseding intake carries it forward)
--                           and is the ONLY part a model ever reads, after
--                           identifiers are redacted.
--   intake_documents        attached FILES (PDF, photo, Word, text). They belong
--                           to the episode, not to one intake row, because an
--                           intake is superseded every time it is edited and a
--                           referral PDF should not vanish with it. Never sent to
--                           the AI: a scan cannot be de-identified.
--
-- Removing a file deletes its contents but keeps the row — a record that something
-- was attached, by whom, and when — so "the doctor sent a protocol" never becomes
-- unknowable, while a patient who withdraws a document really does withdraw it.

ALTER TABLE intakes ADD COLUMN provider_plan text;

CREATE TABLE intake_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id     uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  uploaded_by    uuid NOT NULL REFERENCES users(id),
  uploader_role  text NOT NULL CHECK (uploader_role IN ('patient', 'pt')),
  filename       text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  -- Chosen by the server from the file's own bytes (lib/intake/documents.ts),
  -- never copied from what the browser said.
  content_type   text NOT NULL CHECK (content_type IN (
                   'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
                   'image/heic', 'text/plain',
                   'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes     integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  data           bytea,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  -- A live file has its bytes; a removed one has none.
  CHECK ((removed_at IS NULL) = (data IS NOT NULL))
);

CREATE INDEX intake_documents_episode_idx ON intake_documents (episode_id, created_at);

-- A closed episode takes no new files — same backstop as every other child table.
CREATE TRIGGER intake_documents_episode_open BEFORE INSERT ON intake_documents
  FOR EACH ROW EXECUTE FUNCTION episode_must_be_open();
