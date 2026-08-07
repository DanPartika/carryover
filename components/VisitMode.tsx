"use client";

// In-office quick mode (PRD build step 6). The PT is standing next to the
// patient with a tablet, so doctrine #2 rules the design: tap-done on the
// prescribed list, prescribed dosage prefilled, tweaking optional, quick-add
// for whatever they reached for that isn't on the plan. Target: under two
// minutes for a whole session, and nothing here should ever need a keyboard.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { dosageText, dosageTypeOf, type DosageType } from "@/lib/dosage";

type PlanItem = {
  id: string;
  exerciseId: string;
  name: string;
  dosageType: DosageType;
  kind: "exercise" | "modality";
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  location: "office" | "home" | "both";
};

type VisitItem = {
  exerciseId: string;
  name?: string;
  dosageType?: DosageType;
  planItemId: string | null;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  pain: number | null;
  note: string | null;
};

type Visit = {
  id: string;
  startedAt: string;
  /** Postgres-resolved day label — see the note in /api/visits. */
  startedOn: string;
  endedAt: string | null;
  note: string | null;
  ptName: string | null;
  items: VisitItem[];
};

type SearchHit = {
  id: string;
  name: string;
  difficulty: number | null;
  dosageType: DosageType;
  kind: "exercise" | "modality";
};

const QUICKADD_REGIONS = [
  ["", "any region"],
  ["knee", "knee"],
  ["hip", "hip"],
  ["ankle_foot", "ankle/foot"],
  ["spine", "spine"],
  ["core", "core"],
  ["shoulder", "shoulder"],
  ["elbow", "elbow"],
  ["wrist_hand", "wrist/hand"],
  ["neck", "neck"],
] as const;

function minutesBetween(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
}

/** Render a 'yyyy-mm-dd' from the server without letting the browser's offset
 *  shift it — parsed as UTC midnight and formatted in UTC. */
function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const numInput =
  "w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center text-sm outline-none focus:border-accent";

