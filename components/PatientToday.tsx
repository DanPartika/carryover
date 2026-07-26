"use client";

// The patient's home screen (PRD build step 4, "the retention loop"): office/
// home tabs, per-exercise adherence logging, a 14-day streak strip, and the
// home-equipment shelf that feeds the AI draft's home-eligibility check
// (built in step 3, unpopulated until now). Phone-first — large tap targets,
// no PT-facing controls.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

type Item = {
  id: string;
  exerciseId: string;
  name: string;
  instructions: string[];
  image: string | null;
  difficulty: number | null;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
  rationale: string | null;
  logId: string | null;
  logCompleted: boolean | null;
  logSetsDone: number | null;
  logRepsDone: number | null;
  logPain: number | null;
  logEffort: number | null;
  logNote: string | null;
  logFlagForPt: boolean | null;
};

type Equipment = { id: string; slug: string; name: string; kind: string; owned: boolean };
type StreakDay = { date: string; completed: boolean };

type PlanData = {
  episode: { id: string; condition: string } | null;
  plan: { id: string; approvedAt: string } | null;
  items: Item[];
  streak: StreakDay[];
  equipment: Equipment[];
};

function dosageLine(it: Item): string {
  const parts: string[] = [];
  if (it.sets) parts.push(`${it.sets}×${it.reps ?? ""}`.replace(/×$/, ` sets`));
  if (it.holdSecs) parts.push(`${it.holdSecs}s hold`);
  parts.push(`${it.frequencyPerWeek}/wk`);
  return parts.join(" · ");
}

function currentStreakCount(streak: StreakDay[]): number {
  let n = 0;
  for (let i = streak.length - 1; i >= 0; i--) {
    if (!streak[i].completed) break;
    n++;
  }
  return n;
}

