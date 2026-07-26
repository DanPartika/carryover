-- Adherence logging (PRD build step 4: the retention loop). One row per plan
-- item per day — a patient can revise today's log but not fork it, which is
-- also what makes streaks a plain "distinct log_date" count.
CREATE TABLE adherence_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_item_id    uuid NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  patient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date        date NOT NULL DEFAULT CURRENT_DATE,
  completed       boolean NOT NULL DEFAULT true,
  sets_done       int CHECK (sets_done BETWEEN 0 AND 20),
  reps_done       int CHECK (reps_done BETWEEN 0 AND 100),
  pain            int CHECK (pain BETWEEN 0 AND 10),
  effort          int CHECK (effort BETWEEN 1 AND 5),      -- 1 easy .. 5 very hard
  note            text,
  flag_for_pt     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_item_id, log_date)
);
CREATE INDEX adherence_logs_patient_date_idx ON adherence_logs (patient_user_id, log_date);
