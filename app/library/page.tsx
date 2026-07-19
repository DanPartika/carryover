"use client";

// Exercise library browse (PRD build step 1): facet filters + search over the
// seeded library, detail panel with instructions, provenance, and progression
// chain neighbors. The plan editor (step 3) reuses these building blocks.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";

type Item = {
  id: string;
  name: string;
  source: string;
  body_regions: string[];
  position: string | null;
  difficulty: number | null;
  tags: string[];
  image: string | null;
  equipment: string[];
};

type Detail = {
  exercise: {
    id: string;
    name: string;
    source: string;
    instructions: string[];
    body_regions: string[];
    position: string | null;
    difficulty: number | null;
    tags: string[];
    images: string[];
    video_url: string | null;
    license: string;
    license_author: string | null;
    source_url: string | null;
  };
  equipment: { slug: string; name: string; kind: string }[];
  progressions: {
    easier: { id: string; name: string; note: string | null }[];
    harder: { id: string; name: string; note: string | null }[];
  };
};

const REGIONS = [
  ["", "All regions"],
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
  ["", "Any equipment"],
  ["none", "No equipment"],
  ["resistance-band", "Resistance band"],
  ["chair", "Chair"],
  ["wall", "Wall"],
  ["step", "Step / stair"],
  ["towel", "Towel / strap"],
  ["ankle-weights", "Ankle weights"],
  ["dumbbell", "Dumbbell"],
  ["barbell", "Barbell"],
  ["kettlebell", "Kettlebell"],
  ["cable-machine", "Cable machine"],
  ["machine", "Gym machine"],
  ["exercise-ball", "Exercise ball"],
  ["medicine-ball", "Medicine ball"],
  ["foam-roller", "Foam roller"],
] as const;

const PAGE = 30;

function DifficultyDots({ level }: { level: number | null }) {
  if (!level) return null;
  return (
    <span className="inline-flex items-center gap-0.5" title={`Difficulty ${level}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i <= level ? "bg-accent" : "bg-edge"}`}
        />
      ))}
    </span>
  );
}

