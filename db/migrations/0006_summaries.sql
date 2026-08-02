-- Adherence summaries (PRD build step 5): the AI's read of a patient's home
-- logs, written for the PT's eyes only. Stored rather than ephemeral so the
-- summary the PT generated before a visit is still on screen during it.
--
-- logs_through is the staleness key. It records the newest adherence_logs
-- .updated_at that existed when the summary was written, so the dashboard can
-- say "3 logs since this was generated" instead of quietly showing the PT an
-- opinion formed before the flag they need to see. A stored summary with no
-- freshness marker is worse than no summary.
CREATE TABLE adherence_summaries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  body          text NOT NULL,
  window_days   int NOT NULL,
  logs_through  timestamptz,               -- NULL = generated over an empty log table
  mode          text NOT NULL,             -- 'lithe' | 'fixture', mirrors ai_call_log
  model         text,
  generated_by  uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The dashboard only ever reads the newest one per episode.
CREATE INDEX adherence_summaries_episode_idx
  ON adherence_summaries (episode_id, created_at DESC);
