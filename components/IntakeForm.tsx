"use client";

// One intake form, two personas. The PT sees clinical shorthand and the
// fields that need a trained eye (restrictions/precautions); the patient
// sees waiting-room language and never sees the PT-only fields. One
// component on one vocabulary (lib/intake/fields.ts) so the two halves ask
// the same questions and can never drift apart.

import { useState } from "react";
import {
  CONDITION_OPTIONS,
  MAX_LIMITED_ACTIVITIES,
  ONSET_KIND_OPTIONS,
  PAIN_PATTERN_OPTIONS,
  RED_FLAG_OPTIONS,
  REGION_OPTIONS,
  SIDE_OPTIONS,
  TRAJECTORY_OPTIONS,
  WORST_TIME_OPTIONS,
  type IntakeRecord,
  type LimitedActivity,
} from "@/lib/intake/fields";

/** Everything the form submits; both API routes parse it with the same
 *  parseIntakeFields. Condition is the only required field. */
export type IntakePayload = Record<string, unknown>;

const inputCls =
  "w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent";
const numCls =
  "w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent";

function Chip({
  on,
  label,
  onClick,
  tone = "accent",
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  tone?: "accent" | "flag";
}) {
  const active =
    tone === "flag"
      ? "border-flag bg-flag text-white"
      : "border-accent-deep bg-accent-deep text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs ${on ? active : "border-edge text-muted hover:bg-raise"}`}
    >
      {label}
    </button>
  );
}

/** Single-pick chip row; picking the active one clears it (all optional). */
function PickOne({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<readonly [string, string]>;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <Chip key={v} on={value === v} label={label} onClick={() => onChange(value === v ? null : v)} />
      ))}
    </div>
  );
}

function PickMany({
  options,
  value,
  onChange,
  tone = "accent",
}: {
  options: ReadonlyArray<readonly [string, string]>;
  value: string[];
  onChange: (v: string[]) => void;
  tone?: "accent" | "flag";
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <Chip
          key={v}
          on={value.includes(v)}
          label={label}
          tone={tone}
          onClick={() =>
            onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
          }
        />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">{label}</p>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg bg-raise/40 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      {children}
    </div>
  );
}

