"use client";

// The PT's adherence dashboard (PRD build step 5, "the sellable proof"):
// what the patient actually did at home since the plan was approved, how pain
// moved, what they flagged, and a one-tap AI read of all three.
//
// Desktop-first (PRD §3 responsive posture) but stacks cleanly on a phone —
// a PT checking a patient between visits is often not at a desk.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

type ItemCompliance = {
  id: string;
  name: string;
  frequencyPerWeek: number;
  expected: number;
  completed: number;
  lastDone: string | null;
};

type Flag = {
  date: string;
  exercise: string;
  pain: number | null;
  note: string | null;
  flagged: boolean;
};

type Summary = {
  id: string;
  body: string;
  windowDays: number;
  mode: string;
  model: string | null;
  createdAt: string;
  newLogsSince: number;
};

type Data = {
  episode: { id: string; condition: string } | null;
  windowChoices: number[];
  today: string;
  plan: { id: string; approvedOn: string } | null;
  windowDays: number;
  windowFrom: string;
  compliance: {
    scorable: boolean;
    expected: number;
    completed: number;
    percent: number | null;
    items: ItemCompliance[];
  };
  pain: {
    points: { date: string; avgPain: number }[];
    start: number | null;
    end: number | null;
    direction: "down" | "up" | "flat" | null;
  };
  flags: Flag[];
  adhoc: {
    date: string;
    name: string;
    durationMins: number | null;
    pain: number | null;
    note: string | null;
  }[];
  visits: { count: number; lastOn: string | null };
  summary: Summary | null;
};

const DAY_MS = 86_400_000;

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function relativeDays(iso: string, today: string): string {
  const n = Math.round((Date.parse(today) - Date.parse(iso)) / DAY_MS);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  return `${n} days ago`;
}

/** Pain over the window. Points are placed by DATE, not by index, so a
 *  four-day silence reads as a gap instead of a smooth line. */
function PainSparkline({ data }: { data: Data }) {
  const { points } = data.pain;
  const W = 260;
  const H = 44;
  // max(1, …) keeps a single-day window from dividing by zero; its one point
  // then sits at x=0, the left edge, which is where that day actually is.
  const span = Math.max(
    1,
    Math.round((Date.parse(data.today) - Date.parse(data.windowFrom)) / DAY_MS),
  );
  const x = (iso: string) => ((Date.parse(iso) - Date.parse(data.windowFrom)) / DAY_MS / span) * W;
  const y = (pain: number) => H - (pain / 10) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-11 w-full" preserveAspectRatio="none" aria-hidden>
      {[0, 5, 10].map((p) => (
        <line
          key={p}
          x1={0}
          x2={W}
          y1={y(p)}
          y2={y(p)}
          stroke="var(--color-edge)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {points.length > 1 && (
        <polyline
          points={points.map((p) => `${x(p.date)},${y(p.avgPain)}`).join(" ")}
          fill="none"
          stroke="var(--color-flag)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points.map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.avgPain)} r={2.5} fill="var(--color-flag)" />
      ))}
    </svg>
  );
}