export default function LibraryPage() {
  const { enabled, loading, session } = useAuth();
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const [equipment, setEquipment] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [kneeCoreOnly, setKneeCoreOnly] = useState(false);
  const [includeGym, setIncludeGym] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authReady = !loading && (!enabled || !!session);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      setBusy(true);
      setError(null);
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (q.trim()) params.set("q", q.trim());
      if (region) params.set("region", region);
      if (equipment) params.set("equipment", equipment);
      if (difficulty) params.set("difficulty", difficulty);
      if (kneeCoreOnly) params.set("source", "carryover");
      if (includeGym) params.set("tier", "all");
      try {
        const res = await apiFetch(`/api/exercises?${params}`);
        if (!res.ok) throw new Error(`exercises ${res.status}`);
        const data = (await res.json()) as { items: Item[]; total: number };
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setOffset(nextOffset);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [q, region, equipment, difficulty, kneeCoreOnly, includeGym],
  );

  useEffect(() => {
    if (!authReady) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(0, false), q ? 250 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [authReady, load, q]);

  async function openDetail(id: string) {
    const res = await apiFetch(`/api/exercises/${id}`);
    if (res.ok) setDetail((await res.json()) as Detail);
  }

  if (!authReady) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Exercise library</h1>
          <p className="text-sm text-muted">
            {total} exercises{kneeCoreOnly ? " · knee-rehab core" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={kneeCoreOnly}
              onChange={(e) => setKneeCoreOnly(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent-deep)]"
            />
            Knee-rehab core only
          </label>
          <label
            className="flex cursor-pointer items-center gap-2 text-sm text-muted"
            title="Barbell, kettlebell, olympic, and strongman work — hidden from the clinical view by default"
          >
            <input
              type="checkbox"
              checked={includeGym}
              onChange={(e) => setIncludeGym(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent-deep)]"
            />
            Include gym extras
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search exercises…"
          className="min-w-40 flex-1 rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          {REGIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={equipment}
          onChange={(e) => setEquipment(e.target.value)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          {EQUIPMENT.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          <option value="">Any difficulty</option>
          <option value="1">Level 1 only</option>
          <option value="2">Up to level 2</option>
          <option value="3">Up to level 3</option>
          <option value="4">Up to level 4</option>
          <option value="5">Up to level 5</option>
        </select>
      </div>

      {error && <p className="text-sm text-flag">Failed to load: {error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => void openDetail(it.id)}
            className="group rounded-xl border border-edge bg-card p-3 text-left transition hover:border-accent"
          >
            <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-raise">
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.image}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-3xl" aria-hidden>
                  🦵
                </span>
              )}
            </div>
            <div className="mt-2 flex items-start justify-between gap-2">
              <span className="text-sm font-semibold leading-tight">{it.name}</span>
              <DifficultyDots level={it.difficulty} />
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {it.source === "carryover" && (
                <span className="rounded-full bg-accent-deep px-2 py-0.5 text-[11px] font-medium text-white">
                  knee core
                </span>
              )}
              {it.body_regions.slice(0, 3).map((r) => (
                <span key={r} className="rounded-full bg-raise px-2 py-0.5 text-[11px] text-muted">
                  {r.replace("_", "/")}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {items.length < total && (
        <div className="text-center">
          <button
            onClick={() => void load(offset + PAGE, true)}
            disabled={busy}
            className="rounded-full border border-edge bg-card px-5 py-2 text-sm font-medium hover:bg-raise disabled:opacity-50"
          >
            {busy ? "Loading…" : `Show more (${items.length} of ${total})`}
          </button>
        </div>
      )}

      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
          onClick={() => setDetail(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold">{detail.exercise.name}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <DifficultyDots level={detail.exercise.difficulty} />
                  {detail.exercise.position && <span>{detail.exercise.position.replace("_", "-")}</span>}
                  {detail.exercise.body_regions.map((r) => (
                    <span key={r} className="rounded-full bg-raise px-2 py-0.5">
                      {r.replace("_", "/")}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="rounded-full border border-edge px-2.5 py-1 text-sm text-muted hover:bg-raise"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {detail.exercise.images.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {detail.exercise.images.slice(0, 2).map((src) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={src} src={src} alt="" className="rounded-lg bg-raise object-cover" />
                ))}
              </div>
            )}

            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
              {detail.exercise.instructions.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>

            {detail.equipment.length > 0 && (
              <p className="mt-4 text-sm">
                <span className="font-semibold">Equipment:</span>{" "}
                <span className="text-muted">
                  {detail.equipment.map((e) => e.name).join(", ")}
                </span>
              </p>
            )}

            {(detail.progressions.easier.length > 0 || detail.progressions.harder.length > 0) && (
              <div className="mt-4 rounded-lg border border-edge bg-raise/50 p-3 text-sm">
                <div className="font-semibold">Progression chain</div>
                {detail.progressions.easier.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => void openDetail(p.id)}
                    className="mt-1 block text-left text-muted hover:text-ink"
                    title={p.note ?? undefined}
                  >
                    ← easier: <span className="underline">{p.name}</span>
                  </button>
                ))}
                {detail.progressions.harder.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => void openDetail(p.id)}
                    className="mt-1 block text-left text-muted hover:text-ink"
                    title={p.note ?? undefined}
                  >
                    → harder: <span className="underline">{p.name}</span>
                  </button>
                ))}
              </div>
            )}

            <p className="mt-4 text-[11px] text-muted">
              {detail.exercise.license}
              {detail.exercise.license_author ? ` · ${detail.exercise.license_author}` : ""}
              {detail.exercise.source_url ? (
                <>
                  {" · "}
                  <a
                    href={detail.exercise.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    source
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
