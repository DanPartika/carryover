"use client";

// "What did they actually do?" — the session-by-session record behind the
// compliance percentage.
//
// The bar above says 22 of 25. This says: Tuesday, two sets instead of three,
// pain 5 where it's usually 2, and "knee felt hot after". That is the thing a
// PT actually asks in the room, and until now the app held the answer and
// never showed it.
//
// Every session carries the prescription IN FORCE AT THE TIME beside what was
// logged, plus the steps the patient was reading. No verdicts: "under" is
// arithmetic, and whether falling short of 3×10 matters is the PT's call.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { doneText, dosageText, dosageTypeOf, metPrescription, type DosageType } from "@/lib/dosage";

type SessionRow = {
  id: string;
  date: string;
  exerciseId: string;
  planItemId: string | null;
  name: string;
  dosageType: DosageType;
  kind: "exercise" | "modality";
  completed: boolean;
  setsDone: number | null;
  repsDone: number | null;
  durationDoneMins: number | null;
  pain: number | null;
  effort: number | null;
  note: string | null;
  flagged: boolean;
  edited: boolean;
  // The prescription as it stood that day. Null for unprescribed care.
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number | null;
  location: "office" | "home" | "both" | null;
};

type ExerciseInfo = {
  id: string;
  name: string;
  instructions: string[];
  image: string | null;
  difficulty: number | null;
};

type Data = {
  today: string;
  windowFrom: string;
  windowDays: number;
  truncated: boolean;
  sessions: SessionRow[];
  exercises: ExerciseInfo[];
};

const EFFORT = ["", "very easy", "easy", "moderate", "hard", "very hard"];

function dayLabel(iso: string, today: string): string {
  const label = new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const n = Math.round((Date.parse(today) - Date.parse(iso)) / 86_400_000);
  if (n === 0) return `${label} · today`;
  if (n === 1) return `${label} · yesterday`;
  return label;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

function Session({ row, steps }: { row: SessionRow; steps: string[] }) {
  const [open, setOpen] = useState(false);
  const type = dosageTypeOf(row);
  const prescribed = row.planItemId ? dosageText(row) : null;
  const performed = doneText(type, row);
  const met = metPrescription(type, row.planItemId ? row : null, row);

  return (
    <li className="rounded-lg border border-edge px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {row.name}
          {row.kind === "modality" && (
            <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">care</span>
          )}
          {!row.planItemId && (
            <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
              not prescribed
            </span>
          )}
        </span>
        <span className="text-xs tabular-nums text-muted">
          {prescribed ? (
            <>
              <span>{prescribed}</span> <span aria-hidden>→</span>{" "}
              <span className="font-medium text-ink">{performed}</span>
            </>
          ) : (
            <span className="font-medium text-ink">{performed}</span>
          )}
          {met === false && <span className="ml-2 text-flag">under</span>}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
        {!row.completed && <span className="font-medium text-flag">marked not done</span>}
        {row.pain !== null && <span>pain {row.pain}/10</span>}
        {row.effort !== null && <span>effort {EFFORT[row.effort] ?? row.effort}</span>}
        {row.flagged && <span className="font-semibold text-flag">⚑ flagged for you</span>}
        {row.edited && <span>edited later</span>}
        {steps.length > 0 && (
          <button onClick={() => setOpen(!open)} className="underline hover:text-ink">
            {open ? "hide steps" : `steps (${steps.length})`}
          </button>
        )}
      </div>

      {row.note && <p className="mt-1 text-sm">“{row.note}”</p>}

      {open && (
        <div className="mt-2 rounded-lg bg-raise/60 px-3 py-2">
          <p className="text-xs text-muted">What they were reading while they did it</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

export default function SessionLog({
  patientId,
  clinicId,
  days,
  focusExerciseId,
  onClearFocus,
}: {
  patientId: string;
  clinicId: string;
  days: number;
  /** Set when the PT clicked a bar above: show only that exercise, across
   *  every plan revision it has appeared in. */
  focusExerciseId: string | null;
  onClearFocus: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/patients/${patientId}/sessions?clinicId=${clinicId}&days=${days}`,
      );
      if (!res.ok) {
        setError(`session log failed (${res.status})`);
        return;
      }
      setError(null);
      setData((await res.json()) as Data);
    } catch {
      setError("network error loading the session log");
    }
  }, [patientId, clinicId, days]);

  useEffect(() => {
    // setState lives inside load() past an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (error) return <p className="text-sm text-flag">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading sessions…</p>;

  const steps = new Map(data.exercises.map((e) => [e.id, e.instructions ?? []]));
  const focusName = focusExerciseId
    ? (data.exercises.find((e) => e.id === focusExerciseId)?.name ?? "this exercise")
    : null;

  const rows = focusExerciseId
    ? data.sessions.filter((s) => s.exerciseId === focusExerciseId)
    : data.sessions;

  const byDay = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.date);
    if (list) list.push(r);
    else byDay.set(r.date, [r]);
  }
  const dayList = [...byDay.entries()];

  // Newest day open by default. With one exercise in focus every day is open
  // and stays open — each card holds a single row, so collapsing them buys
  // nothing and the point of focusing is to read the run in one go.
  const isOpen = (date: string, idx: number) =>
    !!focusExerciseId || (touched ? openDays.has(date) : idx === 0);

  function toggle(date: string) {
    if (focusExerciseId) return;
    setOpenDays((prev) => {
      const next = new Set(touched ? prev : dayList.slice(0, 1).map(([d]) => d));
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
    setTouched(true);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          What they actually did
        </h3>
        {focusName && (
          <button
            onClick={onClearFocus}
            className="rounded-full border border-accent-deep px-2.5 py-0.5 text-xs font-medium text-accent-deep hover:bg-raise"
          >
            only {focusName} ✕
          </button>
        )}
      </div>

      {dayList.length === 0 ? (
        <p className="mt-1 text-sm text-muted">
          {focusName
            ? `No sessions logged for ${focusName} in this window.`
            : "Nothing logged in this window."}
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-muted">
            Each session shows what was prescribed that day next to what they logged.
            {focusName ? " Across every plan they've been on." : ""}
          </p>
          <ul className="mt-2 space-y-1.5">
            {dayList.map(([date, items], idx) => {
              const open = isOpen(date, idx);
              const painValues = items
                .map((i) => i.pain)
                .filter((p): p is number => p !== null);
              const avg = mean(painValues);
              const flags = items.filter((i) => i.flagged).length;
              return (
                <li key={date} className="rounded-lg bg-raise/40">
                  <button
                    onClick={() => toggle(date)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
                  >
                    <span className="text-sm font-medium">
                      <span className="mr-1.5 inline-block w-3 text-muted" aria-hidden>
                        {open ? "▾" : "▸"}
                      </span>
                      {dayLabel(date, data.today)}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                      {flags > 0 && <span className="font-semibold text-flag">⚑ {flags}</span>}
                      {avg !== null && <span>pain {avg}</span>}
                      <span>
                        {items.length} logged
                      </span>
                    </span>
                  </button>
                  {open && (
                    <ul className="space-y-1.5 px-3 pb-3">
                      {items.map((row) => (
                        <Session key={row.id} row={row} steps={steps.get(row.exerciseId) ?? []} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {data.truncated && (
            <p className="mt-2 text-xs text-muted">
              Showing the most recent sessions only — narrow the window to see the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}
