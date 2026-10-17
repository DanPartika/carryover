"use client";

// The measurements an episode closed with — shown beside the summary while the
// PT is writing it, and again on the history card. Plain numbers, one per line,
// no colour and no adjectives: whether 41 of 60 sessions was enough is the
// summary's job, and the PT's.
//
// Each label says what the number actually measures, because two of them are
// easy to over-read: the adherence figure covers only the FINAL plan's exercises
// (one swapped out along the way counts for nothing), and pain is a mean of the
// first vs the second half of the days a score was logged — with a slider that
// starts at 0, so a session saved untouched logs "no pain".

import type { ClosingContext } from "@/lib/episodes/closing";

export function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function fmtSpan(openedOn: string, endedOn: string): string {
  return `${fmtDay(openedOn)} – ${fmtDay(endedOn)}`;
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export default function ClosingNumbers({ ctx }: { ctx: ClosingContext }) {
  const a = ctx.adherence;
  const s = ctx.sessions;
  return (
    <div>
      <dl className="space-y-1 text-sm">
        <Line label="Care">
          {fmtSpan(ctx.openedOn, ctx.endedOn)} · {ctx.daysInCare} day
          {ctx.daysInCare === 1 ? "" : "s"}
        </Line>
        <Line label="Prescribed home sessions logged">
          {s.sessionsLogged} on {s.daysLogged} day{s.daysLogged === 1 ? "" : "s"}
        </Line>
        {s.selfDirected > 0 && (
          <Line label="Self-directed care (not tied to the plan)">{s.selfDirected}</Line>
        )}
        <Line label="vs. the final plan's exercises only">
          {a.scorable
            ? `${a.completed} of ${a.expected} expected${a.percent !== null ? ` (${a.percent}%)` : ""}`
            : ctx.planVersions === 0
              ? "no plan was approved"
              : "too early to score"}
        </Line>
        <Line label="In-office visits">
          {ctx.visits.count === 0
            ? "none recorded"
            : `${ctx.visits.count}${ctx.visits.lastOn ? ` · last ${fmtDay(ctx.visits.lastOn)}` : ""}`}
        </Line>
        <Line label="Pain scores (0–10), 1st half → 2nd half of days scored">
          {ctx.pain.start !== null && ctx.pain.end !== null
            ? `${ctx.pain.start} → ${ctx.pain.end} · ${ctx.pain.daysScored} days`
            : ctx.pain.daysScored > 0
              ? `${ctx.pain.daysScored} days scored — too few to compare`
              : "none logged"}
        </Line>
        {ctx.goals && ctx.goals.length > 0 && (
          <Line label="Goals, rated by the patient (0 = can't, 10 = no problem)">
            <span className="block">
              {ctx.goals.map((g) => (
                <span key={g.activity} className="block">
                  {g.activity}: {g.baseline}
                  {g.current !== null ? ` → ${g.current}` : " (not re-rated)"}
                </span>
              ))}
            </span>
          </Line>
        )}
        <Line label="Plan versions · check-ins">
          {ctx.planVersions} · {ctx.checkIns}
        </Line>
        {s.flagged > 0 && <Line label="Sessions flagged for the PT">{s.flagged}</Line>}
      </dl>
      <p className="mt-2 text-xs text-muted">
        Pain is as reliable as the slider: a session saved without moving it counts as 0.
        {" "}It isn&apos;t shown to the patient or given to the AI.
      </p>
    </div>
  );
}
