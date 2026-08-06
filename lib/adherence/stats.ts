// Adherence statistics (PRD build step 5, the PT dashboard). Pure functions,
// no DB and no clock — every date arrives as a 'yyyy-mm-dd' string resolved
// from Postgres, so the numbers a PT reads can't drift with the browser's
// timezone. Unit-tested; the SQL that feeds this lives in the route.
//
// Two rules the math has to respect or the dashboard lies:
//   1. Only HOME work is scored. Office items are done in clinic and are
//      recorded by the visit flow (build step 6) — counting them here would
//      punish a patient for something they were never asked to do at home.
//   2. The window is clamped to the plan's approval date. A plan approved
//      three days ago scored over 28 days would read as ~10% compliance.

export type StatItem = {
  id: string;
  /** The exercise behind the plan item. Carried through to ItemCompliance so
   *  the dashboard can open this exercise's whole history — logs from before
   *  the last plan revision point at a RETIRED plan item, so following the
   *  plan item id would silently truncate the record at the last check-in. */
  exerciseId: string;
  name: string;
  frequencyPerWeek: number;
  location: "office" | "home" | "both";
};

export type StatLog = {
  planItemId: string;
  logDate: string; // yyyy-mm-dd
  completed: boolean;
  pain: number | null;
};

export type ItemCompliance = {
  id: string;
  exerciseId: string;
  name: string;
  frequencyPerWeek: number;
  expected: number;
  completed: number;
  lastDone: string | null;
};

export type Compliance = {
  /** false when the window is too young to expect even one session — the UI
   *  shows "too early to score" instead of an unearned 0%. */
  scorable: boolean;
  expected: number;
  completed: number;
  percent: number | null;
  items: ItemCompliance[];
};

export type PainPoint = { date: string; avgPain: number };

export type PainTrend = {
  points: PainPoint[];
  /** null until there are enough distinct days to say anything honest. */
  start: number | null;
  end: number | null;
  direction: "down" | "up" | "flat" | null;
};

const DAY_MS = 86_400_000;

/** Days between two 'yyyy-mm-dd' strings. Parsed as UTC midnight (what the
 *  date-only form means to `new Date`), so DST and local offsets can't shift
 *  a boundary by a day. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** The scoring window: `requested` days back from today, but never reaching
 *  before the plan was approved. Inclusive of both ends, so a plan approved
 *  today gives a window of 1 day, never 0. */
export function effectiveWindowDays(
  requested: number,
  planApprovedOn: string,
  today: string,
): number {
  const sincePlan = daysBetween(planApprovedOn, today) + 1;
  return Math.max(1, Math.min(requested, sincePlan));
}

export function windowStart(days: number, today: string): string {
  return new Date(Date.parse(today) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

function isHome(it: StatItem): boolean {
  return it.location === "home" || it.location === "both";
}

/** Expected sessions for one item over the window, prorated from its weekly
 *  frequency. Rounded once, here, so the percentage always agrees with the
 *  "N of M" the PT reads next to it. */
function expectedFor(frequencyPerWeek: number, days: number): number {
  return Math.round((frequencyPerWeek * days) / 7);
}

export function computeCompliance(
  items: StatItem[],
  logs: StatLog[],
  windowDays: number,
): Compliance {
  const home = items.filter(isHome);
  const byItem = new Map<string, StatLog[]>();
  for (const l of logs) {
    if (!l.completed) continue;
    const list = byItem.get(l.planItemId);
    if (list) list.push(l);
    else byItem.set(l.planItemId, [l]);
  }

  const rows: ItemCompliance[] = home.map((it) => {
    const done = byItem.get(it.id) ?? [];
    // One session per calendar day per item — the adherence_logs UNIQUE
    // constraint already enforces this, but the math shouldn't depend on it.
    const days = new Set(done.map((l) => l.logDate));
    const lastDone = days.size ? [...days].sort().at(-1)! : null;
    return {
      id: it.id,
      exerciseId: it.exerciseId,
      name: it.name,
      frequencyPerWeek: it.frequencyPerWeek,
      expected: expectedFor(it.frequencyPerWeek, windowDays),
      completed: days.size,
      lastDone,
    };
  });

  const expected = rows.reduce((n, r) => n + r.expected, 0);
  const completed = rows.reduce((n, r) => n + r.completed, 0);
  return {
    scorable: expected > 0,
    expected,
    completed,
    percent: expected > 0 ? Math.round((completed / expected) * 100) : null,
    items: rows.sort((a, b) => a.completed / (a.expected || 1) - b.completed / (b.expected || 1)),
  };
}

/** Daily mean pain, oldest first. Days without a pain number are absent
 *  rather than zero — a missing score is not a painless day. */
export function computePainTrend(logs: StatLog[]): PainTrend {
  const byDate = new Map<string, number[]>();
  for (const l of logs) {
    if (l.pain === null || l.pain === undefined) continue;
    const list = byDate.get(l.logDate);
    if (list) list.push(l.pain);
    else byDate.set(l.logDate, [l.pain]);
  }
  const points: PainPoint[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date,
      avgPain: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
    }));

  // Halves, not first-vs-last day: a single bad morning shouldn't read as a
  // trend. Four days is the floor for saying anything at all.
  if (points.length < 4) {
    return { points, start: null, end: null, direction: null };
  }
  const half = Math.floor(points.length / 2);
  const mean = (arr: PainPoint[]) =>
    Math.round((arr.reduce((s, p) => s + p.avgPain, 0) / arr.length) * 10) / 10;
  const start = mean(points.slice(0, half));
  const end = mean(points.slice(-half));
  const delta = end - start;
  return {
    points,
    start,
    end,
    direction: Math.abs(delta) < 0.5 ? "flat" : delta < 0 ? "down" : "up",
  };
}