export default function IntakeForm({
  persona,
  initial,
  initialBirthYear,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  persona: "pt" | "patient";
  initial: IntakeRecord | null;
  initialBirthYear: number | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (payload: IntakePayload) => void;
  onCancel: () => void;
}) {
  const pt = persona === "pt";

  const [condition, setCondition] = useState(initial?.condition ?? "");
  const [side, setSide] = useState<string | null>(initial?.side ?? null);
  const [regions, setRegions] = useState<string[]>(initial?.bodyRegions ?? (pt ? ["knee"] : []));
  const [onsetDate, setOnsetDate] = useState(initial?.onsetDate ?? "");
  const [onsetKind, setOnsetKind] = useState<string | null>(initial?.onsetKind ?? null);
  const [trajectory, setTrajectory] = useState<string | null>(initial?.trajectory ?? null);
  const [hadBefore, setHadBefore] = useState<boolean | null>(initial?.hadBefore ?? null);
  const [mechanism, setMechanism] = useState(initial?.mechanism ?? "");

  const [painNow, setPainNow] = useState(initial?.painNow?.toString() ?? "");
  const [painAvg, setPainAvg] = useState(initial?.painAvg?.toString() ?? "");
  const [painWorst, setPainWorst] = useState(initial?.painWorst?.toString() ?? "");
  const [painPattern, setPainPattern] = useState<string | null>(initial?.painPattern ?? null);
  const [aggravators, setAggravators] = useState(initial?.aggravators ?? "");
  const [easers, setEasers] = useState(initial?.easers ?? "");
  const [nightPain, setNightPain] = useState<boolean | null>(initial?.nightPain ?? null);
  const [worstTime, setWorstTime] = useState<string | null>(initial?.worstTime ?? null);

  const [activities, setActivities] = useState<{ activity: string; rating: string }[]>(() => {
    const init = (initial?.limitedActivities ?? []).map((a: LimitedActivity) => ({
      activity: a.activity,
      rating: a.rating.toString(),
    }));
    while (init.length < MAX_LIMITED_ACTIVITIES) init.push({ activity: "", rating: "" });
    return init;
  });
  const [assistiveDevice, setAssistiveDevice] = useState(initial?.assistiveDevice ?? "");
  const [goals, setGoals] = useState(initial?.goals ?? "");

  const [birthYear, setBirthYear] = useState(initialBirthYear?.toString() ?? "");
  const [conditions, setConditions] = useState<string[]>(initial?.conditions ?? []);
  const [redFlags, setRedFlags] = useState<string[]>(initial?.redFlags ?? []);
  const [medications, setMedications] = useState(initial?.medications ?? "");
  const [surgeries, setSurgeries] = useState(initial?.surgeries ?? "");

  const [imaging, setImaging] = useState(initial?.imaging ?? "");
  const [priorTreatment, setPriorTreatment] = useState(initial?.priorTreatment ?? "");
  const [occupation, setOccupation] = useState(initial?.occupation ?? "");
  const [activityLevel, setActivityLevel] = useState(initial?.activityLevel ?? "");

  const [restrictions, setRestrictions] = useState(initial?.restrictions ?? "");
  const [narrative, setNarrative] = useState(initial?.narrative ?? "");

  function payload(): IntakePayload {
    return {
      condition,
      side,
      bodyRegions: regions,
      onsetDate: onsetDate || null,
      onsetKind,
      trajectory,
      hadBefore,
      mechanism,
      painNow: painNow === "" ? null : Number(painNow),
      painAvg: painAvg === "" ? null : Number(painAvg),
      painWorst: painWorst === "" ? null : Number(painWorst),
      painPattern,
      aggravators,
      easers,
      nightPain,
      worstTime,
      limitedActivities: activities
        .filter((a) => a.activity.trim() && a.rating !== "")
        .map((a) => ({ activity: a.activity, rating: Number(a.rating) })),
      assistiveDevice,
      goals,
      birthYear: birthYear === "" ? null : Number(birthYear),
      conditions,
      redFlags,
      medications,
      surgeries,
      imaging,
      priorTreatment,
      occupation,
      activityLevel,
      ...(pt ? { restrictions } : {}),
      narrative,
    };
  }

  function setActivity(i: number, patch: Partial<{ activity: string; rating: string }>) {
    setActivities((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }

  const yesNo = (v: boolean | null, set: (b: boolean | null) => void) => (
    <div className="flex gap-1.5">
      <Chip on={v === true} label="Yes" onClick={() => set(v === true ? null : true)} />
      <Chip on={v === false} label="No" onClick={() => set(v === false ? null : false)} />
    </div>
  );

  return (
    <div className="mt-3 space-y-3 text-sm">
      <Section title={pt ? "Presentation" : "What's going on"}>
        <input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder={
            pt
              ? "Condition / procedure (e.g. post-op ACL reconstruction, right knee)"
              : "In your own words, what brings you in? (e.g. right knee pain after surgery)"
          }
          className={inputCls}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Side" : "Which side?"}>
            <PickOne options={SIDE_OPTIONS} value={side} onChange={setSide} />
          </Field>
          <Field label={pt ? "Body regions" : "Where is it?"}>
            <PickMany options={REGION_OPTIONS} value={regions} onChange={setRegions} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-muted">{pt ? "Surgery/onset" : "When did it start?"}</span>
            <input
              type="date"
              value={onsetDate}
              onChange={(e) => setOnsetDate(e.target.value)}
              className="rounded-lg border border-edge bg-card px-2 py-1.5"
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Onset" : "How did it start?"}>
            <PickOne options={ONSET_KIND_OPTIONS} value={onsetKind} onChange={setOnsetKind} />
          </Field>
          <Field label={pt ? "Course since onset" : "Since then, is it…"}>
            <PickOne options={TRAJECTORY_OPTIONS} value={trajectory} onChange={setTrajectory} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Prior episode of the same problem" : "Have you had this before?"}>
            {yesNo(hadBefore, setHadBefore)}
          </Field>
          <Field label={pt ? "Mechanism" : "What happened, exactly?"}>
            <input
              value={mechanism}
              onChange={(e) => setMechanism(e.target.value)}
              placeholder={pt ? "twisting landing from a jump…" : "what were you doing when it started?"}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title="Pain">
        <div className="flex flex-wrap items-center gap-3">
          {(
            [
              [pt ? "Now" : "Right now", painNow, setPainNow],
              [pt ? "Avg (48h)" : "Average lately", painAvg, setPainAvg],
              [pt ? "Worst" : "At its worst", painWorst, setPainWorst],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label} className="flex items-center gap-2">
              <span className="text-muted">{label}</span>
              <input
                type="number"
                min={0}
                max={10}
                value={value}
                onChange={(e) => set(e.target.value)}
                className={numCls}
              />
              <span className="text-xs text-muted">/10</span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Pattern" : "Is the pain…"}>
            <PickOne options={PAIN_PATTERN_OPTIONS} value={painPattern} onChange={setPainPattern} />
          </Field>
          <Field label={pt ? "Worst time of day" : "When is it worst?"}>
            <PickOne options={WORST_TIME_OPTIONS} value={worstTime} onChange={setWorstTime} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Aggravating factors" : "What makes it worse?"}>
            <input
              value={aggravators}
              onChange={(e) => setAggravators(e.target.value)}
              placeholder={pt ? "stairs, deep squat, sitting > 30 min…" : "stairs, sitting a long time…"}
              className={inputCls}
            />
          </Field>
          <Field label={pt ? "Easing factors" : "What makes it better?"}>
            <input
              value={easers}
              onChange={(e) => setEasers(e.target.value)}
              placeholder={pt ? "rest, ice, movement…" : "rest, ice, moving around…"}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label={pt ? "Night pain" : "Does it wake you up at night?"}>
          {yesNo(nightPain, setNightPain)}
        </Field>
      </Section>

      <Section title={pt ? "Function & goals" : "What it's getting in the way of"}>
        <Field
          label={
            pt
              ? "Limited activities, rated 0-10 (these become the goals every review measures)"
              : "Up to 3 things this stops you doing — rate each today: 0 = can't do it at all, 10 = no problem"
          }
        >
          <div className="space-y-2">
            {activities.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={a.activity}
                  onChange={(e) => setActivity(i, { activity: e.target.value })}
                  placeholder={
                    ["e.g. climbing stairs", "e.g. sleeping through the night", "e.g. a full day at work"][i]
                  }
                  className={inputCls}
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={a.rating}
                  onChange={(e) => setActivity(i, { rating: e.target.value })}
                  className={numCls}
                />
                <span className="text-xs text-muted">/10</span>
              </div>
            ))}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Assistive device" : "Using a cane, brace, or walker?"}>
            <input
              value={assistiveDevice}
              onChange={(e) => setAssistiveDevice(e.target.value)}
              placeholder={pt ? "none / cane / brace…" : "leave blank if none"}
              className={inputCls}
            />
          </Field>
          <Field label={pt ? "Patient goals" : "What do you want to get back to?"}>
            <input
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              placeholder={pt ? "return to running, stairs without pain…" : "running, hiking, picking up your kid…"}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title={pt ? "History" : "Your health background"}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-muted">{pt ? "Birth year" : "What year were you born?"}</span>
            <input
              type="number"
              min={1900}
              max={2100}
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value)}
              className="w-20 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent"
            />
          </label>
        </div>
        <Field label={pt ? "Comorbidities" : "Do any of these apply to you?"}>
          <PickMany options={CONDITION_OPTIONS} value={conditions} onChange={setConditions} />
        </Field>
        <Field
          label={
            pt
              ? "Red-flag screen"
              : "Have you noticed any of these lately? (they help your PT keep you safe)"
          }
        >
          <PickMany options={RED_FLAG_OPTIONS} value={redFlags} onChange={setRedFlags} tone="flag" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Medications" : "Medications you take"}>
            <input
              value={medications}
              onChange={(e) => setMedications(e.target.value)}
              placeholder={pt ? "incl. blood thinners, steroids…" : "prescription or over-the-counter"}
              className={inputCls}
            />
          </Field>
          <Field label={pt ? "Surgical history" : "Past surgeries"}>
            <input
              value={surgeries}
              onChange={(e) => setSurgeries(e.target.value)}
              placeholder={pt ? "procedure + year" : "what and roughly when"}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Imaging" : "Any scans or X-rays for this?"}>
            <input
              value={imaging}
              onChange={(e) => setImaging(e.target.value)}
              placeholder={pt ? "MRI 6/26 — partial meniscus tear" : "what kind, and what were you told?"}
              className={inputCls}
            />
          </Field>
          <Field label={pt ? "Prior treatment" : "Tried anything for it already?"}>
            <input
              value={priorTreatment}
              onChange={(e) => setPriorTreatment(e.target.value)}
              placeholder={pt ? "prior PT, injections — response" : "PT, chiropractor, injections — did it help?"}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title={pt ? "Demands" : "Your days"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={pt ? "Occupation" : "What do you do for work?"}>
            <input
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              placeholder={pt ? "incl. physical demands" : "your job, or student / retired"}
              className={inputCls}
            />
          </Field>
          <Field label={pt ? "Activity level / sport" : "How active are you normally?"}>
            <input
              value={activityLevel}
              onChange={(e) => setActivityLevel(e.target.value)}
              placeholder={pt ? "runs 3x/wk, rec soccer" : "e.g. gym twice a week, weekend hikes"}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      {pt && (
        <Section title="Restrictions / precautions (PT)">
          <textarea
            value={restrictions}
            onChange={(e) => setRestrictions(e.target.value)}
            rows={2}
            placeholder="Weight-bearing status, ROM limits, surgeon protocol…"
            className={inputCls}
          />
        </Section>
      )}

      <textarea
        value={narrative}
        onChange={(e) => setNarrative(e.target.value)}
        placeholder={pt ? "Narrative — anything the form missed" : "Anything else your PT should know?"}
        rows={3}
        className={inputCls}
      />

      <div className="flex gap-2">
        <button
          onClick={() => onSubmit(payload())}
          disabled={!condition.trim() || busy}
          className="rounded-lg bg-accent-deep px-4 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-edge px-4 py-2 text-muted hover:bg-raise"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
