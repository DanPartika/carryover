"use client";

// Goals, both sides of the desk.
//
// A goal is an everyday activity someone wants back, rated 0-10 by the patient
// (0 = can't do it, 10 = no problem). The first few come from the intake; more
// can be named at any point — by the patient on Today, or by the PT in the room
// — because what people care about surfaces over days, not in the first ten
// minutes. A progress report is each goal's number beside its prior number (the
// one content rule real progress reports live by). GoalsPanel is the PT's view
// + in-room entry; GoalCheck is the patient's card. Ratings are append-only
// goal_ratings rows; neither side computes a verdict.

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { starterIdeas } from "@/lib/goals/ideas";
import { goalKey, MAX_GOALS, type GoalSource } from "@/lib/goals/model";

export type GoalRow = {
  /** Set for a goal added after the intake (it can be removed); null for the intake's. */
  id?: string | null;
  source?: GoalSource;
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

async function problem(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `${fallback} (${res.status})`;
}

/** "remove" → "Remove? yes · no". A goal can be wrong; it shouldn't be one tap
 *  from gone either. */
function RemoveGoal({ onRemove, busy }: { onRemove: () => void; busy: boolean }) {
  const [sure, setSure] = useState(false);
  if (!sure) {
    return (
      <button
        type="button"
        onClick={() => setSure(true)}
        className="text-xs text-muted underline hover:text-flag"
      >
        remove
      </button>
    );
  }
  return (
    <span className="text-xs text-muted">
      Remove?{" "}
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        className="font-semibold text-flag underline disabled:opacity-40"
      >
        yes
      </button>{" "}
      ·{" "}
      <button type="button" onClick={() => setSure(false)} className="underline">
        no
      </button>
    </span>
  );
}

/** The add box, shared. The patient rates with a slider they must actually
 *  touch (a pre-set 5 would be a number nobody chose); the PT keys in what the
 *  patient just told them. */
function AddGoalForm({
  ideas,
  ideaNote,
  ratingMode,
  busy,
  error,
  onSave,
  onCancel,
  extra,
}: {
  ideas: string[];
  ideaNote?: string | null;
  ratingMode: "slider" | "number";
  busy: boolean;
  error: string | null;
  onSave: (activity: string, rating: number) => void;
  onCancel: () => void;
  /** The PT's "suggest ideas" control. */
  extra?: React.ReactNode;
}) {
  const [activity, setActivity] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const ready = activity.trim().length > 0 && rating !== null;

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-edge bg-raise/40 p-3">
      <label className="block text-sm">
        <span className="font-medium">
          {ratingMode === "slider" ? "Something you want to be able to do" : "Goal"}
        </span>
        <input
          value={activity}
          onChange={(e) => setActivity(e.target.value)}
          maxLength={120}
          placeholder="e.g. sleeping through the night"
          className="mt-1 w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </label>

      {(ideas.length > 0 || extra) && (
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted">Ideas — tap one to use it</span>
            {extra}
          </div>
          {ideaNote && <p className="mt-0.5 text-xs text-muted">{ideaNote}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ideas.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setActivity(idea)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  goalKey(activity) === goalKey(idea)
                    ? "border-accent-deep bg-accent-deep text-white"
                    : "border-edge text-muted hover:bg-raise"
                }`}
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      )}

      {ratingMode === "slider" ? (
        <label className="block text-sm">
          <span className="flex items-baseline justify-between">
            <span className="text-muted">
              How is that today? 0 = can&apos;t do it, 10 = no problem
            </span>
            <span className="text-xs font-semibold">
              {rating === null ? "slide to rate" : `${rating}/10`}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={10}
            value={rating ?? 5}
            onChange={(e) => setRating(Number(e.target.value))}
            className="mt-1 w-full accent-[var(--color-accent-deep)]"
          />
        </label>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Patient&apos;s rating today, 0-10</span>
          <input
            type="number"
            min={0}
            max={10}
            value={rating ?? ""}
            onChange={(e) => setRating(e.target.value === "" ? null : Number(e.target.value))}
            className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent"
          />
        </label>
      )}

      {error && <p className="text-sm text-flag">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => ready && onSave(activity, rating!)}
          disabled={busy || !ready}
          className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add goal"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-edge px-4 py-1.5 text-sm text-muted hover:bg-raise"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What the PT has to go on when asking for ideas — the intake's own fields. */
export type IdeaContext = {
  condition: string;
  side: string | null;
  bodyRegions: string[];
  restrictions: string | null;
  assistiveDevice: string | null;
};

/** PT side: baseline → latest for each goal, in-room entry ("how are the
 *  stairs today, honestly?") that records a fresh rating row, and adding a goal
 *  the patient has just mentioned. */
export function GoalsPanel({
  goals,
  patientId,
  clinicId,
  patientName,
  ideaContext,
  onChanged,
}: {
  goals: GoalRow[];
  patientId: string;
  clinicId: string;
  patientName: string;
  ideaContext: IdeaContext;
  onChanged: () => void | Promise<void>;
}) {
  const [entering, setEntering] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [ideaNote, setIdeaNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const firstName = patientName.split(" ")[0];
  const names = goals.map((g) => g.activity);
  const full = goals.length >= MAX_GOALS;

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

  async function add(activity: string, rating: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/patients/${patientId}/goals/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, activity, rating }),
      });
      if (!res.ok) {
        setError(await problem(res, "couldn't add that"));
        return;
      }
      setAdding(false);
      setIdeas(null);
      setIdeaNote(null);
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/patients/${patientId}/goals/${id}?${new URLSearchParams({ clinicId })}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(await problem(res, "couldn't remove that"));
        return;
      }
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function suggest() {
    setAsking(true);
    setIdeaNote(null);
    try {
      const res = await apiFetch("/api/goals/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, ...ideaContext, existing: names }),
      });
      if (!res.ok) {
        setIdeaNote("couldn't get ideas just now — the standard ones are still here");
        return;
      }
      const d = (await res.json()) as { ideas: string[]; mode: "fixture" | "lithe"; fellBack: boolean };
      setIdeas(d.ideas);
      setIdeaNote(
        d.fellBack
          ? "The AI wasn't available, so these are the standard ideas."
          : d.mode === "lithe"
            ? `Drafted from ${firstName}'s intake — you choose what to ask about.`
            : "Standard ideas for this kind of problem.",
      );
    } catch {
      setIdeaNote("network error — the standard ideas are still here");
    } finally {
      setAsking(false);
    }
  }

  const shownIdeas = ideas ?? starterIdeas(ideaContext.bodyRegions, names);

  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Goals — {firstName}&apos;s own ratings, 0-10
        </h3>
        {!entering && !adding && (
          <div className="flex flex-wrap gap-2">
            {goals.length > 0 && (
              <button
                onClick={() => setEntering(true)}
                className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-raise"
              >
                Rate in the room
              </button>
            )}
            <button
              onClick={() => {
                setAdding(true);
                setError(null);
              }}
              disabled={full}
              title={full ? `A goal list holds ${MAX_GOALS} at a time` : undefined}
              className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-raise disabled:opacity-40"
            >
              ＋ Add a goal
            </button>
          </div>
        )}
      </div>

      {goals.length === 0 && !adding && (
        <p className="mt-2 text-xs text-muted">
          No goals yet. Add what {firstName} wants back — each one gets a 0-10 rating now and
          is re-rated as care goes on.
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {goals.map((g) => (
          <li
            key={g.activity}
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span>
              <span className="font-medium">{g.activity}</span>
              {g.source === "patient" && (
                <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-[11px] text-muted">
                  added by {firstName}
                </span>
              )}
              {g.source === "pt" && (
                <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-[11px] text-muted">
                  added by a PT
                </span>
              )}
              {g.id && (
                <span className="ml-2">
                  <RemoveGoal busy={busy} onRemove={() => void remove(g.id!)} />
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 text-xs tabular-nums text-muted">
              <span>
                {g.baseline}/10{" "}
                <span className="opacity-70">
                  {g.source === "intake" || !g.source ? "at intake" : "when added"} (
                  {day(g.baselineOn)})
                </span>
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
        </div>
      )}

      {adding && (
        <AddGoalForm
          ideas={shownIdeas}
          ideaNote={ideaNote}
          ratingMode="number"
          busy={busy}
          error={error}
          onSave={(a, r) => void add(a, r)}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
          extra={
            <button
              type="button"
              onClick={() => void suggest()}
              disabled={asking}
              className="text-xs font-medium text-accent-deep underline disabled:opacity-40"
            >
              {asking ? "Thinking…" : "Suggest some from the intake"}
            </button>
          }
        />
      )}
      {!adding && error && <p className="mt-2 text-xs text-flag">{error}</p>}
    </div>
  );
}

/** Patient side: their goals, "rate these again" (nudged every couple of
 *  weeks, usable anytime), and adding one of their own. Their words, their
 *  numbers; the PT reads them at the check-in. */
export function GoalCheck({
  goals,
  promptDue,
  regions,
  onChanged,
}: {
  goals: GoalRow[];
  promptDue: boolean;
  /** The intake's body regions — what the fixed starter ideas are chosen by. */
  regions: string[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, number>>(() =>
    Object.fromEntries(goals.map((g) => [g.activity, g.current ?? g.baseline])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const full = goals.length >= MAX_GOALS;

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

  async function add(activity: string, rating: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/goals/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activity, rating }),
      });
      if (!res.ok) {
        setError(await problem(res, "couldn't add that"));
        return;
      }
      setAdding(false);
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/me/goals/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await problem(res, "couldn't remove that"));
        return;
      }
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  const addForm = adding && (
    <AddGoalForm
      ideas={starterIdeas(regions, goals.map((g) => g.activity))}
      ratingMode="slider"
      busy={busy}
      error={error}
      onSave={(a, r) => void add(a, r)}
      onCancel={() => {
        setAdding(false);
        setError(null);
      }}
    />
  );

  const addButton = !adding && (
    <button
      onClick={() => {
        setAdding(true);
        setError(null);
      }}
      disabled={full}
      title={full ? `A goal list holds ${MAX_GOALS} at a time` : undefined}
      className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:bg-raise disabled:opacity-40"
    >
      ＋ Add a goal
    </button>
  );

  if (goals.length === 0) {
    return (
      <section className="rounded-xl border border-edge bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your goals</h2>
        <p className="mt-1 text-xs text-muted">
          What do you want to get back to? Add it here and rate how it is today — your PT sees
          it, and you can rate it again as you go.
        </p>
        <div className="mt-2">{addButton}</div>
        {addForm}
      </section>
    );
  }

  if (!open && !promptDue) {
    return (
      <section className="rounded-xl border border-edge bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Your goals
            </h2>
            {saved && (
              <p className="mt-1 text-xs text-muted">
                Saved — your PT sees the new numbers at your next check-in.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setOpen(true)}
              className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:bg-raise"
            >
              Update
            </button>
            {addButton}
          </div>
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {goals.map((g) => (
            <li key={g.activity} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>
                {g.activity}
                {g.id && g.source === "patient" && (
                  <span className="ml-2">
                    <RemoveGoal busy={busy} onRemove={() => void remove(g.id!)} />
                  </span>
                )}
              </span>
              <span className="text-xs tabular-nums text-muted">{g.current ?? g.baseline}/10</span>
            </li>
          ))}
        </ul>
        {!adding && error && <p className="mt-2 text-xs text-flag">{error}</p>}
        {addForm}
      </section>
    );
  }

  return (
    <section className={`rounded-xl border bg-card p-4 ${promptDue && !open ? "border-accent" : "border-edge"}`}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your goals</h2>
      <p className="mt-1 text-xs text-muted">
        When you named these, you rated them 0-10. How are they today? 0 = can&apos;t do it,
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
            {g.id && g.source === "patient" && (
              <RemoveGoal busy={busy} onRemove={() => void remove(g.id!)} />
            )}
          </li>
        ))}
      </ul>
      {!adding && error && <p className="mt-2 text-sm text-flag">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
        {addButton}
      </div>
      {addForm}
    </section>
  );
}
