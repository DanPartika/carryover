# Carryover — PRD

Status: in build (step 0 done 2026-07-17) · Owner: Dan · Created 2026-07-16 · App #4 on the Lithe platform
Slug `carryover` · `apps/carryover/` (separate repo, cloned in, git-ignored — clientfirst model; **repo itself not yet created** — scaffold lives in the placeholder folder until Dan mints it) · dev port 3004 (dev DB on 5434)

**One-liner:** the loop between PT visits — the PT completes an intake, AI drafts
an exercise plan from a real library, the PT edits and approves it in minutes,
and the patient gets a phone-first home program they actually log against, so
the next visit starts from data instead of "did you do your exercises?"

**Positioning rule (doctrine, enforced in prompts and UI copy):** the AI
*drafts for the PT* — it never prescribes, never diagnoses, and nothing it
produces reaches a patient without explicit PT approval. Every patient-facing
screen reflects only PT-approved content. The product claim is "your PT's plan,
always with you," never "AI physical therapy."

**Second doctrine — the PT never does homework:** the PT is doing us a favor by
using this at all (v1 reality: Dan's own PT, using it on the side). First-run
setup < 5 minutes; per-visit interaction < 2 minutes; the AI drafts so the PT
edits instead of authors; in-office use is tap-tap-done, never forms.

**Why it wins** (10-vendor market scan, verified + adversarially re-checked
2026-07-16): the naive hypothesis was half wrong — a polished patient app with
adherence + pain logging is now **table stakes** (Physitrack/PhysiApp,
MedBridge GO, Rehab Guru, Wibbi all ship all of it), and "AI drafts, PT
approves" **already exists** (Physitrack's AI-assisted builder, VirtueLife's
30-second drafts, HEP.PRO). What nobody ships, verified across the scan:
**a stored per-patient home-equipment inventory that hard-constrains and
re-drafts the plan** (incumbents offer only manual equipment filters at
library-search time); **first-class office-vs-home adherence views**; and
**clean many-to-many coverage** (standalone HEP tools anchor programs to one
clinician — MedBridge users report programs effectively lost between logins).
The market's middle is soft: HEP2go is free but data-blind; Physitrack
($23.99/practitioner/mo, current price list) and MedBridge (HEP only in the
$325/yr Premium tier) are polished but per-seat with loud UX complaints. A
modern tool at SimpleSet-ish pricing ($11–15/seat) with Physitrack-grade
patient UX plus the equipment + coverage features has a clear wedge into
1–5-PT clinics. And strict grounding — *no hallucinated exercises, nothing
reaches a patient unapproved* — is a safety guarantee no incumbent markets,
even where they do it implicitly. Explicit non-goals: the library-size arms
race (Physitrack 18k / Wibbi 20k videos own it) and camera-based motion AI
(MedBridge, Exer, Kemtai, SPRY shipped it with FDA/enterprise resources).

---

## 1. Decisions (locked in planning interview, 2026-07-16)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Platform | **Own git repo cloned into `lithe/apps/<slug>`** (clientfirst repo model); consumes Lithe exactly like the other apps — zero Lithe edits |
| 2 | Stack | Next.js 16 + TS + Tailwind 4, own Postgres 16 container, copies breezy-bets/clientfirst auth + compose patterns |
| 3 | AI plumbing | **Only via platform `/v1/ai`** — route handlers forward the user's JWT via the Anthropic SDK (`baseURL` + `authToken`); no direct-Anthropic path |
| 4 | Reality level | Dogfood on Dan (post-op knee) immediately; **demo-grade ASAP** for showing potential clients; no PHI posture yet, sell-ready UX from first commit |
| 5 | First users | Dan = patient, **Dan's real PT = the PT persona** — PT UX must be self-explanatory with near-zero setup |
| 6 | Library seeding | **Two-layer**: free-exercise-db import (The Unlicense/public domain, 873 exercises — license verified from primary source) for late-phase strength breadth, + **hand-authored knee-rehab core** with owned media — the post-op staples exist in NO open dataset (verified 0–2 of 7 across all three; §2 Library) — plus PT uploads |
| 7 | Patient depth | View **+ adherence logging** (done, sets×reps actual, pain 0–10, effort, per-exercise note, flag-for-PT) |
| 8 | AI output | **Draft plan from library only** — sets/reps/frequency + one-line rationale per exercise; server rejects any exercise id not in the allowed slice; PT edits/approves; nothing patient-facing unsigned |
| 9 | Intake | **Structured fields + narrative box** |
| 10 | Notes | PT notes **private by default with per-note share toggle**; patient journal **always visible to their PT** |
| 11 | Scheduling | **Out of MVP**; visits exist as first-class records so appointments bolt on later |
| 12 | Tenancy | **Clinic entity from day 1**; PT↔patient many-to-many lives inside a clinic |
| 13 | Difficulty | **Progression chains** (exercise → harder variant edges) + level tags, alongside facets: body region, equipment, position |
| 14 | In-office | Usable in-office (visit record, tap exercises done, quick-add mid-session) but **not positioned as the PT's primary documentation tool** in v1 |
| 15 | Media | Dataset images + PT-uploaded images in MVP; **video = links/embeds only** (no object storage yet) |
| 16 | Home equipment | **Patient equipment inventory** from a curated catalog (TENS, bands, compression boots, …); constrains home assignments and the AI draft |

