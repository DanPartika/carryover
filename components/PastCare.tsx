"use client";

// The patient's own history: courses of care that have wrapped up, each with
// the summary their PT wrote when closing it.
//
// What's shown is an allowlist (lib/episodes/shape.ts) — the summary, plain
// counts, the PT's shared messages. Deliberately no adherence percentage (a
// score is a verdict when it's your own record) and no pain figure (the slider
// starts at 0, so the number isn't reliable enough to hand someone as fact).
//
// The same card renders in the PT's confirmation step, fed the same shape, so
// the PT presses Close looking at exactly what the patient will read.

import { useState } from "react";
import { fmtDay, fmtSpan } from "@/components/ClosingNumbers";
import type { PatientPastEpisode } from "@/lib/episodes/shape";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function PastCareBody({ e }: { e: PatientPastEpisode }) {
  const s = e.stats;
  // A count of zero is "nothing happened", not information worth a line — and
  // "0 sessions" on a care episode that never started reads like an accusation.
  const goals = (s?.goals ?? []).filter((g) => g.current !== null);
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          {e.closedByName ? `Summary from ${e.closedByName}` : "Summary from your PT"}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{e.summary}</p>
        <p className="mt-1 text-xs text-muted">Care ended {fmtDay(e.endedOn)}</p>
      </div>

      {s && (
        <dl className="space-y-1 text-sm">
          <Stat label="Time in care">{s.daysInCare} days</Stat>
          {s.sessionsLogged > 0 && (
            <Stat label="Home sessions you logged">
              {s.sessionsLogged} on {s.daysLogged} day{s.daysLogged === 1 ? "" : "s"}
            </Stat>
          )}
          {s.visits > 0 && <Stat label="Office visits">{s.visits}</Stat>}
          {goals.length > 0 && (
            <Stat label="Goals you rated (0 = can't, 10 = no problem)">
              {goals.map((g) => (
                <span key={g.activity} className="block">
                  {g.activity}: {g.baseline} → {g.current}
                </span>
              ))}
            </Stat>
          )}
        </dl>
      )}

      {e.finalPlan && e.finalPlan.items.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Your program when care ended
            <span className="font-normal normal-case"> · for reference, not current</span>
          </p>
          <ul className="mt-1 space-y-1">
            {e.finalPlan.items.map((i, idx) => (
              <li
                key={`${i.name}-${idx}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
              >
                <span className="font-medium">{i.name}</span>
                <span className="text-xs text-muted">{i.line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {e.messages.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
            Messages your PT shared · {e.messages.length}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {e.messages.map((m, i) => (
              <li key={i} className="rounded-lg bg-raise/60 px-3 py-2 text-sm">
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-0.5 text-xs text-muted">{fmtDay(m.on)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function PastCareCard({
  e,
  defaultOpen,
}: {
  e: PatientPastEpisode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="rounded-lg border border-edge">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold">
          <span className="mr-1.5 inline-block w-3 text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          {e.condition}
        </span>
        <span className="text-xs text-muted">{fmtSpan(e.openedOn, e.endedOn)}</span>
      </button>
      {open && (
        <div className="border-t border-edge px-4 py-4">
          <PastCareBody e={e} />
        </div>
      )}
    </li>
  );
}

export default function PastCare({
  episodes,
  openNewest,
}: {
  episodes: PatientPastEpisode[];
  /** No current plan: the last episode's summary is the most useful thing on
   *  screen, so it starts open. With a plan underway it starts folded. */
  openNewest: boolean;
}) {
  if (episodes.length === 0) return null;
  return (
    <section className="rounded-xl border border-edge bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your history</h2>
      <p className="mt-0.5 text-xs text-muted">
        Past courses of care with your PT, and the summary they wrote when each one wrapped up.
      </p>
      <ul className="mt-3 space-y-2">
        {episodes.map((e, i) => (
          <PastCareCard key={e.id} e={e} defaultOpen={openNewest && i === 0} />
        ))}
      </ul>
    </section>
  );
}
