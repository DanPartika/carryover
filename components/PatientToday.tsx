"use client";

// The patient's home screen (PRD build step 4, "the retention loop"): office/
// home tabs, per-exercise adherence logging, a 14-day streak strip, and the
// home-equipment shelf that feeds the AI draft's home-eligibility check
// (built in step 3, unpopulated until now). Phone-first — large tap targets,
// no PT-facing controls.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { GoalCheck, type GoalRow } from "@/components/Goals";
import PatientIntake from "@/components/PatientIntake";
import { withBase } from "@/lib/config/basePath";
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
  careTiming: "before" | "after" | null;
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

type Checkin = { id: string; kind: CheckinKind; note: string | null; on: string };

type CheckinKind = "too_easy" | "too_hard" | "something_changed";

type PlanData = {
  episode: { id: string; condition: string } | null;
  plan: {
    id: string;
    approvedAt: string;
    equipmentSuggestions: { slug: string; name: string; reason: string }[];
  } | null;
  items: Item[];
  checkin: Checkin | null;
  goals: { rows: GoalRow[]; promptDue: boolean } | null;
  streak: StreakDay[];
  adhocToday: AdhocLog[];
  careOptions: CareOption[];
  equipment: Equipment[];
};

/** Raising a hand. The one check-in trigger the app can't compute: someone can
 *  be at 100% adherence with pain at 2 and still be bored on a plan they've
 *  outgrown, or be quietly halving every set because it hurts. Silence reads
 *  identically either way.
 *
 *  Worded as a message to a person, not a support ticket, and it promises
 *  nothing about what happens next — the PT decides, and might well decide
 *  the plan stays as it is. */
