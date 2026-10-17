"use client";

// Closing an episode of care: the PT writes a summary — with the AI's draft as a
// starting point if they want one — and pressing Close is the approval.
//
// The shape is a short ramp, not a form dropped on the page:
//   quiet card -> checklist + "when did care end" + the numbers -> write
//   (optionally draft) -> review EXACTLY what the patient will see -> close.
//
// Three things the flow is built around, each from a way this goes wrong on a
// phone at the end of a day:
//   * The AI is optional and never in the way. The checklist and numbers come
//     from a no-AI call; "Draft with AI" only fills the textarea, and a failure
//     leaves the PT with a plain template, not a dead end.
//   * The close is permanent to the patient, so the last step renders the very
//     card they will read (summary + counts + plan) — not the PT-shaped numbers.
//   * A draft the PT never read can't be published: closing from an AI draft
//     needs a touch of the text first.
//
// The AI's draft states only what the record shows. The hint says so — the PT's
// own read (where things stand, what to watch) is what makes it a clinical
// summary, and it has to be theirs.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import ClosingNumbers, { fmtDay } from "@/components/ClosingNumbers";
import { PastCareBody } from "@/components/PastCare";
import type { ClosingContext, ClosingPreview, PlanSnapshot } from "@/lib/episodes/closing";
import { patientPlan, patientStats, type PatientPastEpisode } from "@/lib/episodes/shape";

type Step = "closed" | "edit" | "review" | "closing";

type Loaded = {
  preview: ClosingPreview;
  endedOn: string;
  context: ClosingContext | null;
  finalPlan: PlanSnapshot | null;
};

const WATCH_FOR_MAX = 240;
const storageKey = (id: string) => `carryover:closing:${id}`;

type Saved = { summary: string; watchFor: string; usedDraft: boolean };