export default function VisitMode({
  episodeId,
  planItems,
  onVisitEnded,
}: {
  episodeId: string;
  planItems: PlanItem[];
  onVisitEnded: () => void;
}) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, VisitItem>>({});
  const [wrapNote, setWrapNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchRegion, setSearchRegion] = useState("");
  const [searchCare, setSearchCare] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/visits?episodeId=${episodeId}`);
      if (!res.ok) {
        setError(`visits load failed (${res.status})`);
        return;
      }
      const d = (await res.json()) as { visits: Visit[] };
      setError(null);
      setVisits(d.visits);
      const open = d.visits.find((v) => !v.endedAt) ?? null;
      setOpenId(open?.id ?? null);
      setItems(Object.fromEntries((open?.items ?? []).map((i) => [i.exerciseId, i])));
      setWrapNote(open?.note ?? "");
    } catch {
      setError("network error loading visits");
    }
  }, [episodeId]);

  useEffect(() => {
    // setState runs inside load() after an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Library search for quick-add. Care toggle or a region alone is enough to
  // browse — in the room the PT reaches for "ice" without typing "ice".
  // All setState is inside the debounce callback.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    searchTimer.current = setTimeout(
      async () => {
        if (!q && !searchRegion && !searchCare) {
          setHits([]);
          return;
        }
        const params = new URLSearchParams({ limit: "6" });
        if (q) params.set("q", q);
        if (searchRegion) params.set("region", searchRegion);
        if (searchCare) params.set("kind", "modality");
        const res = await apiFetch(`/api/exercises?${params}`);
        if (res.ok) setHits(((await res.json()) as { items: SearchHit[] }).items);
      },
      q ? 250 : 0,
    );
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, searchRegion, searchCare]);

  async function startVisit() {
    setBusy("start");
    setError(null);
    try {
      const res = await apiFetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId }),
      });
      if (!res.ok) {
        setError(`could not start the visit (${res.status})`);
        return;
      }
      await load();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  /** Write one exercise into the open visit. Optimistic: the row flips the
   *  instant it's tapped, and a failure reloads the server's truth rather than
   *  leaving the PT looking at a tick that never saved. */
  async function upsert(patch: VisitItem) {
    setItems((prev) => ({ ...prev, [patch.exerciseId]: patch }));
    try {
      const res = await apiFetch(`/api/visits/${openId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError("that tap didn't save — check the list");
        await load();
      }
    } catch {
      setError("network error — that tap didn't save");
      await load();
    }
  }

  async function untap(exerciseId: string) {
    setItems((prev) => {
      const next = { ...prev };
      delete next[exerciseId];
      return next;
    });
    try {
      await apiFetch(`/api/visits/${openId}/items?exerciseId=${exerciseId}`, { method: "DELETE" });
    } catch {
      setError("network error — that change didn't save");
      await load();
    }
  }

  async function endVisit() {
    setBusy("end");
    setError(null);
    try {
      const res = await apiFetch(`/api/visits/${openId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: wrapNote, end: true }),
      });
      if (!res.ok) {
        setError(`could not end the visit (${res.status})`);
        return;
      }
      await load();
      onVisitEnded();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  const officeItems = planItems.filter((i) => i.location === "office" || i.location === "both");
  // Quick-adds have no plan row, so they'd otherwise be invisible in the list.
  const extras = Object.values(items).filter((i) => !officeItems.some((p) => p.exerciseId === i.exerciseId));

  if (!visits) {
    return (
      <section className="rounded-xl border border-edge bg-card p-5">
        <p className="text-sm text-muted">{error ?? "Loading visits…"}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">In office</h2>
        {!openId && (
          <button
            onClick={() => void startVisit()}
            disabled={busy !== null}
            className="rounded-full bg-[var(--color-clinic)] px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy === "start" ? "Starting…" : "Start visit"}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}

      {openId ? (
        <div className="mt-3 space-y-3">
          <p className="rounded-lg bg-[var(--color-clinic)]/10 px-3 py-2 text-xs">
            Visit in progress — tap what you did together. Dosage is prefilled from the plan; change
            it only if it changed.
          </p>

          <ul className="space-y-1.5">
            {officeItems.map((p) => {
              const done = items[p.exerciseId];
              return (
                <li
                  key={p.exerciseId}
                  className={`rounded-lg border p-3 ${done ? "border-accent bg-accent/5" : "border-edge"}`}
                >
                  <button
                    onClick={() =>
                      done
                        ? void untap(p.exerciseId)
                        : void upsert({
                            exerciseId: p.exerciseId,
                            name: p.name,
                            dosageType: dosageTypeOf(p),
                            planItemId: p.id,
                            sets: p.sets,
                            reps: p.reps,
                            holdSecs: p.holdSecs,
                            durationMins: p.durationMins,
                            intensity: p.intensity,
                            pain: null,
                            note: null,
                          })
                    }
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm ${
                        done
                          ? "border-accent-deep bg-accent-deep text-white"
                          : "border-edge text-muted"
                      }`}
                      aria-hidden
                    >
                      {done ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{p.name}</span>
                      <span className="block text-xs text-muted">
                        {dosageText(p)} · {p.location}
                      </span>
                    </span>
                  </button>
                  {done && <ItemDetail item={done} onChange={(next) => void upsert(next)} />}
                </li>
              );
            })}
          </ul>

          {extras.length > 0 && (
            <ul className="space-y-1.5">
              {extras.map((x) => (
                <li key={x.exerciseId} className="rounded-lg border border-accent bg-accent/5 p-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-deep bg-accent-deep text-sm text-white">
                      ✓
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{x.name ?? "Added exercise"}</span>
                      <span className="block text-xs text-muted">not on the plan — added today</span>
                    </span>
                    <button
                      onClick={() => void untap(x.exerciseId)}
                      className="text-muted hover:text-flag"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                  <ItemDetail item={x} onChange={(next) => void upsert(next)} />
                </li>
              ))}
            </ul>
          )}

          <div className="relative">
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <button
                onClick={() => setSearchCare(!searchCare)}
                className={`rounded-full border px-2.5 py-1 ${
                  searchCare
                    ? "border-accent-deep bg-accent-deep font-medium text-white"
                    : "border-edge text-muted hover:bg-raise"
                }`}
              >
                Care (ice, heat…)
              </button>
              <select
                value={searchRegion}
                onChange={(e) => setSearchRegion(e.target.value)}
                className="rounded-md border border-edge bg-card px-1.5 py-1"
              >
                {QUICKADD_REGIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                searchCare ? "Did care in the room? Tap one below…" : "Did something else? Search the library…"
              }
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {hits.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-card shadow-lg">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => {
                        void upsert({
                          exerciseId: h.id,
                          name: h.name,
                          dosageType: h.dosageType,
                          planItemId: null,
                          sets: h.dosageType === "time" ? null : 3,
                          reps: h.dosageType === "reps" ? 10 : null,
                          holdSecs: h.dosageType === "hold" ? 20 : null,
                          durationMins: h.dosageType === "time" ? (h.kind === "modality" ? 15 : 10) : null,
                          intensity: null,
                          pain: null,
                          note: null,
                        });
                        setSearch("");
                        setHits([]);
                      }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-raise"
                    >
                      {h.name}
                      {h.kind === "modality" && (
                        <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
                          care
                        </span>
                      )}
                      {h.difficulty && h.kind !== "modality" ? (
                        <span className="ml-2 text-xs text-muted">lvl {h.difficulty}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-edge pt-3">
            <textarea
              value={wrapNote}
              onChange={(e) => setWrapNote(e.target.value)}
              rows={2}
              placeholder="How did it go? (the patient sees this)"
              className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={() => void endVisit()}
              disabled={busy !== null}
              className="mt-2 w-full rounded-lg bg-accent-deep py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40 sm:w-auto sm:px-6"
            >
              {busy === "end" ? "Ending…" : `End visit · ${Object.keys(items).length} done`}
            </button>
          </div>
        </div>
      ) : visits.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          No visits recorded yet. Start one when the patient is in the room — it takes about a
          minute.
        </p>
      ) : null}

      {visits.filter((v) => v.endedAt).length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-edge pt-3">
          {visits
            .filter((v) => v.endedAt)
            .map((v) => (
              <li key={v.id} className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {dayLabel(v.startedOn)} · {v.items.length} exercise
                    {v.items.length === 1 ? "" : "s"}
                  </span>
                  <span className="text-xs text-muted">
                    {minutesBetween(v.startedAt, v.endedAt!)} min
                    {v.ptName ? ` · ${v.ptName}` : ""}
                  </span>
                </div>
                {v.items.length > 0 && (
                  <p className="mt-0.5 text-xs text-muted">
                    {v.items.map((i) => i.name).join(", ")}
                  </p>
                )}
                {v.note && <p className="mt-1 text-sm">{v.note}</p>}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

/** The optional half of tap-done: what actually happened, if it differed.
 *
 *  Edits are held locally and committed on blur, not per keystroke — typing
 *  "10" in the reps box would otherwise POST twice, and the second write would
 *  race the first. Blur covers moving to the next field, tapping End visit,
 *  and putting the tablet down. */
function ItemDetail({
  item,
  onChange,
}: {
  item: VisitItem;
  onChange: (next: VisitItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(item);

  function commit() {
    if (
      draft.sets !== item.sets ||
      draft.reps !== item.reps ||
      draft.durationMins !== item.durationMins ||
      draft.pain !== item.pain ||
      draft.note !== item.note
    ) {
      onChange(draft);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1.5 text-xs text-muted underline decoration-dotted hover:text-ink"
      >
        adjust dosage or add pain
      </button>
    );
  }

  const num = (v: string) => (v === "" ? null : Number(v));
  const timed = dosageTypeOf(draft) === "time";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted" onBlur={commit}>
      {timed ? (
        <label className="flex items-center gap-1">
          minutes
          <input
            type="number" min={0} max={240} value={draft.durationMins ?? ""}
            onChange={(e) => setDraft({ ...draft, durationMins: num(e.target.value) })}
            className={numInput}
          />
        </label>
      ) : (
        <>
          <label className="flex items-center gap-1">
            sets
            <input
              type="number" min={0} max={20} value={draft.sets ?? ""}
              onChange={(e) => setDraft({ ...draft, sets: num(e.target.value) })}
              className={numInput}
            />
          </label>
          <label className="flex items-center gap-1">
            reps
            <input
              type="number" min={0} max={100} value={draft.reps ?? ""}
              onChange={(e) => setDraft({ ...draft, reps: num(e.target.value) })}
              className={numInput}
            />
          </label>
        </>
      )}
      <label className="flex items-center gap-1">
        pain
        <input
          type="number" min={0} max={10} value={draft.pain ?? ""}
          onChange={(e) => setDraft({ ...draft, pain: num(e.target.value) })}
          className={numInput}
        />
      </label>
      {/* The per-exercise note is where the PT actually types during a
          session — full-width and multi-line, not a min-w-32 sliver. */}
      <textarea
        value={draft.note ?? ""}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        rows={2}
        placeholder="Note — how it went, cues that worked, what to try next time"
        className="w-full rounded-md border border-edge bg-card px-2 py-1.5 outline-none focus:border-accent"
      />
    </div>
  );
}
