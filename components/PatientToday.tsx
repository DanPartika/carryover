"use client";

// The patient's home screen (PRD build step 4, "the retention loop"): office/
// home tabs, per-exercise adherence logging, a 14-day streak strip, and the
// home-equipment shelf that feeds the AI draft's home-eligibility check
// (built in step 3, unpopulated until now). Phone-first — large tap targets,
// no PT-facing controls.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { dosageLine, dosageText, dosageTypeOf, type DosageType } from "@/lib/dosage";

type Item = {
  id: string;
  exerciseId: string;
  name: string;
  instructions: string[];
  image: string | null;
  difficulty: number | null;
  dosageType: DosageType;
  kind: "exercise" | "modality";
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
  rationale: string | null;
  logId: string | null;
  logCompleted: boolean | null;
  logSetsDone: number | null;
  logRepsDone: number | null;
  logDurationDoneMins: number | null;
  logPain: number | null;
  logEffort: number | null;
  logNote: string | null;
  logFlagForPt: boolean | null;
};

type CareOption = { id: string; name: string };

type AdhocLog = {
  id: string;
  exerciseId: string;
  name: string;
  durationDoneMins: number | null;
  pain: number | null;
  note: string | null;
};

type Equipment = { id: string; slug: string; name: string; kind: string; owned: boolean };
type StreakDay = { date: string; completed: boolean };

type VisitItem = {
  name: string;
  dosageType: DosageType;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  pain: number | null;
  note: string | null;
  adHoc: boolean;
};

type Visit = {
  id: string;
  startedAt: string;
  /** Postgres-resolved day label — see the note in /api/visits. */
  startedOn: string;
  endedAt: string;
  note: string | null;
  ptName: string | null;
  items: VisitItem[];
};

type Note = {
  id: string;
  body: string;
  authorRole: "pt" | "patient";
  authorName: string | null;
  createdAt: string;
  mine: boolean;
};

type PlanData = {
  episode: { id: string; condition: string } | null;
  plan: { id: string; approvedAt: string } | null;
  items: Item[];
  streak: StreakDay[];
  adhocToday: AdhocLog[];
  careOptions: CareOption[];
  equipment: Equipment[];
};

/** Care nobody prescribed: iced because it felt tight, put the boots on,
 *  reached for the heat pad. It reaches the PT and its pain score joins the
 *  trend, but it is deliberately outside the compliance score — the percentage
 *  answers "did they do what was asked", and self-care isn't that. */
