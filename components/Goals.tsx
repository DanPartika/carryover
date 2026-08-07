"use client";

// Goal ratings, both sides of the desk.
//
// The intake asked for up to 3 activities the patient can't do, rated 0-10.
// Those ARE the goals — and a progress report is each goal's number beside
// its prior number (the one content rule real progress reports live by).
// GoalsPanel is the PT's view + in-room entry; GoalCheck is the patient's
// re-rate card. Both write append-only goal_ratings rows; neither computes
// a verdict.

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";

export type GoalRow = {
  activity: string;
  baseline: number;
  baselineOn: string;
  current: number | null;
  currentOn: string | null;
};

function day(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** PT side: baseline → latest for each goal, plus in-room entry ("how are
 *  the stairs today, honestly?") that records a fresh rating row. */
export function GoalsPanel({
  goals,
  patientId,
  clinicId,
  patientName,
  onChanged,
}: {
  goals: GoalRow[];
  patientId: string;
  clinicId: string;
  patientName: string;
  onChanged: () => void | Promise<void>;
}) {
  const [entering, setEntering] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstName = patientName.split(" ")[0];

  async function save() {
    const ratings = goals
      .filter((g) => drafts[g.activity] !== undefined && drafts[g.activity] !== "")
      .map((g) => ({ activity: g.activity, rating: Number(drafts[g.activity]) }));
    if (ratings.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/patients/${patientId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, ratings }),
      });
      if (!res.ok) {
        setError(`couldn't record that (${res.status})`);
        return;
      }
      setEntering(false);
      setDrafts({});
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Goals — {firstName}&apos;s own ratings, 0-10
        </h3>
        {!entering && (
          <button
            onClick={() => setEntering(true)}
            className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-raise"
          >
            Rate in the room
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {goals.map((g) => (
          <li
            key={g.activity}
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span className="font-medium">{g.activity}</span>
            <span className="flex items-center gap-2 text-xs tabular-nums text-muted">
              <span>
                {g.baseline}/10 <span className="opacity-70">at intake ({day(g.baselineOn)})</span>
              </span>
              <span aria-hidden>→</span>
              {g.current !== null ? (
                <span className="font-medium text-ink">
                  {g.current}/10 <span className="font-normal text-muted">({day(g.currentOn!)})</span>
                </span>
              ) : (
                <span>not re-rated yet</span>
              )}
              {entering && (
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={drafts[g.activity] ?? ""}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [g.activity]: e.target.value }))
                  }
                  placeholder="now"
                  className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent"
                />
              )}
            </span>
          </li>
        ))}
      </ul>
      {entering && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-accent-deep px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Record today's ratings"}
          </button>
          <button
            onClick={() => {
              setEntering(false);
              setDrafts({});
            }}
            className="text-xs text-muted underline hover:text-ink"
          >
            cancel
          </button>
          {error && <span className="text-xs text-flag">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** Patient side: "rate these again" — nudged every couple of weeks, usable
 *  anytime. Their words, their numbers; the PT reads them at the check-in. */
export function GoalCheck({
  goals,
  promptDue,
  onChanged,
}: {
  goals: GoalRow[];
  promptDue: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, number>>(() =>
    Object.fromEntries(goals.map((g) => [g.activity, g.current ?? g.baseline])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ratings: goals.map((g) => ({ activity: g.activity, rating: drafts[g.activity] })),
        }),
      });
      if (!res.ok) {
        setError("couldn't save that — try again");
        return;
      }
      setSaved(true);
      setOpen(false);
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!open && !promptDue) {
    return (
      <section className="rounded-xl border border-edge bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Your goals
            </h2>
            <p className="mt-1 text-xs text-muted">
              {saved
                ? "Saved — your PT sees the new numbers at your next check-in."
                : goals
                    .map((g) => `${g.activity}: ${g.current ?? g.baseline}/10`)
                    .join(" · ")}
            </p>
          </div>
          <button
            onClick={() => setOpen(true)}
            className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:bg-raise"
          >
            Update
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-xl border bg-card p-4 ${promptDue && !open ? "border-accent" : "border-edge"}`}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your goals</h2>
      <p className="mt-1 text-xs text-muted">
        When you started, you rated these 0-10. How are they today? 0 = can&apos;t do it,
        10 = no problem. Honest beats optimistic — your PT plans around these.
      </p>
      <ul className="mt-3 space-y-3">
        {goals.map((g) => (
          <li key={g.activity}>
            <label className="block text-sm">
              <span className="flex items-baseline justify-between">
                <span className="font-medium">{g.activity}</span>
                <span className="text-xs text-muted">
                  was {g.baseline}/10 · now{" "}
                  <span className="font-semibold text-ink">{drafts[g.activity]}/10</span>
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={10}
                value={drafts[g.activity]}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [g.activity]: Number(e.target.value) }))
                }
                className="mt-1 w-full accent-[var(--color-accent-deep)]"
              />
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save my ratings"}
        </button>
        {open && (
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-edge px-4 py-1.5 text-sm text-muted hover:bg-raise"
          >
            Not now
          </button>
        )}
      </div>
    </section>
  );
}