## 2. The product

**Personas.** Two in MVP: **PT** (desktop-first, but everything responsive) and
**Patient** (phone-first). A third, **clinic admin/front desk**, is modeled in
the roles table but has no UI in MVP. Many-to-many: a patient can see multiple
PTs at a clinic; a PT has many patients.

**PT loop:** complete intake (structured + narrative) → AI drafts a plan from
the library, already filtered by body region, contraindications, and the
patient's owned equipment → PT edits in a fast review UI (swap from the same
progression chain, adjust sets/reps/frequency, delete, add own, edit
rationale) → approve & assign (each item marked office / home / both) →
monitor the adherence dashboard between visits → progress items along their
chains when the data says so.

**Patient loop:** open app on phone → **Today** view of home exercises → two
tabs: **In office** (what was done at visits, read-only history) and **At
home** (assigned program) → each exercise: media, instructions, PT-edited
rationale ("why you're doing this"), prescribed sets×reps → log: done,
sets×reps actually completed, pain during (0–10), effort, optional note,
**flag for my PT** → streaks + simple progress view → journal notes (always
PT-visible).

**In-office quick mode:** the PT opens today's visit for a patient and taps
exercises as done in the room; quick-add is a type-ahead search where adding an
exercise takes seconds, not a form. A visit is a first-class record — the seam
where scheduling and visit-note documentation bolt on post-MVP.

**Exercise library — two layers, licensing verified 2026-07-16:**

- *Layer 1, breadth (imported day one):* **free-exercise-db** — The Unlicense
  (public domain dedication; verified from the LICENSE file and GitHub license
  API), 873 exercises with start/end JPG photo pairs and step instructions.
  Covers the late-phase return-to-strength catalog (56 squat variants, lunges,
  step-ups, 7 bridge variants, calf raises). Optional: cherry-pick wger's ~15
  rehab-adjacent records (clamshells ×4, wall slides, hip abduction) — but
  wger data is CC-BY-SA per record (attribution + share-alike), so either
  quarantine those rows with full bookkeeping or skip them to stay
  license-uniform. MuscleWiki and ExRx are **ruled out with evidence**
  (verified proprietary; never scrape — ExRx's paid API is the legitimate
  future route to pro video).