function RaiseHand({ current, onChanged }: { current: Checkin | null; onChanged: () => void }) {
  const [kind, setKind] = useState<CheckinKind | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const OPTIONS: [CheckinKind, string][] = [
    ["too_easy", "This feels too easy now"],
    ["too_hard", "This is too much right now"],
    ["something_changed", "Something's changed"],
  ];

  async function send() {
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, note }),
      });
      if (!res.ok) {
        setError("couldn't send that — try again");
        return;
      }
      setKind(null);
      setNote("");
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    try {
      await apiFetch("/api/me/checkin", { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (current) {
    return (
      <section className="rounded-xl border border-accent bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Check-in</h2>
        <p className="mt-1 text-sm">
          You told your PT:{" "}
          <span className="font-medium">
            {OPTIONS.find(([k]) => k === current.kind)?.[1] ?? "something's changed"}
          </span>
          {current.note && <span className="text-muted"> — “{current.note}”</span>}
        </p>
        <p className="mt-1 text-xs text-muted">
          They&apos;ll see it next time they open your file. Keep going with your plan until they
          say otherwise.
        </p>
        <button
          onClick={() => void withdraw()}
          disabled={busy}
          className="mt-2 text-xs text-muted underline hover:text-flag disabled:opacity-40"
        >
          Never mind, take that back
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        How is the plan itself?
      </h2>
      <p className="mt-1 text-xs text-muted">
        Not about today — about the program. Tell your PT if it stops fitting.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {OPTIONS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setKind(kind === k ? null : k)}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              kind === k
                ? "border-accent-deep bg-accent-deep text-white"
                : "border-edge text-muted hover:bg-raise"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {kind && (
        <div className="mt-3 space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Anything you want them to know (optional)"
            className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void send()}
            disabled={busy}
            className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Sending…" : "Tell my PT"}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
    </section>
  );
}

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

/** What the PT chose to share, surfaced first — a patient opening the app
 *  should meet their clinician's words before their homework. Only shared
 *  notes ever reach this side (filtered in SQL, not here). */
function PtMessages({ notes }: { notes: Note[] }) {
  const [showAll, setShowAll] = useState(false);
  const fromPt = notes.filter((n) => n.authorRole === "pt");
  if (fromPt.length === 0) return null;
  const visible = showAll ? fromPt : fromPt.slice(0, 3);

  return (
    <section className="rounded-xl border border-[var(--color-clinic)]/40 bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">From your PT</h2>
      <ul className="mt-2 space-y-2">
        {visible.map((n) => (
          <li key={n.id} className="rounded-lg bg-[var(--color-clinic)]/10 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="font-medium text-ink">{n.authorName ?? "Your PT"}</span>
              <span>{new Date(n.createdAt).toLocaleDateString()}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
      {fromPt.length > 3 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-xs text-muted underline hover:text-ink"
        >
          {showAll ? "Show fewer" : `Show all ${fromPt.length}`}
        </button>
      )}
    </section>
  );
}

/** The patient's journal: what they write for their PT. The PT's side of the
 *  conversation lives at the top of the page now, so this list is the
 *  patient's own entries only. */
function Journal({ notes, onChanged }: { notes: Note[]; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = notes.filter((n) => n.authorRole === "patient");

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
      onChanged();
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
        Anything you write here goes to your PT. Their replies show up at the top of this page.
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
        {mine.map((n) => (
          <li key={n.id} className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="font-medium text-ink">You</span>
              <span>{new Date(n.createdAt).toLocaleDateString()}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Subscribe-from-URL calendar sync (the plants-app pattern). The link holds a
 *  capability token — Google polls it without auth, so the secret IS the URL,
 *  which is why the card talks about it like a password. undefined = still
 *  loading, null = feed off. */
function CalendarSync() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/me/calendar-token")
      .then(async (res) =>
        res.ok ? ((await res.json()) as { token: string | null }).token : null,
      )
      .then((t) => alive && setToken(t))
      .catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, []);

  // Safe against SSR: token starts undefined, so this line only ever runs in
  // the browser after the effect has resolved.
  const url = token ? `${window.location.origin}${withBase(`/api/calendar/${token}`)}` : null;

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/calendar-token", { method: "POST" });
      if (!res.ok) {
        setError("couldn't create the link — try again");
        return;
      }
      setToken(((await res.json()) as { token: string }).token);
      setCopied(false);
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/me/calendar-token", { method: "DELETE" });
      setToken(null);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can be denied — the input is selectable either way.
    }
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        On your calendar
      </h2>
      {token === undefined ? (
        <p className="mt-1 text-xs text-muted">Loading…</p>
      ) : token === null ? (
        <>
          <p className="mt-1 text-xs text-muted">
            See your program on Google Calendar (or Apple, Outlook): one all-day entry each
            day listing your exercises, updated when your PT changes the plan.
          </p>
          <button
            onClick={() => void mint()}
            disabled={busy}
            className="mt-2 rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create my calendar link"}
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">
            In Google Calendar: <span className="font-medium text-ink">Settings → Add
            calendar → From URL</span>, then paste this link. Google refreshes it on its own
            schedule — usually within a few hours.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              readOnly
              value={url ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-raise/60 px-3 py-2 font-mono text-xs outline-none"
            />
            <button
              onClick={() => void copy()}
              className="rounded-lg border border-edge px-3 py-2 text-sm font-medium hover:bg-raise"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            This link is yours alone — anyone holding it can read your exercise list, so
            treat it like a password.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <button
              onClick={() => void mint()}
              disabled={busy}
              className="text-muted underline hover:text-ink disabled:opacity-40"
            >
              Get a new link (the old one stops working)
            </button>
            <button
              onClick={() => void turnOff()}
              disabled={busy}
              className="text-muted underline hover:text-flag disabled:opacity-40"
            >
              Turn off
            </button>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
    </section>
  );
}

/** The home-equipment shelf. Rendered planless too — "what do you have at
 *  home" is a first-visit intake question, and the answer shapes the very
 *  first AI draft. */
function EquipmentShelf({
  equipment,
  onToggle,
}: {
  equipment: Equipment[];
  onToggle: (id: string, owned: boolean) => void;
}) {
  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        My home equipment
      </h2>
      <p className="mt-1 text-xs text-muted">
        Check what you have — your PT&apos;s AI-drafted plans only use what you own.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {equipment.map((e) => (
          <button
            key={e.id}
            onClick={() => onToggle(e.id, !e.owned)}
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
      // Close the card so the save visibly DID something: the tile collapses
      // and the ✓ chip is what's left. Leaving the form open read as "nothing
      // happened".
      setOpen(false);
      onLogged();
    } catch {
      setError("network error — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li
      className={`rounded-xl border p-4 ${
        logged ? "border-accent-deep/50 bg-accent-deep/5" : "border-edge bg-card"
      }`}
    >
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
            {logged && (
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
          {logged
            ? "Edit today's log"
            : item.kind === "modality"
              ? "Log this care"
              : "Log this exercise"}
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
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "office">("home");

  async function load() {
    try {
      const [planRes, visitRes, notesRes] = await Promise.all([
        apiFetch("/api/me/plan"),
        apiFetch("/api/me/visits"),
        apiFetch("/api/me/notes"),
      ]);
      if (!planRes.ok) {
        setError(`load failed (${planRes.status})`);
        return;
      }
      setData((await planRes.json()) as PlanData);
      // A failed visit or notes fetch shouldn't blank the Today view — home
      // exercises are the reason the patient opened the app.
      if (visitRes.ok) setVisits(((await visitRes.json()) as { visits: Visit[] }).visits);
      if (notesRes.ok) setNotes(((await notesRes.json()) as { notes: Note[] }).notes);
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
    // No plan yet is not nothing to do: the pre-visit intake is the single
    // most useful thing a patient can hand their PT, the equipment shelf
    // shapes the first AI draft, and the journal still reaches the PT.
    return (
      <div className="space-y-5">
        <PtMessages notes={notes} />
        <div className="rounded-xl border border-edge bg-card p-6 text-center">
          <p className="font-semibold">No active plan yet</p>
          <p className="mt-1 text-sm text-muted">
            Once your PT approves your program, it shows up here.
          </p>
        </div>
        <PatientIntake />
        <EquipmentShelf equipment={data.equipment} onToggle={(id, o) => void toggleEquipment(id, o)} />
        <Journal notes={notes} onChanged={() => void load()} />
        <CalendarSync />
      </div>
    );
  }

  const homeItems = data.items.filter((i) => i.location === "home" || i.location === "both");
  // "Ice before or after?" — answered by layout. Timed care brackets the
  // session; untimed care and every exercise stay in the main run.
  const beforeItems = homeItems.filter((i) => i.careTiming === "before");
  const afterItems = homeItems.filter((i) => i.careTiming === "after");
  const mainItems = homeItems.filter((i) => i.careTiming === null);
  const streakCount = currentStreakCount(data.streak);
  const doneCount = homeItems.filter((i) => i.logId !== null).length;

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

      <PtMessages notes={notes} />

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
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted" aria-live="polite">
              {doneCount === homeItems.length ? (
                <span className="text-accent-deep">
                  ✓ All {homeItems.length} logged today — done for the day
                </span>
              ) : (
                `${doneCount} of ${homeItems.length} logged today`
              )}
            </p>
            {beforeItems.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  Before you start
                </p>
                <ul className="space-y-2">
                  {beforeItems.map((it) => (
                    <ExerciseCard key={it.id} item={it} onLogged={() => void load()} />
                  ))}
                </ul>
              </div>
            )}
            {mainItems.length > 0 && (
              <div>
                {(beforeItems.length > 0 || afterItems.length > 0) && (
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                    Your exercises
                  </p>
                )}
                <ul className="space-y-2">
                  {mainItems.map((it) => (
                    <ExerciseCard key={it.id} item={it} onLogged={() => void load()} />
                  ))}
                </ul>
              </div>
            )}
            {afterItems.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  After you finish
                </p>
                <ul className="space-y-2">
                  {afterItems.map((it) => (
                    <ExerciseCard key={it.id} item={it} onLogged={() => void load()} />
                  ))}
                </ul>
              </div>
            )}
          </div>
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

      {data.plan.equipmentSuggestions.length > 0 && (
        <section className="rounded-xl border border-edge bg-card p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Worth getting
          </h2>
          <p className="mt-1 text-xs text-muted">
            Your PT thinks these would help your recovery at home. No pressure — tick them
            in the equipment shelf below if you pick one up.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {data.plan.equipmentSuggestions.map((s) => (
              <li key={s.slug} className="rounded-lg bg-raise/60 px-3 py-2">
                <span className="font-medium">{s.name}</span>
                {s.reason && <span className="text-muted"> — {s.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <EquipmentShelf
        equipment={data.equipment}
        onToggle={(id, o) => void toggleEquipment(id, o)}
      />

      <CareLogger
        options={data.careOptions}
        logged={data.adhocToday}
        onChanged={() => void load()}
      />

      {data.goals && (
        <GoalCheck
          // Keyed on the newest rating date so a fresh save reseeds the
          // sliders instead of holding stale local state.
          key={data.goals.rows.map((g) => g.currentOn ?? g.baselineOn).join("|")}
          goals={data.goals.rows}
          promptDue={data.goals.promptDue}
          onChanged={() => void load()}
        />
      )}

      <RaiseHand current={data.checkin} onChanged={() => void load()} />

      <Journal notes={notes} onChanged={() => void load()} />

      <CalendarSync />
    </div>
  );
}
