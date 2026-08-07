"use client";

// The intake as the PT reads it — every populated field, nothing invented,
// and red flags first because in a real clinic those route the whole
// conversation. Empty fields simply don't render: an intake with 8 answers
// reads as 8 lines, not 25 dashes.

import {
  CONDITION_OPTIONS,
  labelFor,
  ONSET_KIND_OPTIONS,
  PAIN_PATTERN_OPTIONS,
  RED_FLAG_OPTIONS,
  SIDE_OPTIONS,
  TRAJECTORY_OPTIONS,
  WORST_TIME_OPTIONS,
  type IntakeRecord,
} from "@/lib/intake/fields";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export default function IntakeSummary({
  intake,
  birthYear,
  patientSubmitted,
}: {
  intake: IntakeRecord;
  birthYear: number | null;
  patientSubmitted: boolean;
}) {
  const pains = [
    intake.painNow !== null ? `now ${intake.painNow}` : null,
    intake.painAvg !== null ? `avg ${intake.painAvg}` : null,
    intake.painWorst !== null ? `worst ${intake.painWorst}` : null,
  ].filter(Boolean);

  const onsetBits = [
    intake.onsetDate,
    intake.onsetKind ? labelFor(ONSET_KIND_OPTIONS, intake.onsetKind).toLowerCase() : null,
    intake.trajectory ? labelFor(TRAJECTORY_OPTIONS, intake.trajectory).toLowerCase() : null,
    intake.hadBefore === true ? "recurrent" : null,
  ].filter(Boolean);

  const age = birthYear ? new Date().getFullYear() - birthYear : null;

  return (
    <div className="mt-3 space-y-3">
      {patientSubmitted && (
        <p className="rounded-lg bg-[var(--color-clinic)]/10 px-3 py-2 text-xs">
          <span className="font-semibold">Patient-submitted</span> — filled in before the
          visit on {new Date(intake.createdAt).toLocaleDateString()}. Review it, then save
          your own intake to make it yours.
        </p>
      )}

      {intake.redFlags.length > 0 && (
        <div className="rounded-lg border border-flag bg-flag/10 px-3 py-2 text-sm">
          <p className="font-semibold text-flag">⚑ Screening answers to talk through</p>
          <ul className="mt-1 list-disc pl-5">
            {intake.redFlags.map((f) => (
              <li key={f}>{labelFor(RED_FLAG_OPTIONS, f)}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <Row
          label="Condition"
          value={
            intake.side && intake.side !== "na"
              ? `${intake.condition} (${labelFor(SIDE_OPTIONS, intake.side).toLowerCase()})`
              : intake.condition
          }
        />
        <Row label="Age" value={age ? `${age} (b. ${birthYear})` : null} />
        <Row label="Onset" value={onsetBits.length ? onsetBits.join(" · ") : null} />
        <Row label="Mechanism" value={intake.mechanism} />
        <Row label="Pain /10" value={pains.length ? pains.join(" · ") : null} />
        <Row
          label="Pattern"
          value={
            [
              intake.painPattern ? labelFor(PAIN_PATTERN_OPTIONS, intake.painPattern) : null,
              intake.worstTime
                ? `worst ${labelFor(WORST_TIME_OPTIONS, intake.worstTime).toLowerCase()}`
                : null,
              intake.nightPain === true ? "wakes at night" : null,
            ]
              .filter(Boolean)
              .join(" · ") || null
          }
        />
        <Row label="Aggravated by" value={intake.aggravators} />
        <Row label="Eased by" value={intake.easers} />
        {intake.limitedActivities?.length ? (
          <div className="sm:col-span-2">
            <dt className="text-muted">Limited activities (0-10 today — the goals)</dt>
            <dd className="font-medium">
              {intake.limitedActivities
                .map((a) => `${a.activity} — ${a.rating}/10`)
                .join(" · ")}
            </dd>
          </div>
        ) : null}
        <Row label="Assistive device" value={intake.assistiveDevice} />
        <Row label="Goals" value={intake.goals} />
        <Row
          label="Comorbidities"
          value={
            intake.conditions.length
              ? intake.conditions.map((c) => labelFor(CONDITION_OPTIONS, c)).join(", ")
              : null
          }
        />
        <Row label="Medications" value={intake.medications} />
        <Row label="Surgical history" value={intake.surgeries} />
        <Row label="Imaging" value={intake.imaging} />
        <Row label="Prior treatment" value={intake.priorTreatment} />
        <Row label="Occupation" value={intake.occupation} />
        <Row label="Activity level" value={intake.activityLevel} />
        <Row
          label="Restrictions"
          value={
            intake.restrictions ?? (patientSubmitted ? "not set — PT to add in review" : null)
          }
        />
        <Row label="Narrative" value={intake.narrative} />
      </dl>
    </div>
  );
}
