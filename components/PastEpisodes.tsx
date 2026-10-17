"use client";

// The PT's view of a patient's finished episodes of care.
//
// Built to answer one question fast — "what did we do last time, and how did it
// end?" — so a folded card already shows the opening of the summary the PT
// signed, and an open one reads: summary, how the plan ended, the numbers frozen
// when it closed. The deeper record (intake, check-in decisions, the
// session-by-session log, notes) sits one tab further in and loads only when
// asked for; none of it is editable.
//
// The newest episode, while nothing newer is open and the window hasn't passed,
// also carries the undo for a mis-tap: Reopen.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import ClosingNumbers, { fmtDay, fmtSpan } from "@/components/ClosingNumbers";
import IntakeSummary from "@/components/IntakeSummary";
import NotesPanel from "@/components/NotesPanel";
import ReviewTimeline from "@/components/ReviewTimeline";
import SessionLog from "@/components/SessionLog";
import type { PastEpisode } from "@/lib/episodes/history";

type Tab = "intake" | "checkins" | "sessions" | "notes";

function PlanList({ title, plan }: { title: string; plan: NonNullable<PastEpisode["finalPlan"]> }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {title} <span className="font-normal normal-case">· approved {fmtDay(plan.approvedOn)}</span>
      </p>
      <ul className="mt-1 space-y-1">
        {plan.items.map((i, idx) => (
          <li
            key={`${i.name}-${idx}`}
            className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
          >
            <span className="font-medium">
              {i.name}
              {i.kind === "modality" && (
                <span className="ml-2 rounded-full bg-raise px-2 py-0.5 text-xs font-normal text-muted">
                  care
                </span>
              )}
            </span>
            <span className="text-xs text-muted">
              {i.line} · {i.location}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reopen({
  e,
  onReopened,
}: {
  e: PastEpisode;
  onReopened: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/episodes/${e.id}/reopen`, { method: "POST" });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `couldn't reopen (${res.status})`);
        setConfirming(false);
        return;
      }
      onReopened();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  const until = e.reopenableUntil
    ? new Date(e.reopenableUntil).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="rounded-lg border border-edge bg-raise/40 px-3 py-2 text-sm">
      {!confirming ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted">Closed by mistake? You can undo until {until}.</span>
          <button
            onClick={() => setConfirming(true)}
            className="rounded-full border border-edge px-3 py-1 text-xs hover:bg-raise"
          >
            Reopen…
          </button>
        </div>
      ) : (
        <div>
          <p>
            Reopening puts the plan back and removes the summary from the patient&apos;s
            history — but if they already opened the app, they may have read it. The closing
            is kept on file.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void reopen()}
              disabled={busy}
              className="rounded-lg bg-accent-deep px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Reopening…" : "Yes, reopen it"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs hover:bg-raise"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-flag">{error}</p>}
    </div>
  );
}

function EpisodeCard({
  e,
  patientId,
  clinicId,
  patientName,
  defaultOpen,
  onReopened,
}: {
  e: PastEpisode;
  patientId: string;
  clinicId: string;
  patientName: string;
  defaultOpen: boolean;
  onReopened: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<Tab | null>(null);

  const planUnchanged =
    !!e.startPlan && !!e.finalPlan && e.startPlan.approvedOn === e.finalPlan.approvedOn;

  const tabs: [Tab, string][] = [
    ["intake", "Intake"],
    ["checkins", "Check-ins"],
    ["sessions", "Sessions"],
    ["notes", "Notes"],
  ];

  return (
    <li className="rounded-lg border border-edge">
      <button
        onClick={() => setOpen(!open)}
        className="block w-full px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold">
            <span className="mr-1.5 inline-block w-3 text-muted" aria-hidden>
              {open ? "▾" : "▸"}
            </span>
            {e.condition}
          </span>
          <span className="text-xs text-muted">
            {fmtSpan(e.openedOn, e.endedOn)}
            {e.context ? ` · ${e.context.daysInCare} days` : ""}
          </span>
        </span>
        {/* The digest: folded, the card still says how it ended. */}
        {!open && <span className="mt-1 line-clamp-2 block text-sm text-muted">{e.summary}</span>}
      </button>

      {open && (
        <div className="space-y-4 border-t border-edge px-4 py-4">
          {e.reopenableUntil && <Reopen e={e} onReopened={onReopened} />}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Closing summary
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{e.summary}</p>
            <p className="mt-1 text-xs text-muted">
              Closed {fmtDay(e.closedOn)}
              {e.closedByName ? ` by ${e.closedByName}` : ""}
              {e.aiAssisted ? " · started from an AI draft, edited by the PT" : ""} ·{" "}
              {patientName.split(" ")[0]} can read this.
            </p>
          </div>

          {e.watchFor && (
            <p className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
              <span className="font-semibold">Watch for next time</span> (not shown to the
              patient; given to the next AI draft): {e.watchFor}
            </p>
          )}

          {planUnchanged && e.finalPlan ? (
            <PlanList title="The plan (unchanged throughout)" plan={e.finalPlan} />
          ) : (
            <>
              {e.finalPlan && <PlanList title="How it ended" plan={e.finalPlan} />}
              {e.startPlan && <PlanList title="How it started" plan={e.startPlan} />}
            </>
          )}
          {!e.startPlan && !e.finalPlan && (
            <p className="text-sm text-muted">No plan was ever approved in this episode.</p>
          )}

          {e.context && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                By the numbers
                <span className="font-normal normal-case"> · frozen when it closed</span>
              </p>
              <ClosingNumbers ctx={e.context} />
            </div>
          )}

          <div>
            <div className="flex flex-wrap gap-1.5">
              {tabs.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(tab === key ? null : key)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    tab === key
                      ? "border-accent-deep bg-accent-deep text-white"
                      : "border-edge text-muted hover:bg-raise"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab && (
              <div className="mt-3">
                {tab === "intake" &&
                  (e.intake ? (
                    <IntakeSummary intake={e.intake} birthYear={null} patientSubmitted={false} />
                  ) : (
                    <p className="text-sm text-muted">No intake was recorded.</p>
                  ))}
                {tab === "checkins" && (
                  <ReviewTimeline
                    patientId={patientId}
                    clinicId={clinicId}
                    refreshKey={0}
                    episodeId={e.id}
                    embedded
                  />
                )}
                {tab === "sessions" && (
                  <SessionLog
                    patientId={patientId}
                    clinicId={clinicId}
                    days={28}
                    episodeId={e.id}
                    focusExerciseId={null}
                    onClearFocus={() => {}}
                  />
                )}
                {tab === "notes" && (
                  <NotesPanel episodeId={e.id} patientName={patientName} readOnly />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export default function PastEpisodes({
  patientId,
  clinicId,
  patientName,
  /** Bump to refetch — the page increments it right after an episode closes. */
  refreshKey,
  /** No open episode: the history IS the page, so the newest one starts open. */
  openNewest,
  /** After a reopen the page must reload — an episode is open again. */
  onReopened,
}: {
  patientId: string;
  clinicId: string;
  patientName: string;
  refreshKey: number;
  openNewest: boolean;
  onReopened: () => void;
}) {
  const [episodes, setEpisodes] = useState<PastEpisode[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/patients/${patientId}/episodes?clinicId=${clinicId}`);
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setEpisodes(((await res.json()) as { episodes: PastEpisode[] }).episodes);
    } catch {
      setFailed(true);
    }
  }, [patientId, clinicId]);

  useEffect(() => {
    // setState runs inside load() after an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  // Never render nothing on a failed load: an empty history is
  // indistinguishable from a patient who has none, and that changes decisions.
  if (failed && !episodes) {
    return (
      <section className="rounded-xl border border-edge bg-card p-5 text-sm">
        <span className="text-flag">Couldn&apos;t load this patient&apos;s past episodes.</span>{" "}
        <button className="underline" onClick={() => void load()}>
          Retry
        </button>
      </section>
    );
  }
  if (!episodes || episodes.length === 0) return null;

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        Past episodes · {episodes.length}
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        Finished courses of care, newest first. Read-only — each one is the record as it stood
        when it closed.
      </p>
      <ul className="mt-3 space-y-2">
        {episodes.map((e, i) => (
          <EpisodeCard
            // Keyed on the id AND the open default so a refetch after closing
            // doesn't keep a stale open/closed state from the previous list.
            key={`${e.id}:${openNewest && i === 0}`}
            e={e}
            patientId={patientId}
            clinicId={clinicId}
            patientName={patientName}
            defaultOpen={openNewest && i === 0}
            onReopened={onReopened}
          />
        ))}
      </ul>
    </section>
  );
}