export default function AdherencePanel({
  patientId,
  clinicId,
  patientName,
}: {
  patientId: string;
  clinicId: string;
  patientName: string;
}) {
  const [days, setDays] = useState(28);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/patients/${patientId}/adherence?clinicId=${clinicId}&days=${days}`,
      );
      if (!res.ok) {
        setError(`adherence load failed (${res.status})`);
        return;
      }
      setError(null);
      setData((await res.json()) as Data);
    } catch {
      setError("network error loading adherence");
    }
  }, [patientId, clinicId, days]);

  useEffect(() => {
    // setState lives inside load() past an await, not in the effect body — the
    // compiler lint can't see through the useCallback boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function summarize() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/patients/${patientId}/summary?clinicId=${clinicId}&days=${days}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `summary failed (${res.status})`);
        return;
      }
      const d = (await res.json()) as { summary: Summary };
      setData((prev) => (prev ? { ...prev, summary: d.summary } : prev));
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <section className="rounded-xl border border-edge bg-card p-5">
        <p className="text-sm text-muted">{error ?? "Loading adherence…"}</p>
      </section>
    );
  }

  const { compliance: c, pain } = data;
  const firstName = patientName.split(" ")[0];

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Home adherence</h2>
        <div className="flex gap-1 rounded-lg bg-raise p-0.5 text-xs">
          {data.windowChoices.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 font-medium ${
                days === d ? "bg-card shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}

      {!data.plan ? (
        <p className="mt-3 text-sm text-muted">
          No active plan yet — approve one and {firstName}&apos;s logging starts here.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {/* Compliance */}
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {c.scorable ? (
                <>
                  <span className="text-3xl font-extrabold tracking-tight">{c.percent}%</span>
                  <span className="text-sm text-muted">
                    {c.completed} of {c.expected} expected home sessions
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted">
                  Too early to score — the plan has been active{" "}
                  {data.windowDays === 1 ? "less than a day" : `${data.windowDays} days`}.
                </span>
              )}
            </div>
            {c.scorable && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-raise">
                <div
                  className="h-full rounded-full bg-accent-deep"
                  style={{ width: `${Math.min(100, c.percent ?? 0)}%` }}
                />
              </div>
            )}
            <p className="mt-1.5 text-xs text-muted">
              {data.windowDays < days
                ? `Since the plan was approved on ${shortDate(data.windowFrom)} — ${data.windowDays} day${data.windowDays === 1 ? "" : "s"}, not the full ${days}.`
                : `Last ${days} days, since ${shortDate(data.windowFrom)}.`}{" "}
              Home work only.{" "}
              {data.visits.count > 0
                ? `${data.visits.count} in-office visit${data.visits.count === 1 ? "" : "s"} in the same window, last on ${shortDate(data.visits.lastOn!)} — office work is counted there.`
                : "No in-office visits recorded in this window."}
            </p>
          </div>

          {/* Per exercise, worst first */}
          {c.items.length > 0 && (
            <ul className="space-y-1.5">
              {c.items.map((it) => {
                const pct = it.expected > 0 ? Math.min(100, (it.completed / it.expected) * 100) : 0;
                const cold = it.expected > 0 && it.completed < it.expected * 0.6;
                return (
                  <li key={it.id} className="flex items-center gap-3 text-sm">
                    <span className="w-40 shrink-0 truncate" title={it.name}>
                      {it.name}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raise">
                      <span
                        className={`block h-full rounded-full ${cold ? "bg-flag" : "bg-accent"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">
                      {it.completed}/{it.expected}
                    </span>
                    <span className="hidden w-24 shrink-0 text-right text-xs text-muted sm:block">
                      {it.lastDone ? relativeDays(it.lastDone, data.today) : "never"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pain */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Pain during exercise
              </h3>
              {pain.direction ? (
                <span className="text-sm font-medium">
                  {pain.start} → {pain.end}{" "}
                  <span
                    className={
                      pain.direction === "down"
                        ? "text-accent-deep"
                        : pain.direction === "up"
                          ? "text-flag"
                          : "text-muted"
                    }
                  >
                    {pain.direction === "down" ? "↓" : pain.direction === "up" ? "↑" : "→"}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted">
                  {pain.points.length
                    ? `${pain.points.length} day${pain.points.length === 1 ? "" : "s"} scored — too few for a trend`
                    : "no scores yet"}
                </span>
              )}
            </div>
            {pain.points.length > 0 && (
              <>
                <PainSparkline data={data} />
                <div className="flex justify-between text-[11px] text-muted">
                  <span>{shortDate(data.windowFrom)}</span>
                  <span>0–10 scale</span>
                  <span>{shortDate(data.today)}</span>
                </div>
              </>
            )}
          </div>

          {/* Flags + notes */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Flags &amp; notes
            </h3>
            {data.flags.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Nothing flagged in this window.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {data.flags.map((f, i) => (
                  <li
                    key={`${f.date}-${f.exercise}-${i}`}
                    className={`rounded-lg px-3 py-2 text-sm ${
                      f.flagged ? "bg-flag/10 border border-flag/30" : "bg-raise/60"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      {f.flagged && <span className="font-semibold text-flag">⚑ flagged</span>}
                      <span>{shortDate(f.date)}</span>
                      <span className="font-medium text-ink">{f.exercise}</span>
                      {f.pain !== null && <span>pain {f.pain}/10</span>}
                    </div>
                    {f.note && <p className="mt-0.5">{f.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Self-directed care. Kept visually apart from the compliance bar
              because it is deliberately NOT in that number — "skipped the
              strengthening but iced four times" is a different story from
              "did nothing", and the percentage can't tell them apart. */}
          {data.adhoc.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Also did on their own
              </h3>
              <p className="mt-0.5 text-xs text-muted">Not prescribed — not in the score above.</p>
              <ul className="mt-2 space-y-1">
                {data.adhoc.map((a, i) => (
                  <li
                    key={`${a.date}-${a.name}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-x-2 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
                  >
                    <span>
                      {a.name}
                      {a.note && <span className="ml-2 text-xs text-muted">{a.note}</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {shortDate(a.date)}
                      {a.durationMins ? ` · ${a.durationMins} min` : ""}
                      {a.pain !== null ? ` · pain ${a.pain}/10` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* AI summary */}
          <div className="border-t border-edge pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                AI summary
              </h3>
              <button
                onClick={() => void summarize()}
                disabled={busy}
                className="rounded-full border border-edge px-3 py-1 text-sm font-medium hover:bg-raise disabled:opacity-40"
              >
                {busy ? "Reading logs…" : data.summary ? "Regenerate" : "✨ Summarize for me"}
              </button>
            </div>
            {data.summary ? (
              <div className="mt-2">
                <p className="text-sm">{data.summary.body}</p>
                <p className="mt-1.5 text-xs text-muted">
                  {new Date(data.summary.createdAt).toLocaleString()} ·{" "}
                  {data.summary.windowDays}-day window ·{" "}
                  {data.summary.mode === "fixture"
                    ? "offline fixture"
                    : (data.summary.model ?? "ai")}
                </p>
                {data.summary.newLogsSince > 0 && (
                  <p className="mt-1 text-xs font-medium text-flag">
                    {data.summary.newLogsSince} log
                    {data.summary.newLogsSince === 1 ? "" : "s"} since this was written — regenerate
                    before you rely on it.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted">
                One paragraph over the logs above, for your eyes only — never shown to{" "}
                {firstName}.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
