"use client";

// Exercise library browse (PRD build step 1): facet filters + search over the
// seeded library, detail panel with instructions, provenance, and progression
// chain neighbors. The plan editor (step 3) reuses these building blocks.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/components/AuthContext";
import { useBootstrap } from "@/components/Bootstrap";
import ExerciseComposer from "@/components/ExerciseComposer";
import ExerciseSheet from "@/components/ExerciseSheet";
import { imageFitClass, imageSrc, isOwnedArt } from "@/lib/media";

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
  clinicId: string | null;
  shared: boolean;
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
    clinic_id: string | null;
    clinicName: string | null;
    shared: boolean;
    canEdit: boolean;
  };
  equipment: { slug: string; name: string; kind: string }[];
  progressions: {
    easier: ChainEdge[];
    harder: ChainEdge[];
  };
};

type ChainEdge = {
  id: string;
  name: string;
  difficulty: number | null;
  note: string | null;
  clinicId: string | null;
  /** True when the viewer's own clinic charted this edge — global corridor
   *  edges are read-only in-app. */
  removable: boolean;
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

const POSITIONS = [
  ["", "Any position"],
  ["standing", "Standing"],
  ["seated", "Seated"],
  ["supine", "Lying (back)"],
  ["prone", "Lying (front)"],
  ["side_lying", "Side-lying"],
  ["quadruped", "Hands & knees"],
] as const;

const PAGE = 30;

/** The chain around one exercise, with authoring for PTs (Dan's ask:
 *  "exercises should be seen as a chain progression in the library — the
 *  next harder step is this"). Edges a PT charts here belong to their clinic
 *  and drive their own ↑/↓ swap pills on active plans; the global corridor
 *  chains render read-only beside them. */
function ChainSection({
  detail,
  clinicId,
  onChanged,
  onOpen,
}: {
  detail: Detail;
  /** The viewer's PT/admin clinic — null for everyone who can't chart. */
  clinicId: string | null;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const [adding, setAdding] = useState<"harder" | "easier" | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; difficulty: number | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { easier, harder } = detail.progressions;
  const linked = new Set([detail.exercise.id, ...easier.map((e) => e.id), ...harder.map((e) => e.id)]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = search.trim();
    timer.current = setTimeout(
      async () => {
        if (!q || !adding) {
          setHits([]);
          return;
        }
        const res = await apiFetch(`/api/exercises?${new URLSearchParams({ q, limit: "6" })}`);
        if (res.ok) {
          const d = (await res.json()) as { items: { id: string; name: string; difficulty: number | null }[] };
          setHits(d.items.filter((h) => !linked.has(h.id)));
        }
      },
      q ? 250 : 0,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // linked is derived from detail, which is covered by onChanged remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, adding]);

  async function chart(toExerciseId: string) {
    if (!adding || !clinicId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/exercises/${detail.exercise.id}/progressions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId, toExerciseId, direction: adding }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `couldn't chart that (${res.status})`);
        return;
      }
      setAdding(null);
      setSearch("");
      setHits([]);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function unchart(edge: ChainEdge, direction: "harder" | "easier") {
    if (!clinicId) return;
    const params = new URLSearchParams({ clinicId, toExerciseId: edge.id, direction });
    const res = await apiFetch(
      `/api/exercises/${detail.exercise.id}/progressions?${params}`,
      { method: "DELETE" },
    );
    if (res.ok) onChanged();
  }

  const row = (p: ChainEdge, direction: "harder" | "easier") => (
    <div key={`${direction}-${p.id}`} className="mt-1 flex items-center gap-2">
      <button
        onClick={() => onOpen(p.id)}
        className="block text-left text-muted hover:text-ink"
        title={p.note ?? undefined}
      >
        {direction === "easier" ? "← easier: " : "→ harder: "}
        <span className="underline">{p.name}</span>
        {p.difficulty ? <span className="ml-1 text-xs">lvl {p.difficulty}</span> : null}
        {p.clinicId ? <span className="ml-1 text-xs">(your clinic)</span> : null}
      </button>
      {/* clinicId gate: a patient of the charting clinic also gets
          removable:true in the data, but can't unchart — no dead button. */}
      {clinicId && p.removable && (
        <button
          onClick={() => void unchart(p, direction)}
          className="text-xs text-muted hover:text-flag"
          title="Remove this step (your clinic charted it)"
        >
          ✕
        </button>
      )}
    </div>
  );

  if (easier.length === 0 && harder.length === 0 && !clinicId) return null;

  return (
    <div className="mt-4 rounded-lg border border-edge bg-raise/50 p-3 text-sm">
      <div className="font-semibold">Progression chain</div>
      {easier.length === 0 && harder.length === 0 && (
        <p className="mt-1 text-xs text-muted">
          Nothing charted yet — chart the easier and harder steps and this exercise joins
          the one-tap swap pills on your plans.
        </p>
      )}
      {easier.map((p) => row(p, "easier"))}
      {harder.map((p) => row(p, "harder"))}

      {clinicId && !adding && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => {
              setAdding("easier");
              setError(null);
            }}
            className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-raise"
          >
            ＋ chart an easier step
          </button>
          <button
            onClick={() => {
              setAdding("harder");
              setError(null);
            }}
            className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-muted hover:bg-raise"
          >
            ＋ chart a harder step
          </button>
        </div>
      )}
      {clinicId && adding && (
        <div className="relative mt-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search the ${adding} step…`}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-card px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={() => {
                setAdding(null);
                setSearch("");
                setHits([]);
                setError(null);
              }}
              className="text-xs text-muted underline hover:text-ink"
            >
              cancel
            </button>
          </div>
          {search.trim() && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-card shadow-lg">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => void chart(h.id)}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-raise"
                  >
                    {h.name}
                    {h.difficulty ? (
                      <span className="ml-2 text-xs text-muted">lvl {h.difficulty}</span>
                    ) : null}
                  </button>
                </li>
              ))}
              {hits.length === 0 && <li className="px-3 py-2 text-sm text-muted">Nothing matches.</li>}
            </ul>
          )}
          {error && <p className="mt-1 text-xs text-flag">{error}</p>}
        </div>
      )}
    </div>
  );
}

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
  const { boot, isStaff } = useBootstrap();
  // The clinic this viewer can chart chain steps for — first PT/admin
  // membership. Patients (and PTs of no clinic) browse read-only.
  const chartClinicId =
    boot?.memberships.find((m) => m.role === "pt" || m.role === "admin")?.clinicId ?? null;
  const [q, setQ] = useState("");
  const [region, setRegion] = useState("");
  const [equipment, setEquipment] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [position, setPosition] = useState("");
  const [kind, setKind] = useState<"exercise" | "modality" | "any">("exercise");
  const [kneeCoreOnly, setKneeCoreOnly] = useState(false);
  const [includeGym, setIncludeGym] = useState(false);
  // Full catalog for the equipment filter — the old hardcoded list silently
  // omitted eleven slugs (all the modality gear among them).
  const [catalog, setCatalog] = useState<{ slug: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  // What a patient sees on tapping a card: the plain how-to sheet, not the
  // clinician's panel with its progression chain and authorship controls.
  const [sheet, setSheet] = useState<{ id: string; name: string } | null>(null);
  const [composing, setComposing] = useState(false);
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
      if (position) params.set("position", position);
      if (kind !== "exercise") params.set("kind", kind);
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
    [q, region, equipment, difficulty, position, kind, kneeCoreOnly, includeGym],
  );

  useEffect(() => {
    if (!authReady) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(0, false), q ? 250 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [authReady, load, q]);

  useEffect(() => {
    if (!authReady) return;
    void (async () => {
      const res = await apiFetch("/api/equipment");
      if (res.ok) {
        const d = (await res.json()) as { catalog: { slug: string; name: string }[] };
        setCatalog(d.catalog);
      }
    })();
  }, [authReady]);

  async function openDetail(id: string, name = "") {
    if (!isStaff) {
      setSheet({ id, name });
      return;
    }
    const res = await apiFetch(`/api/exercises/${id}`);
    if (res.ok) setDetail((await res.json()) as Detail);
  }

  /** Promote a clinic's exercise into the library every clinic sees, or pull
   *  it back. Optimistic on the open panel, then a reload so the list badge
   *  agrees with it. */
  async function toggleShared(d: Detail) {
    const next = !d.exercise.shared;
    setDetail({ ...d, exercise: { ...d.exercise, shared: next } });
    const res = await apiFetch(`/api/exercises/${d.exercise.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared: next }),
    });
    if (!res.ok) setDetail(d);
    else void load(0, false);
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
        {/* Authoring and the clinical filters are the clinician's; a patient
            browsing for "how do I do this" gets search and the facets. */}
        {isStaff && (
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
            <button
              onClick={() => setComposing(true)}
              className="rounded-full bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110"
            >
              ＋ New exercise
            </button>
          </div>
        )}
      </div>

      {composing && isStaff && (
        <ExerciseComposer
          onCreated={(created) => {
            setComposing(false);
            void load(0, false);
            void openDetail(created.id);
          }}
          onCancel={() => setComposing(false)}
        />
      )}

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
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          <option value="exercise">Exercises</option>
          <option value="modality">Care (ice, heat…)</option>
          <option value="any">Everything</option>
        </select>
        <select
          value={equipment}
          onChange={(e) => setEquipment(e.target.value)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          <option value="">Any equipment</option>
          {catalog.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          className="rounded-lg border border-edge bg-card px-2 py-2 text-sm"
        >
          {POSITIONS.map(([v, label]) => (
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
            onClick={() => void openDetail(it.id, it.name)}
            className="group rounded-xl border border-edge bg-card p-3 text-left transition hover:border-accent"
          >
            <div className="flex h-32 items-center justify-center overflow-hidden rounded-lg bg-raise">
              {imageSrc(it.image) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageSrc(it.image)!}
                  alt=""
                  loading="lazy"
                  className={imageFitClass(it.image)}
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
                  rehab core
                </span>
              )}
              {/* Who wrote it and who can see it — a PT scanning the grid
                  should never wonder whether an entry is theirs. */}
              {it.clinicId && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    it.shared
                      ? "bg-[var(--color-clinic)] text-white"
                      : "border border-edge text-muted"
                  }`}
                >
                  {it.shared ? "shared" : "our clinic"}
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

      {sheet && !isStaff && (
        <ExerciseSheet
          exerciseId={sheet.id}
          name={sheet.name}
          onClose={() => setSheet(null)}
        />
      )}

      {detail && isStaff && (
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
                  <img key={src} src={imageSrc(src)!} alt="" className={`rounded-lg bg-raise ${isOwnedArt(src) ? "object-contain p-2" : "object-cover"}`} />
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

            <ChainSection
              key={detail.exercise.id}
              detail={detail}
              clinicId={chartClinicId}
              onChanged={() => void openDetail(detail.exercise.id)}
              onOpen={(id) => void openDetail(id)}
            />

            {detail.exercise.clinic_id && (
              <div className="mt-4 rounded-lg border border-edge p-3 text-xs">
                <p className="font-medium">
                  Written by {detail.exercise.clinicName ?? "your clinic"}
                </p>
                <p className="mt-0.5 text-muted">
                  {detail.exercise.shared
                    ? "Shared — every clinic on Carryover can prescribe this."
                    : "Private to your clinic. Nobody else can see or prescribe it."}
                </p>
                {detail.exercise.canEdit && (
                  <button
                    onClick={() => void toggleShared(detail)}
                    className={`mt-2 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                      detail.exercise.shared
                        ? "border border-edge text-muted hover:bg-raise"
                        : "bg-accent-deep text-white hover:brightness-110"
                    }`}
                  >
                    {detail.exercise.shared ? "Make private again" : "Share with every clinic"}
                  </button>
                )}
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