function ExerciseCard({ item, onLogged }: { item: Item; onLogged: () => void }) {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState(item.logSetsDone ?? item.sets ?? 0);
  const [reps, setReps] = useState(item.logRepsDone ?? item.reps ?? 0);
  const [pain, setPain] = useState(item.logPain ?? 0);
  const [effort, setEffort] = useState(item.logEffort ?? 3);
  const [note, setNote] = useState(item.logNote ?? "");
  const [flag, setFlag] = useState(item.logFlagForPt ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logged = item.logId !== null;

  async function save(completed: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/adherence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planItemId: item.id,
          completed,
          setsDone: sets,
          repsDone: reps,
          pain,
          effort,
          note,
          flagForPt: flag,
        }),
      });
      if (!res.ok) {
        setError("couldn't save — try again");
        return;
      }
      onLogged();
    } catch {
      setError("network error — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-xl border border-edge bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raise">
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl" aria-hidden>
              🦵
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">{item.name}</span>
            {logged && !open && (
              <span className="shrink-0 rounded-full bg-accent-deep px-2 py-0.5 text-xs font-medium text-white">
                ✓ logged
              </span>
            )}
          </div>
          <p className="text-sm text-muted">{dosageLine(item)}</p>
          {item.rationale && <p className="mt-1 text-sm text-muted">{item.rationale}</p>}
        </div>
      </div>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className={`mt-3 w-full rounded-lg py-2 text-sm font-semibold ${
            logged
              ? "border border-edge text-muted hover:bg-raise"
              : "bg-accent-deep text-white hover:brightness-110"
          }`}
        >
          {logged ? "Edit today's log" : "Log this exercise"}
        </button>
      ) : (
        <div className="mt-3 space-y-3 border-t border-edge pt-3 text-sm">
          {item.instructions.length > 0 && (
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              {item.instructions.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              sets
              <input
                type="number" min={0} max={20} value={sets}
                onChange={(e) => setSets(Number(e.target.value) || 0)}
                className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
              />
            </label>
            <label className="flex items-center gap-1">
              reps
              <input
                type="number" min={0} max={100} value={reps}
                onChange={(e) => setReps(Number(e.target.value) || 0)}
                className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-muted">Pain during: {pain}/10</span>
            <input
              type="range" min={0} max={10} value={pain}
              onChange={(e) => setPain(Number(e.target.value))}
              className="mt-1 w-full accent-[var(--color-flag)]"
            />
          </label>
          <label className="block">
            <span className="text-muted">Effort: {["", "very easy", "easy", "moderate", "hard", "very hard"][effort]}</span>
            <input
              type="range" min={1} max={5} value={effort}
              onChange={(e) => setEffort(Number(e.target.value))}
              className="mt-1 w-full accent-[var(--color-accent-deep)]"
            />
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for your PT (optional)"
            rows={2}
            className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
          />
          <label className="flex items-center gap-2 text-flag">
            <input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} />
            Flag this for my PT
          </label>
          {error && <p className="text-flag">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void save(true)}
              disabled={saving}
              className="flex-1 rounded-lg bg-accent-deep py-2 font-semibold text-white hover:brightness-110 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg border border-edge px-4 py-2 text-muted hover:bg-raise"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function PatientToday() {
  const [data, setData] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "office">("home");

  async function load() {
    try {
      const res = await apiFetch("/api/me/plan");
      if (!res.ok) {
        setError(`load failed (${res.status})`);
        return;
      }
      setData((await res.json()) as PlanData);
    } catch {
      setError("network error — pull to refresh");
    }
  }

  useEffect(() => {
    // All setState inside load() happens after the await (async), not in the
    // effect body — the compiler lint can't see through the function boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function toggleEquipment(id: string, owned: boolean) {
    setData((prev) =>
      prev
        ? { ...prev, equipment: prev.equipment.map((e) => (e.id === id ? { ...e, owned } : e)) }
        : prev,
    );
    await apiFetch("/api/me/equipment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equipmentId: id, owned }),
    });
  }

  if (error) return <p className="text-sm text-flag">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  if (!data.plan) {
    return (
      <div className="rounded-xl border border-edge bg-card p-6 text-center">
        <p className="font-semibold">No active plan yet</p>
        <p className="mt-1 text-sm text-muted">
          Once your PT approves your program, it shows up here.
        </p>
      </div>
    );
  }

  const homeItems = data.items.filter((i) => i.location === "home" || i.location === "both");
  const streakCount = currentStreakCount(data.streak);

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-extrabold tracking-tight">Today</h1>
          {streakCount > 0 && (
            <span className="rounded-full bg-accent-deep/10 px-3 py-1 text-sm font-semibold text-accent-deep">
              🔥 {streakCount} day{streakCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="mt-2 flex gap-1">
          {data.streak.map((d) => (
            <div
              key={d.date}
              title={d.date}
              className={`h-2 flex-1 rounded-full ${d.completed ? "bg-accent-deep" : "bg-edge"}`}
            />
          ))}
        </div>
      </section>

      <div className="flex gap-1 rounded-lg bg-raise p-1">
        <button
          onClick={() => setTab("home")}
          className={`flex-1 rounded-md py-1.5 text-sm font-semibold ${tab === "home" ? "bg-card shadow-sm" : "text-muted"}`}
        >
          At home
        </button>
        <button
          onClick={() => setTab("office")}
          className={`flex-1 rounded-md py-1.5 text-sm font-semibold ${tab === "office" ? "bg-card shadow-sm" : "text-muted"}`}
        >
          In office
        </button>
      </div>

      {tab === "home" ? (
        homeItems.length === 0 ? (
          <p className="text-sm text-muted">No home exercises assigned yet.</p>
        ) : (
          <ul className="space-y-2">
            {homeItems.map((it) => (
              <ExerciseCard key={it.id} item={it} onLogged={() => void load()} />
            ))}
          </ul>
        )
      ) : (
        <p className="rounded-xl border border-edge bg-card p-6 text-center text-sm text-muted">
          Your in-office visit history will show up here once your clinic starts logging
          sessions.
        </p>
      )}

      <section className="rounded-xl border border-edge bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          My home equipment
        </h2>
        <p className="mt-1 text-xs text-muted">
          Check what you have — your PT&apos;s AI-drafted plans only use what you own.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.equipment.map((e) => (
            <button
              key={e.id}
              onClick={() => void toggleEquipment(e.id, !e.owned)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                e.owned
                  ? "border-accent-deep bg-accent-deep text-white"
                  : "border-edge text-muted"
              }`}
            >
              {e.owned ? "✓ " : "+ "}
              {e.name}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