- *Layer 2, the knee-rehab core (authored in-house, ~30–40 exercises):* **no
  open dataset has it.** Quad sets, heel slides, SLR, terminal knee extension,
  and step-downs score 0/3 datasets each — verified by downloading and
  grepping all 2,008 records across the three open DBs. Instruction text
  grounded in NHS content (OGL v3.0: commercial use OK with "Information from
  the NHS website" attribution — **text only**, NHS videos/photos are
  excluded) and US public-domain NIA/CDC material; phases, progression
  criteria, and dosage grounded in CC-BY (never BY-NC) open-access protocols
  on PMC, cited per exercise. Media: our own two-frame line drawings
  (everkinetic's clean anatomical style is the model) — cheap, consistent,
  owned outright.
- *Schema:* every exercise row carries `license`, `license_author`, and
  `source_url` from day one (wger's per-record bookkeeping is the role model)
  because the library permanently mixes regimes: public-domain imports,
  OGL-derived text, clinic-owned uploads. No open dataset carries clinical
  fields (rehab phase, weight-bearing status, precautions) — that schema is
  designed in-house.

Facets: body region, equipment, position (standing/supine/prone/seated/side),
difficulty level (1–5), free tags. **Progression chains** are directed edges
(`quad set → straight-leg raise → step-down …`) with a note per edge; the UI
shows each exercise's "easier / harder" neighbors, and the plan editor offers
chain-mates as one-tap swaps. Clinic-scoped PT-created exercises (uploaded
images, video links) sit alongside imports. The knee corridor is hand-curated
to demo quality around Dan's actual protocol.

**Home equipment inventory:** a curated catalog (TENS unit, resistance bands
by level, compression boots, foam roller, step, stationary bike, ankle
weights, balance pad, ice machine, crutches, …). The patient checks off what
they own; the PT sees the inventory on the patient page; home assignments warn
when required equipment is missing; the AI draft only proposes home exercises
the patient can actually do, and the PT can **re-draft against a changed
inventory** in one tap. Verified differentiator: no vendor in the ten-vendor
scan stores a per-patient equipment profile at all — incumbents offer only
manual equipment filters at library-search time, and none cover modality
devices (TENS, compression). Cheap to build, instantly legible to a clinic
buyer, and the single most differentiated 30 seconds available on a demo
stage.

**Notes:** PT clinical notes are private by default with a per-note **share
to patient** toggle; patient journal entries are always visible to their PT
(that is their point). Notes attach to a patient or to a specific visit.

**AI surface (all via `/v1/ai`, all PT-facing):**
- **Plan draft** (the core): intake + filtered library slice in, structured
  plan out — `{exercise_id, sets, reps, frequency_per_week, hold_secs?,
  location: office|home|both, rationale, progression_note}` per item. Server
  validates every `exercise_id` against the slice it sent; hallucinated ids
  are dropped and logged. Regenerate is allowed; every draft is labeled
  "draft — nothing is assigned until you approve."
- **Adherence summary** (dashboard button, cheap): "Dan logged 9/12 sessions,
  pain trending 6→3, flagged lunges twice" — one small-model call over the
  log table, for the PT's eyes.

## 3. Architecture (summary)

**Platform integration:** SSO + `/v1/me` bootstrap (breezy-bets seam); users
referenced by `lithe_user_id`; patients onboard through the existing Lithe
invite → `/activate` flow; app-local `roles` table maps `lithe_user_id` →
pt | patient | admin per clinic. Own `docker-compose.yml` + own Postgres +
own nightly backup script; registered in Studio at runtime; zero Lithe edits.

**AI calls** only in route handlers, forwarding the user's JWT to
`{LITHE_CORE_INTERNAL_URL}/v1/ai/v1/messages` via the official Anthropic SDK.
Models env-configured: plan draft `claude-sonnet-5` (`<SLUG>_PLAN_MODEL`),
adherence summary `claude-haiku-4-5` (`<SLUG>_SUMMARY_MODEL`). Volume is tiny
(one draft per intake + occasional regenerate/summary) — cost is noise
compared to ClientFirst sessions.

**Data model sketch** (own Postgres; DDL at build time):

- `clinics` · `roles` (`lithe_user_id`, clinic, role) · `pt_patients`
  (many-to-many within clinic)
- `episodes` (patient + clinic + condition, open/closed) — one active episode
  auto-created in MVP UI; the seam for multi-issue patients later
- `intakes` (episode, structured JSONB + narrative, versioned by re-intake)
- `exercises` (source: dataset|clinic, media refs, position, difficulty,
  body_regions[], tags[]) · `exercise_equipment` · `exercise_progressions`
  (from_id, to_id, note) · `equipment_catalog` · `patient_equipment`
- `plans` (episode, status draft|active|retired, approved_by/at) ·
  `plan_items` (exercise, sets/reps/frequency/hold, location, rationale)
- `visits` (patient, PT, date) · `visit_exercises` (tap-done records)
- `adherence_logs` (plan_item, date, completed, sets_done, reps_done,
  pain_0_10, effort, note, flag_for_pt)
- `notes` (author, patient, visit?, visibility private|shared, body)
- `ai_call_log` (mirrors the clientfirst pattern)

**Responsive posture:** one Next.js app; patient routes designed phone-first
(large tap targets for mid-exercise logging), PT routes desktop-first; both
fully usable on either. No push notifications in MVP (deferred, §9).

## 4. MVP cut line

**IN:** library import + browse/filter with facets and progression chains ·
hand-curated knee corridor · clinic + roles + many-to-many assignment +
patient invite via Lithe · intake (structured + narrative) · AI plan draft →
edit → approve → assign · patient Today view + office/home tabs + full
adherence logging + equipment inventory · PT adherence dashboard (compliance %,
pain trend, flags) + AI summary button · in-office visit record with tap-done
and quick-add · notes both sides with the privacy model · own DB + backup
script · fixture AI provider for offline dev.

**OUT (explicit):** scheduling/calendar (visits are the seam) · push/email
reminders · video uploads (links only; object storage is the trigger) ·
messaging/chat · SOAP-note documentation as an EMR replacement · payments +
self-signup · patient self-registration (invite-only) · multi-clinic UI
(model supports it; UI assumes one clinic) · outcome-measure instruments
(LEFS, KOOS — strong post-MVP candidate for clinic sales) · HIPAA hardening
(encryption at rest, audit trail, BAA hosting — REQUIRED before any real
patient who isn't Dan; documented wall, §6 risks).

**The demo script** (the five moments that sell, per the verified competitor
scan — the MVP is built so these run live without smoke):

1. **The 60-second loop:** intake on a tablet → AI draft appears, grounded in
   real library items → PT deletes one exercise, tweaks reps, taps Approve →
   plan lands on the demo phone. Every 2026 vendor headlines speed-to-plan;
   doing it live with visible PT control beats the claim.
2. **The equipment toggle:** mark "no resistance bands; owns TENS +
   compression boots" → watch the draft re-generate using only what's in the
   patient's home. No incumbent can replicate this on stage.
3. **The office-vs-home dashboard:** "here's what Maria did at home since
   Tuesday — 5 of 6 sessions, pain 6→3 — and how that compares to what she
   shows you in clinic." Adherence-with-pain-overlay is what sold
   practitioners on Physitrack; the split view makes it feel like new
   information.
4. **The coverage handoff:** a covering PT opens a colleague's patient, sees
   the approved plan and full home log, adjusts one thing, done. Contrast
   with MedBridge users' reports of programs disappearing between logins.
5. **The patient's phone in the buyer's hand:** clean media, one-tap
   "done + pain 0–10." Close on the anti-complaint checklist drawn from
   MedBridge GO's app-store reviews: logs are editable, sessions never lost,
   videos match prescribed dosage.

## 5. Build order

| Step | What | Proves |
|---|---|---|
| 0 | Walking skeleton: scaffold from clientfirst/breezy-bets patterns, compose + db, migration runner, register in Studio, SSO via `/apps/<slug>`, `/api/bootstrap` | whole stack works before feature code |
| 1 | Library: free-exercise-db import + per-record license bookkeeping, browse + facet filtering, exercise detail, progression edges; author the knee-rehab core (NHS/NIA-grounded text, own line art) | the content moat, visible |
| 2 | People: clinic, roles, PT↔patient assignment, patient invited through Lithe activate flow | both personas real |
| 3 | Intake → AI draft → edit/approve/assign (fixtures first, then `/v1/ai`) | **the wow demo** |
| 4 | Patient home: Today view, office/home tabs, adherence logging, equipment inventory | the retention loop |
| 5 | PT dashboard: compliance, pain trend, flags, AI summary | **the sellable proof** |
| 6 | In-office quick mode: visit record, tap-done, type-ahead quick-add | the office story |
| 7 | Notes + polish + Dan's real protocol seeded end-to-end; PT onboarding pass (first-run < 5 min, measured) | dogfood + demo-grade |

Dogfood gate: after step 4 Dan uses it daily for his own knee program; after
step 7 his PT gets the invite.

## 6. Top risks

- **Open-dataset rehab gap** — verified, not hypothetical: there is **no
  openly licensed post-op rehab dataset, full stop**. The seven post-op knee
  staples score 0–2 of 7 in every open DB (all 2,008 records across the three
  datasets downloaded and grepped); free-exercise-db has no rehab/mobility
  category at all, and openly licensed rehab *media* is essentially
  nonexistent. Mitigation: the authored knee corridor is in the MVP cut, its
  media is owned outright, and the clinical schema (phase, precautions,
  weight-bearing status) is designed in-house — the dataset only provides the
  late-phase strength layer.
- **PT adoption friction** — the v1 PT is doing Dan a favor. If first-run
  setup exceeds ~5 minutes or per-visit use exceeds ~2, it dies quietly.
  Mitigation: doctrine #2, AI drafts, quick-add, and step 7's measured
  onboarding pass.
- **Medical-advice posture** — an AI that "recommends exercises" reads as
  practicing PT without a license if framing slips. Mitigation: doctrine #1
  (draft-for-the-PT only, approval gate, no diagnosis claims anywhere in copy),
  same discipline ClientFirst applies to its positioning rule.
- **PHI creep** — dogfood data is Dan's own; the moment a real patient who
  isn't Dan enters, HIPAA posture (encryption at rest, audit logging,
  BAA-able hosting, retention policy) becomes mandatory. Documented as a hard
  wall in §4 OUT — demoing to clinics with synthetic patients is fine, onboarding
  their patients is not, until the compliance pass ships.
- **Media licensing** — only verified-license media is imported (verification
  is part of step 1's import pipeline, not an afterthought). Caveats from the
  2026-07-16 license verification pass: NHS OGL is **text-only** (their
  videos/photos of people are excluded as personal data) and adds a
  **no-charge condition** — NHS-derived content itself can't be the paywalled
  good (get a legal read before charging clinics for access); NIA's
  public-domain grant is text-scoped ("unless otherwise indicated") — check
  media per item; MuscleWiki and ExRx are confirmed proprietary — never
  scrape. PT uploads carry an "I own this content" attestation.

## 7. Open questions (Dan)

1. **Name — DECIDED 2026-07-17: Carryover.** (Dan initially picked Thrive from
   an unchecked idea batch; a collision check found Thrive is Sword Health's
   AI MSK-recovery product plus Thrive Physical Therapy Partners — a clinic
   platform in the exact future market — so Dan switched to the cleared
   recommendation.) The original shortlist, kept for the record:
   - **Carryover** (slug `carryover`) — *recommended.* The literal clinical
     term for gains transferring from clinic to home: the product's thesis in
     one word, and PTs write it in their notes ("good carryover to home
     program"). Survived a full adversarial attack: no app-store, Crunchbase/
     PitchBook, Product Hunt, or visible-trademark collision in health/PT/
     fitness; carryover.com/.app show no active site. Caveats: generic
     clinical vocabulary may be harder to trademark-enforce, the term also
     lives in speech-therapy branding territory, and a full USPTO search
     remains undone.
   - **Bolster** — runner-up. The prop on every PT treatment table + the verb
     for "support/strengthen"; warm on the patient side. Adversarial re-check
     found one in-class nuance: a credential-gated academic caregiver-study
     app named Bolster in the App Store health category (non-commercial — low
     practical risk). Expect a bolster.health-style domain.
   - **Ruled out with evidence:** HomeStretch (live same-name in-home
     PT/stretching app on both stores + a PT clinic at homestretchpt.com),
     Rebound (genericized across PT clinics; getrebound.ai is a same-category
     app), Flexion (FlexionLabs is essentially this product), Stride
     (stridethera.com — funded PT/OT/SLP EMR startup, $6M), Mend (mend.com
     telehealth, 17k providers), Glide (Glide Health/McKesson), Knit
     (knit.health — $11.6M seed, May 2026), Recoup (crowded recovery-brand
     space), Lithe (phonetically identical to the live "Lythe" stretch app —
     and it's the platform's name).
2. **Progression visibility to patients** — should the patient see the chain
   ("what you unlock next")? Motivating, but might invite self-progression
   against the PT's pacing. Lean: show the chain, lock the pacing ("your PT
   decides when").
3. **AI rationale patient-visibility** — after PT approval, the per-exercise
   rationale ships to the patient as "why you're doing this" (PT can edit it
   first). Confirm you're comfortable with AI-drafted, PT-edited text being
   patient-visible.
4. **Reminder channel post-MVP** — when reminders come, email vs PWA push vs
   SMS changes the architecture. No decision needed now, flagging the fork.

## 8. Deferred TODOs

- Reminders/notifications (§7 Q4) — after dogfood shows where adherence dips.
- Object storage + video upload — trigger: first PT who films their own
  content; until then, video links/embeds.
- Outcome measures (LEFS/KOOS) — high clinic-sales value, post-MVP.
- Scheduling — visits table is the seam; revisit when a clinic asks.
- HIPAA compliance pass — hard prerequisite for real patients (§6).
- Multi-clinic admin UI — model ready, UI when there are two clinics.
- **RTM billing story (CPT 98975–98981)** — the market's #1 small-clinic ROI
  pitch ($77–116/patient/month under 2026 Medicare rates), and our adherence +
  pain logs are exactly the data RTM requires. Surface an RTM export/billing
  view before selling into US clinics — leaving it out cedes the strongest
  ROI argument to Limber/Kemtai/Exer.
- **EMR bridge** — "no EMR integration" is the canonical HEP2go complaint and
  WebPT's whole moat. A copy-to-clipboard / PDF export of plan + adherence
  summary is a cheap v1.x credibility patch; real integrations much later.
