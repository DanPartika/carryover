-- Carryover walking-skeleton schema (PRD §3 data-model sketch, skeleton subset).
-- Episode/intake/exercise/plan/visit/adherence tables land with build-order
-- steps 1-4 — do not add them here; new tables come as new numbered migrations.

-- Users projection. lithe_user_id = Zitadel `sub` from the JWT (platform contract).
-- Nullable only to allow seeded dev/fixture users when running standalone without Lithe.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lithe_user_id  text UNIQUE,
  email          text,
  display_name   text,
  is_app_admin   boolean NOT NULL DEFAULT false,   -- Dan: clinic creation, library curation
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- Clinic from day 1 (PRD §1 decision 12): the tenancy seam for selling to
-- "a PT place" later. MVP UI assumes exactly one clinic.
CREATE TABLE clinics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- App roles within a clinic. A user can hold multiple roles in one clinic
-- (e.g. Dan = admin + patient). 'admin' is clinic-admin; app-wide superpowers
-- stay on users.is_app_admin.
CREATE TABLE clinic_members (
  clinic_id  uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('pt', 'patient', 'admin')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, user_id, role)
);

-- Many-to-many PT↔patient assignment, scoped to a clinic (PRD §1 decision 12).
CREATE TABLE pt_patients (
  clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  pt_user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active          boolean NOT NULL DEFAULT true,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, pt_user_id, patient_user_id)
);
