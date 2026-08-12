"use client";

// "+ Add an exercise" at the foot of the ACTIVE plan (Dan's ask: "after the
// AI makes it and I as the pt approve the plan, let me add new exercises as I
// see fit"). The third door beside the ↑/↓ pills and the ✨ redraft: search,
// dose, add — the press is the approval, and it reaches the patient
// immediately as a plan revision (the old plan retires; nothing is edited).

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { dosageText, type DosageType } from "@/lib/dosage";
import { imageFitClass, imageSrc } from "@/lib/media";

type Hit = {
  id: string;
  name: string;
  difficulty: number | null;
  dosageType: DosageType;
  kind: "exercise" | "modality";
  image: string | null;
};

type Dose = {
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins: number | null;
  intensity: string | null;
  /** Null while the field is cleared mid-typing — snapping a default back in
   *  turned a backspaced "7" into "57" on the phone. Defaults on submit. */
  frequencyPerWeek: number | null;
  location: "office" | "home" | "both";
  careTiming: "" | "before" | "after";
};

/** Parse an input's value, empty allowed. Clamped like the server will. */
function numOrNull(v: string, lo: number, hi: number): number | null {
  if (v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

function seedDose(hit: Hit): Dose {
  return {
    sets: hit.dosageType === "time" ? null : 3,
    reps: hit.dosageType === "reps" ? 10 : null,
    holdSecs: hit.dosageType === "hold" ? 20 : null,
    durationMins: hit.dosageType === "time" ? (hit.kind === "modality" ? 15 : 10) : null,
    intensity: null,
    frequencyPerWeek: hit.kind === "modality" ? 7 : 5,
    location: "home",
    careTiming: "",
  };
}

export default function AmendPlan({
  activePlanId,
  patientName,
  existingExerciseIds,
  onChanged,
}: {
  activePlanId: string;
  patientName: string;
  existingExerciseIds: string[];
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [dose, setDose] = useState<Dose | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const firstName = patientName.split(" ")[0];

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = search.trim();
    // All setState happens inside the debounce callback (async), never in the
    // effect body itself — same shape as the draft editor's picker.
    timer.current = setTimeout(
      async () => {
        if (!q) {
          setHits([]);
          return;
        }
        // kind=any: adding ice by hand mid-plan is as real as adding a squat.
        const res = await apiFetch(
          `/api/exercises?${new URLSearchParams({ q, kind: "any", limit: "8" })}`,
        );
        if (res.ok) {
          const d = (await res.json()) as { items: Hit[] };
          setHits(d.items.filter((h) => !existingExerciseIds.includes(h.id)));
        }
      },
      q ? 250 : 0,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // A new plan id means a new exclusion list; mid-flight that only happens
    // via onChanged, which unmounts this form state anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function reset() {
    setOpen(false);
    setSearch("");
    setHits([]);
    setPicked(null);
    setDose(null);
    setRationale("");
    setError(null);
  }

  async function add() {
    if (!picked || !dose) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/plans/${activePlanId}/amend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exerciseId: picked.id,
          sets: dose.sets,
          reps: dose.reps,
          holdSecs: dose.holdSecs,
          durationMins: dose.durationMins,
          intensity: dose.intensity,
          frequencyPerWeek: dose.frequencyPerWeek,
          location: dose.location,
          rationale,
          careTiming: dose.careTiming || null,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `couldn't add that (${res.status})`);
        return;
      }
      reset();
      await onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 w-full rounded-lg border border-dashed border-edge px-3 py-2 text-left text-sm text-muted hover:bg-raise"
      >
        ＋ Add an exercise to the plan
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-edge bg-card p-3">
      {!picked ? (
        <div className="relative">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search — exercise or care, name or tag…"
            className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {search.trim() && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-card shadow-lg">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => {
                      setPicked(h);
                      setDose(seedDose(h));
                      setHits([]);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-raise"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-raise">
                      {imageSrc(h.image) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageSrc(h.image)!} alt="" className={imageFitClass(h.image)} />
                      ) : (
                        <span aria-hidden className="text-sm">🦵</span>
                      )}
                    </span>
                    <span className="min-w-0">
                      {h.name}
                      {h.kind === "modality" && (
                        <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
                          care
                        </span>
                      )}
                      {h.difficulty && h.kind !== "modality" ? (
                        <span className="ml-2 text-xs text-muted">lvl {h.difficulty}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
              {hits.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted">Nothing matches.</li>
              )}
            </ul>
          )}
        </div>
      ) : (
        dose && (
          <>
            <p className="text-sm">
              <span className="font-medium">{picked.name}</span>
              {picked.difficulty !== null && picked.kind !== "modality" && (
                <span className="ml-2 text-xs text-muted">lvl {picked.difficulty}</span>
              )}
              <button
                onClick={() => {
                  setPicked(null);
                  setDose(null);
                }}
                className="ml-3 text-xs text-muted underline hover:text-ink"
              >
                pick another
              </button>
            </p>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {picked.dosageType === "time" ? (
                <>
                  <label className="flex items-center gap-1 text-muted">
                    <input
                      type="number" min={1} max={240} value={dose.durationMins ?? ""}
                      onChange={(e) =>
                        setDose({ ...dose, durationMins: numOrNull(e.target.value, 1, 240) })
                      }
                      className="w-16 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                    />
                    min
                  </label>
                  <input
                    value={dose.intensity ?? ""}
                    onChange={(e) => setDose({ ...dose, intensity: e.target.value || null })}
                    placeholder="intensity (level 2, yellow band…)"
                    className="w-44 rounded-md border border-edge bg-card px-2 py-1"
                  />
                </>
              ) : (
                <>
                  <label className="flex items-center gap-1 text-muted">
                    <input
                      type="number" min={1} max={10} value={dose.sets ?? ""}
                      onChange={(e) => setDose({ ...dose, sets: numOrNull(e.target.value, 1, 10) })}
                      className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                    />
                    sets
                  </label>
                  {picked.dosageType === "reps" ? (
                    <label className="flex items-center gap-1 text-muted">
                      ×
                      <input
                        type="number" min={1} max={50} value={dose.reps ?? ""}
                        onChange={(e) => setDose({ ...dose, reps: numOrNull(e.target.value, 1, 50) })}
                        className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                      />
                      reps
                    </label>
                  ) : (
                    <label className="flex items-center gap-1 text-muted">
                      hold
                      <input
                        type="number" min={1} max={300} value={dose.holdSecs ?? ""}
                        onChange={(e) =>
                          setDose({ ...dose, holdSecs: numOrNull(e.target.value, 1, 300) })
                        }
                        className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                      />
                      s
                    </label>
                  )}
                </>
              )}
              <label className="flex items-center gap-1 text-muted">
                <input
                  type="number" min={1} max={14} value={dose.frequencyPerWeek ?? ""}
                  onChange={(e) =>
                    setDose({ ...dose, frequencyPerWeek: numOrNull(e.target.value, 1, 14) })
                  }
                  className="w-14 rounded-md border border-edge bg-card px-1.5 py-1 text-center"
                />
                /wk
              </label>
              <select
                value={dose.location}
                onChange={(e) => setDose({ ...dose, location: e.target.value as Dose["location"] })}
                className="rounded-md border border-edge bg-card px-1.5 py-1"
              >
                <option value="home">home</option>
                <option value="office">office</option>
                <option value="both">both</option>
              </select>
              {picked.kind === "modality" && (
                <select
                  value={dose.careTiming}
                  onChange={(e) =>
                    setDose({ ...dose, careTiming: e.target.value as Dose["careTiming"] })
                  }
                  className="rounded-md border border-edge bg-card px-1.5 py-1"
                >
                  <option value="">anytime</option>
                  <option value="before">before exercises</option>
                  <option value="after">after exercises</option>
                </select>
              )}
            </div>
            <p className="text-xs text-muted">
              Will be prescribed as{" "}
              <span className="font-medium text-ink">
                {dosageText({ dosageType: picked.dosageType, ...dose })} ·{" "}
                {dose.frequencyPerWeek ?? (picked.kind === "modality" ? 7 : 5)}/wk ·{" "}
                {dose.location}
              </span>
            </p>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={2}
              placeholder={`Why (optional) — ${firstName} reads this`}
              className="w-full rounded-md border border-edge bg-card px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
            {error && <p className="text-xs text-flag">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void add()}
                disabled={busy}
                className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
              >
                {busy ? "Adding…" : `Add it to ${firstName}'s plan`}
              </button>
              <span className="text-xs text-muted">
                Takes effect immediately — the rest of the plan is untouched.
              </span>
            </div>
          </>
        )
      )}
      <button onClick={reset} className="text-xs text-muted underline hover:text-ink">
        cancel
      </button>
    </div>
  );
}