function CareLogger({
  options,
  logged,
  onChanged,
}: {
  options: CareOption[];
  logged: AdhocLog[];
  onChanged: () => void;
}) {
  const [picked, setPicked] = useState("");
  const [mins, setMins] = useState(15);
  const [pain, setPain] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/adherence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId: picked,
          durationDoneMins: mins,
          pain: pain === "" ? null : pain,
          note,
        }),
      });
      if (!res.ok) {
        setError("couldn't save that — try again");
        return;
      }
      setPicked("");
      setNote("");
      setPain("");
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await apiFetch(`/api/adherence?id=${id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        Anything else today?
      </h2>
      <p className="mt-1 text-xs text-muted">
        Ice, heat, boots, TENS — whether or not it&apos;s on your plan. Your PT sees it.
      </p>

      {logged.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {logged.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-raise/60 px-3 py-2 text-sm"
            >
              <span>
                {l.name}
                {l.durationDoneMins ? (
                  <span className="ml-2 text-xs text-muted">{l.durationDoneMins} min</span>
                ) : null}
                {l.pain !== null ? (
                  <span className="ml-2 text-xs text-muted">pain {l.pain}/10</span>
                ) : null}
              </span>
              <button onClick={() => void remove(l.id)} className="text-xs text-muted hover:text-flag">
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="min-w-40 flex-1 rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
        >
          <option value="">Add care…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-muted">
          <input
            type="number" min={1} max={600} value={mins}
            onChange={(e) => setMins(Number(e.target.value) || 0)}
            className="w-16 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
          />
          min
        </label>
        <label className="flex items-center gap-1 text-muted">
          pain
          <input
            type="number" min={0} max={10} value={pain}
            onChange={(e) => setPain(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
          />
        </label>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="mt-2 w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      />
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
      <button
        onClick={() => void save()}
        disabled={busy || !picked}
        className="mt-2 rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Log it"}
      </button>
    </section>
  );
}

/** The patient's journal: what they write for their PT, plus whatever the PT
 *  chose to share back. Everything here is two-way visible by construction —
 *  the API never sends a private PT note to this side. */
function Journal() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/me/notes");
      if (res.ok) setNotes(((await res.json()) as { notes: Note[] }).notes);
    } catch {
      setError("couldn't load your journal");
    }
  }, []);

  useEffect(() => {
    // setState runs inside load() after an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        setError("couldn't save that — try again");
        return;
      }
      setDraft("");
      await load();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Journal</h2>
      <p className="mt-1 text-xs text-muted">
        Anything you write here goes to your PT. They can reply by sharing a note back.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="How's the knee feeling?"
        className="mt-2 w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button
        onClick={() => void add()}
        disabled={busy || !draft.trim()}
        className="mt-2 rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Add to journal"}
      </button>
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
      <ul className="mt-3 space-y-2">
        {notes?.map((n) => (
          <li
            key={n.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              n.authorRole === "pt" ? "bg-[var(--color-clinic)]/10" : "bg-raise/60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="font-medium text-ink">
                {n.authorRole === "pt" ? `From ${n.authorName ?? "your PT"}` : "You"}
              </span>
              <span>{new Date(n.createdAt).toLocaleDateString()}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
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
  const dosage = dosageTypeOf(item);
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState(item.logSetsDone ?? item.sets ?? 0);
  const [reps, setReps] = useState(item.logRepsDone ?? item.reps ?? 0);
  const [mins, setMins] = useState(item.logDurationDoneMins ?? item.durationMins ?? 0);
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
          // Only send what this item's dosage means. Posting reps for a bike
          // would store a number the PT's dashboard has no way to read.
          setsDone: dosage === "time" ? null : sets,
          repsDone: dosage === "reps" ? reps : null,
          durationDoneMins: dosage === "time" ? mins : null,
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
            {dosage === "time" ? (
              <>
                <label className="flex items-center gap-1">
                  minutes
                  <input
                    type="number" min={0} max={600} value={mins}
                    onChange={(e) => setMins(Number(e.target.value) || 0)}
                    className="w-16 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                  />
                </label>
                {item.intensity && (
                  <span className="text-muted">at {item.intensity}</span>
                )}
              </>
            ) : (
              <>
                <label className="flex items-center gap-1">
                  sets
                  <input
                    type="number" min={0} max={20} value={sets}
                    onChange={(e) => setSets(Number(e.target.value) || 0)}
                    className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                  />
                </label>
                {dosage === "reps" ? (
                  <label className="flex items-center gap-1">
                    reps
                    <input
                      type="number" min={0} max={100} value={reps}
                      onChange={(e) => setReps(Number(e.target.value) || 0)}
                      className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                    />
                  </label>
                ) : (
                  <span className="text-muted">
                    holding {item.holdSecs ?? "?"}s each
                  </span>
                )}
              </>
            )}
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
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "office">("home");

  async function load() {
    try {
      const [planRes, visitRes] = await Promise.all([
        apiFetch("/api/me/plan"),
        apiFetch("/api/me/visits"),
      ]);
      if (!planRes.ok) {
        setError(`load failed (${planRes.status})`);
        return;
      }
      setData((await planRes.json()) as PlanData);
      // A failed visit fetch shouldn't blank the Today view — home exercises
      // are the reason the patient opened the app.
      if (visitRes.ok) setVisits(((await visitRes.json()) as { visits: Visit[] }).visits);
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
    // No plan yet is not nothing to do: the journal still reaches the PT, and
    // is often where a patient says why they haven't started.
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-edge bg-card p-6 text-center">
          <p className="font-semibold">No active plan yet</p>
          <p className="mt-1 text-sm text-muted">
            Once your PT approves your program, it shows up here.
          </p>
        </div>
        <Journal />
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
      ) : !visits || visits.length === 0 ? (
        <p className="rounded-xl border border-edge bg-card p-6 text-center text-sm text-muted">
          Nothing here yet — your visits show up after your PT wraps one up.
        </p>
      ) : (
        <ul className="space-y-2">
          {visits.map((v) => (
            <li key={v.id} className="rounded-xl border border-edge bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  {new Date(`${v.startedOn}T00:00:00Z`).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                {v.ptName && <span className="text-xs text-muted">with {v.ptName}</span>}
              </div>
              {v.note && <p className="mt-1 text-sm">{v.note}</p>}
              <ul className="mt-2 space-y-1">
                {v.items.map((it, i) => (
                  <li
                    key={`${v.id}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-x-2 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
                  >
                    <span>
                      {it.name}
                      {it.adHoc && (
                        <span className="ml-2 text-xs text-muted">added in session</span>
                      )}
                    </span>
                    <span className="text-xs text-muted">
                      {dosageText(it)}
                      {it.pain !== null ? ` · pain ${it.pain}/10` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
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

      <CareLogger
        options={data.careOptions}
        logged={data.adhocToday}
        onChanged={() => void load()}
      />

      <Journal />
    </div>
  );
}
