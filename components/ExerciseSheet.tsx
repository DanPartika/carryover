"use client";

// "How do I do this one?" — the sheet a patient opens by tapping an exercise,
// on Today or in the library. Read-only and deliberately plain: the pictures,
// the steps, what it needs, and the PT's own note if this came from their plan.
// No difficulty level, no progression chain, no authorship controls — those are
// the clinician's tools, and "which step comes next" is a call for the PT.

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { imageSrc, isOwnedArt } from "@/lib/media";

type SheetExercise = {
  id: string;
  name: string;
  instructions: string[];
  images: string[];
  video_url: string | null;
  position: string | null;
};

type SheetData = { exercise: SheetExercise; equipment: { slug: string; name: string }[] };

export default function ExerciseSheet({
  exerciseId,
  name,
  note,
  onClose,
}: {
  exerciseId: string;
  /** Shown while the detail loads, and if it can't be fetched. */
  name: string;
  /** What the PT wrote on this plan item, if anything. */
  note?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<SheetData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/exercises/${exerciseId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as SheetData;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [exerciseId, attempt]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ex = data?.exercise;
  const steps = ex?.instructions ?? [];
  // Equipment links are alternatives, and "none" is one of them: an exercise
  // listing none beside a chair needs nothing, the chair just helps.
  const needsNothing = !!data?.equipment.some((e) => e.slug === "none");
  const gear = (data?.equipment ?? []).filter((e) => e.slug !== "none").map((e) => e.name);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`How to do ${ex?.name ?? name}`}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold">{ex?.name ?? name}</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-full border border-edge px-2.5 py-1 text-sm text-muted hover:bg-raise"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {!data && !failed && <p className="mt-4 text-sm text-muted">Loading…</p>}
        {failed && (
          <p className="mt-4 text-sm text-flag">
            Couldn&apos;t load the instructions.{" "}
            <button onClick={() => setAttempt((n) => n + 1)} className="underline">
              Try again
            </button>
          </p>
        )}

        {note && (
          <p className="mt-3 rounded-lg bg-raise/60 px-3 py-2 text-sm">
            <span className="font-semibold">From your PT: </span>
            {note}
          </p>
        )}

        {ex && (
          <>
            {ex.images.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {ex.images.slice(0, 2).map((src) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={src}
                    src={imageSrc(src)!}
                    alt=""
                    className={`rounded-lg bg-raise ${isOwnedArt(src) ? "col-span-2 mx-auto max-h-48 object-contain p-2" : "object-cover"}`}
                  />
                ))}
              </div>
            )}

            {steps.length > 0 ? (
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            ) : (
              <p className="mt-4 text-sm text-muted">
                No written steps for this one yet — ask your PT to show you.
              </p>
            )}

            {data.equipment.length > 0 && (
              <p className="mt-4 text-sm">
                <span className="font-semibold">{needsNothing ? "Equipment:" : "You'll need:"}</span>{" "}
                <span className="text-muted">
                  {needsNothing
                    ? `none required${gear.length > 0 ? ` — ${gear.join(", ")} can help` : ""}`
                    : gear.join(", ")}
                </span>
              </p>
            )}

            {/* A clinic typed this URL: only ever link a web address. */}
            {ex.video_url && /^https?:\/\//i.test(ex.video_url) && (
              <p className="mt-3 text-sm">
                <a
                  href={ex.video_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent-deep underline"
                >
                  Watch a video
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