function readSaved(id: string): Saved | null {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function writeSaved(id: string, v: Saved | null) {
  try {
    if (v) window.localStorage.setItem(storageKey(id), JSON.stringify(v));
    else window.localStorage.removeItem(storageKey(id));
  } catch {
    // Storage can be blocked or full; the form works without it.
  }
}

export default function CloseEpisode({
  episodeId,
  patientName,
  onClosed,
}: {
  episodeId: string;
  patientName: string;
  onClosed: () => void;
}) {
  const first = patientName.split(" ")[0];
  const [step, setStep] = useState<Step>("closed");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endedOn, setEndedOn] = useState("");
  const [summary, setSummary] = useState("");
  const [watchFor, setWatchFor] = useState("");
  const [usedDraft, setUsedDraft] = useState(false);
  // Has the PT read/edited the text since an AI draft landed? Gates closing.
  const [touched, setTouched] = useState(true);
  // The last AI text we put in the box, so a redraft can tell whether the PT
  // has edited it since and ask before overwriting their words.
  const [lastDraft, setLastDraft] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest preview request may land: changing the date twice quickly
  // must not let the first (slower) response overwrite the second's numbers.
  const latestPreview = useRef(0);

  const loadPreview = useCallback(
    async (asOf?: string) => {
      const mine = ++latestPreview.current;
      setLoadError(null);
      try {
        const res = await apiFetch(
          `/api/episodes/${episodeId}/closing-preview${asOf ? `?endedOn=${asOf}` : ""}`,
        );
        const d = (await res.json().catch(() => null)) as
          | (Loaded & { error?: string })
          | { error?: string }
          | null;
        if (mine !== latestPreview.current) return;
        if (!res.ok || !d || !("preview" in d)) {
          setLoadError((d as { error?: string } | null)?.error ?? `couldn't load (${res.status})`);
          return;
        }
        setLoaded(d);
        setEndedOn(d.endedOn);
      } catch {
        if (mine === latestPreview.current) setLoadError("network error — try again");
      }
    },
    [episodeId],
  );

  // The text survives a tab discarded behind another app (iOS does this) and a
  // reload; it is cleared only by closing.
  useEffect(() => {
    if (step === "closed") return;
    writeSaved(episodeId, { summary, watchFor, usedDraft });
  }, [step, episodeId, summary, watchFor, usedDraft]);

  function begin() {
    const saved = readSaved(episodeId);
    if (saved) {
      setSummary(saved.summary);
      setWatchFor(saved.watchFor);
      setUsedDraft(saved.usedDraft);
      setLastDraft("");
    }
    setError(null);
    setStep("edit");
    void loadPreview();
  }

  async function draft() {
    const edited = summary.trim() !== "" && summary !== lastDraft;
    if (edited && !window.confirm("Replace what you've written with a fresh AI draft?")) return;
    setError(null);
    setDraftNote(null);
    setDrafting(true);
    try {
      const res = await apiFetch(`/api/episodes/${episodeId}/closing-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endedOn }),
      });
      const d = (await res.json().catch(() => null)) as {
        draft?: string;
        mode?: string;
        fellBack?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !d?.draft) {
        // Whatever the PT had in the box stays put, and they can still write.
        setError(d?.error ?? `couldn't draft (${res.status}) — you can write it yourself`);
        return;
      }
      setSummary(d.draft);
      setLastDraft(d.draft);
      const real = d.mode === "lithe" && !d.fellBack;
      setUsedDraft(real);
      setTouched(!real);
      setDraftNote(
        d.fellBack
          ? "The AI wasn't available, so this is a plain template — edit it or write your own."
          : d.mode === "lithe"
            ? null
            : "Offline template (AI is in fixture mode here).",
      );
    } catch {
      setError("network error — you can write it yourself");
    } finally {
      setDrafting(false);
    }
  }

  async function endVisit(id: string) {
    setBusy(true);
    try {
      await apiFetch(`/api/visits/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ end: true }),
      });
      await loadPreview(endedOn || undefined);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!loaded?.context) return;
    setError(null);
    setBusy(true);
    setStep("closing");
    const c = loaded.context;
    try {
      const res = await apiFetch(`/api/episodes/${episodeId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary,
          watchFor,
          endedOn,
          aiAssisted: usedDraft,
          basis: {
            planVersions: c.planVersions,
            checkIns: c.checkIns,
            sessionsLogged: c.sessions.sessionsLogged,
            visits: c.visits.count,
          },
        }),
      });
      const d = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
        context?: ClosingContext;
      } | null;
      if (res.ok) {
        writeSaved(episodeId, null);
        onClosed();
        return;
      }
      if (d?.code === "episode_closed") {
        // Closed elsewhere: the page's own listener reloads; nothing to add.
        onClosed();
        return;
      }
      if (d?.code === "stale_basis" && d.context) {
        // The record moved under the PT's draft. Show the fresh numbers and send
        // them back to read it again — they signed a summary of the OLD record.
        setLoaded((prev) => (prev ? { ...prev, context: d.context ?? prev.context } : prev));
      }
      setError(d?.error ?? `couldn't close (${res.status})`);
      setStep("edit");
      void loadPreview(endedOn || undefined);
    } catch {
      setError("network error — nothing was closed; try again");
      setStep("edit");
    } finally {
      setBusy(false);
    }
  }

  if (step === "closed") {
    return (
      <section className="rounded-xl border border-edge bg-card px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">
            Care for this problem finished? Close the episode with a short summary — {first}{" "}
            can read it, and next time it starts fresh.
          </p>
          <button
            onClick={begin}
            className="rounded-full border border-edge px-3 py-1 text-sm text-muted hover:bg-raise"
          >
            Close this episode…
          </button>
        </div>
      </section>
    );
  }

  const preview = loaded?.preview ?? null;
  const ctx = loaded?.context ?? null;
  const blocked = !!preview?.openVisit;
  const needsRead = usedDraft && !touched;
  const canReview = !!ctx && !!summary.trim() && !blocked && !needsRead && !busy && !drafting;
  const quiet =
    preview && preview.suggestedEndedOn !== preview.today && preview.lastActivityOn
      ? preview.lastActivityOn
      : null;

  const view: PatientPastEpisode | null =
    ctx && preview
      ? {
          id: "preview",
          condition: preview.condition,
          openedOn: ctx.openedOn,
          endedOn: ctx.endedOn,
          closedByName: null,
          recent: true,
          summary: summary.trim(),
          stats: patientStats(ctx),
          finalPlan: loaded?.finalPlan ? patientPlan(loaded.finalPlan) : null,
          messages: [],
        }
      : null;

  if (step === "review" || step === "closing") {
    return (
      <section className="rounded-xl border border-accent bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          What {first} will see
        </h2>
        {view && (
          <div className="mt-3 rounded-lg border border-edge p-4">
            <PastCareBody e={view} />
          </div>
        )}
        {watchFor.trim() && (
          <p className="mt-3 rounded-lg bg-raise/60 px-3 py-2 text-xs">
            <span className="font-semibold">Kept for {first}&apos;s next episode</span> (only
            you and the next AI draft see this — not {first}): {watchFor.trim()}
          </p>
        )}
        {error && <p className="mt-2 text-sm text-flag">{error}</p>}
        <div className="mt-3 rounded-lg border border-flag/40 bg-flag/5 p-3">
          <p className="text-sm">
            This ends {first}&apos;s plan and removes it from their Today screen, and the
            episode becomes read-only. <span className="font-medium">Nothing is sent to {first}</span>{" "}
            — they&apos;ll see this the next time they open the app, so you may want to tell
            them. You can undo this for 72 hours; after that it&apos;s permanent.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-lg border border-flag px-4 py-2 text-sm font-semibold text-flag hover:bg-flag/10 disabled:opacity-40"
            >
              {step === "closing" ? "Closing…" : `Close ${first}'s episode and share the summary`}
            </button>
            <button
              onClick={() => {
                setStep("edit");
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg border border-edge px-3 py-2 text-sm hover:bg-raise disabled:opacity-40"
            >
              Back to editing
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-accent bg-card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        Close this episode
      </h2>

      {loadError && (
        <p className="mt-2 text-sm text-flag">
          {loadError}{" "}
          <button className="underline" onClick={() => void loadPreview(endedOn || undefined)}>
            retry
          </button>
        </p>
      )}
      {!loaded && !loadError && (
        <p className="mt-2 text-sm text-muted">Checking the record…</p>
      )}

      {preview && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {preview.openVisit && (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-flag/40 bg-flag/5 px-3 py-2">
              <span>
                A visit started {fmtDay(preview.openVisit.startedOn)} is still open — it has to
                end before the episode can close.
              </span>
              <button
                onClick={() => void endVisit(preview.openVisit!.id)}
                disabled={busy}
                className="rounded-lg border border-flag px-3 py-1 text-xs font-semibold text-flag hover:bg-flag/10 disabled:opacity-40"
              >
                End visit
              </button>
            </li>
          )}
          {preview.raisedHand && (
            <li className="rounded-lg bg-raise/60 px-3 py-2">
              {first} raised a hand on {fmtDay(preview.raisedHand.on)}
              {preview.raisedHand.note ? `: “${preview.raisedHand.note}”` : ""}. Closing
              doesn&apos;t answer it — read it first.
            </li>
          )}
          {preview.draftPlan && (
            <li className="rounded-lg bg-raise/60 px-3 py-2 text-muted">
              There&apos;s an unapproved draft plan. It stays with this episode, unused.
            </li>
          )}
          {!preview.hasApprovedPlan && (
            <li className="rounded-lg bg-raise/60 px-3 py-2 text-muted">
              No plan was ever approved in this episode.
            </li>
          )}
        </ul>
      )}

      {preview && (
        <div className="mt-3">
          <label className="text-sm font-medium" htmlFor="care-ended">
            Care ended
          </label>{" "}
          <input
            id="care-ended"
            type="date"
            value={endedOn}
            min={preview.startedOn}
            max={preview.today}
            onChange={(e) => {
              const v = e.target.value;
              setEndedOn(v);
              if (v) void loadPreview(v);
            }}
            className="rounded-md border border-edge bg-card px-2 py-1 text-sm"
          />
          {quiet && (
            <p className="mt-1 text-xs text-muted">
              {first}&apos;s last activity here was {fmtDay(quiet)}, so that&apos;s where this
              starts — closing as of today would count the weeks they were gone.
            </p>
          )}
        </div>
      )}

      {ctx && (
        <details className="mt-3 rounded-lg bg-raise/60 px-3 py-2" open>
          <summary className="cursor-pointer text-xs font-semibold text-muted">
            The numbers this will be filed with
          </summary>
          <div className="mt-2">
            <ClosingNumbers ctx={ctx} />
          </div>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-medium" htmlFor="closing-summary">
          Summary for the record — {first} will read this
        </label>
        <button
          onClick={() => void draft()}
          disabled={drafting || busy || !loaded}
          className="rounded-lg border border-edge px-3 py-1 text-xs font-medium text-muted hover:bg-raise disabled:opacity-40"
        >
          {drafting ? "Drafting…" : "✨ Draft with AI"}
        </button>
      </div>
      <textarea
        id="closing-summary"
        value={summary}
        onChange={(e) => {
          setSummary(e.target.value);
          setTouched(true);
        }}
        onFocus={() => setTouched(true)}
        rows={9}
        disabled={busy}
        placeholder="What this episode of care was for, what was done, and where things stand now. A line is fine."
        className="mt-1 w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <p className="mt-1 text-xs text-muted">
        {usedDraft
          ? "The draft only covers what the record shows — it doesn't know how things stand now. Add your own read: where they are, what to watch for. "
          : "Cover what this episode was for, what was done, and where things stand now. "}
        Nothing is shared until you close.
      </p>
      {draftNote && <p className="mt-1 text-xs text-muted">{draftNote}</p>}
      {needsRead && (
        <p className="mt-1 text-xs text-flag">
          Read the draft through (tap into it to edit) before you continue — it reaches {first}{" "}
          as written.
        </p>
      )}

      <label className="mt-3 block text-sm font-medium" htmlFor="watch-for">
        Watch for next time <span className="font-normal text-muted">(optional)</span>
      </label>
      <input
        id="watch-for"
        value={watchFor}
        maxLength={WATCH_FOR_MAX}
        onChange={(e) => setWatchFor(e.target.value)}
        disabled={busy}
        placeholder="e.g. pain with deep squats; no kneeling on hard floors"
        className="mt-1 w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <p className="mt-1 text-xs text-muted">
        {`Only for ${first}'s next episode, if there is one: a movement that hurt, a precaution, equipment that didn't work. ${first} doesn't see it; the next AI draft does, and may only use it to be `}
        <em>more</em>
        {" careful. Leave it empty if there's nothing — the story of how this round went is deliberately not passed on."}
      </p>

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
        <button
          onClick={() => setStep("review")}
          disabled={!canReview}
          className="rounded-lg bg-accent-deep px-5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Review what {first} will see
        </button>
        <button
          onClick={() => {
            setStep("closed");
            setError(null);
          }}
          disabled={busy}
          className="ml-auto rounded-lg px-3 py-2 text-sm text-muted hover:text-ink"
          title="Your text is kept until you close"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
