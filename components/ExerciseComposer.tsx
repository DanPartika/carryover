"use client";

// "The library doesn't have it" — a PT writes their own (Dan's ask #1).
//
// Used from two places, which is why it's a component and not a page: the
// library, and mid-plan when a PT searches for something that isn't there.
// The second is the one that matters — the moment you need a custom exercise
// is the moment you're already building a plan, and sending someone off to a
// different screen to come back later is how a two-minute task becomes a
// tomorrow task (doctrine #2).
//
// Everything written here starts CLINIC-PRIVATE. Sharing is a separate,
// deliberate press on the library page.

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DosageType } from "@/lib/dosage";

type Membership = { clinicId: string; clinicName: string; role: string };

const REGIONS = [
  ["knee", "Knee"],
  ["hip", "Hip"],
  ["ankle_foot", "Ankle / foot"],
  ["spine", "Spine"],
  ["core", "Core"],
  ["shoulder", "Shoulder"],
  ["elbow", "Elbow"],
  ["wrist_hand", "Wrist / hand"],
  ["neck", "Neck"],
  ["full_body", "Full body"],
] as const;

const EQUIPMENT = [
  ["none", "No equipment"],
  ["resistance-band", "Resistance band"],
  ["chair", "Chair"],
  ["wall", "Wall"],
  ["step", "Step / stair"],
  ["towel", "Towel / strap"],
  ["ankle-weights", "Ankle weights"],
  ["foam-roller", "Foam roller"],
  ["exercise-ball", "Exercise ball"],
  ["balance-pad", "Balance pad / BOSU"],
  ["stationary-bike", "Stationary bike"],
  ["dumbbell", "Dumbbell"],
  ["other", "Other"],
] as const;

const DOSAGE: [DosageType, string, string][] = [
  ["reps", "Sets & reps", "3 × 10"],
  ["hold", "Timed hold", "3 × 20s"],
  ["time", "For time", "10 min at level 2"],
];

export default function ExerciseComposer({
  initialName = "",
  clinicId,
  onCreated,
  onCancel,
}: {
  initialName?: string;
  /** Omit to let the composer resolve the PT's clinic itself (library page). */
  clinicId?: string;
  onCreated: (created: { id: string; name: string; dosageType: DosageType }) => void;
  onCancel: () => void;
}) {
  const [clinic, setClinic] = useState<{ id: string; name: string } | null>(
    clinicId ? { id: clinicId, name: "" } : null,
  );
  const [name, setName] = useState(initialName);
  const [regions, setRegions] = useState<string[]>([]);
  const [dosageType, setDosageType] = useState<DosageType>("reps");
  const [difficulty, setDifficulty] = useState(2);
  const [equipment, setEquipment] = useState<string[]>(["none"]);
  const [steps, setSteps] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (clinicId) return;
    void (async () => {
      const res = await apiFetch("/api/bootstrap", { method: "POST" });
      if (!res.ok) return;
      const d = (await res.json()) as { memberships: Membership[] };
      const mine = d.memberships.find((m) => m.role === "pt" || m.role === "admin");
      if (mine) setClinic({ id: mine.clinicId, name: mine.clinicName });
    })();
  }, [clinicId]);

  function toggle(list: string[], v: string, set: (n: string[]) => void) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  async function save() {
    if (!clinic) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/exercises", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicId: clinic.id,
          name,
          bodyRegions: regions,
          dosageType,
          difficulty,
          equipmentSlugs: equipment,
          videoUrl: videoUrl || null,
          instructions: steps
            .split("\n")
            .map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `could not save (${res.status})`);
        return;
      }
      const d = (await res.json()) as { id: string };
      onCreated({ id: d.id, name: name.trim(), dosageType });
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  const chip = (on: boolean) =>
    `cursor-pointer rounded-full border px-3 py-1 text-xs ${
      on ? "border-accent-deep bg-accent-deep text-white" : "border-edge text-muted"
    }`;

  if (!clinic) {
    return (
      <div className="rounded-xl border border-edge bg-card p-4 text-sm text-muted">
        You need a PT or admin role in a clinic to add exercises.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-accent bg-card p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">New exercise</h3>
        <span className="rounded-full bg-raise px-2 py-0.5 text-xs text-muted">
          private to {clinic.name || "your clinic"} until you share it
        </span>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. Wall slide with ball squeeze)"
        className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
      />

      <div>
        <p className="text-xs text-muted">Body region — the AI only offers an exercise to matching intakes</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {REGIONS.map(([v, label]) => (
            <button
              key={v}
              onClick={() => toggle(regions, v, setRegions)}
              className={chip(regions.includes(v))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted">How is it dosed?</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {DOSAGE.map(([v, label, example]) => (
            <button
              key={v}
              onClick={() => setDosageType(v)}
              className={chip(dosageType === v)}
              title={example}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted">Equipment needed</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {EQUIPMENT.map(([v, label]) => (
            <button
              key={v}
              onClick={() => toggle(equipment, v, setEquipment)}
              className={chip(equipment.includes(v))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted">
        Difficulty {difficulty}/5
        <input
          type="range" min={1} max={5} value={difficulty}
          onChange={(e) => setDifficulty(Number(e.target.value))}
          className="flex-1 accent-[var(--color-accent-deep)]"
        />
      </label>

      <textarea
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        rows={4}
        placeholder={"Instructions — one step per line.\nThe patient reads these."}
        className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
      />

      <input
        value={videoUrl}
        onChange={(e) => setVideoUrl(e.target.value)}
        placeholder="Video link (optional)"
        className="w-full rounded-lg border border-edge bg-card px-3 py-2 outline-none focus:border-accent"
      />

      {error && <p className="text-flag">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !name.trim() || regions.length === 0}
          className="rounded-lg bg-accent-deep px-4 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Add to library"}
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
