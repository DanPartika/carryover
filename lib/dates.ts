// The app's "day".
//
// Logs, streaks, windows, and every "today" the UI shows bucket by calendar
// day — and the calendar that matters is the clinic's, not the server's. The
// containers run UTC, where the date flips at 8pm Eastern: an evening log
// landed on tomorrow, a 8:44pm approval was stamped with the next day, and
// the patient's "N of M logged today" went to zero at dinner time. (Dan hit
// all three.) One constant, one pair of SQL fragments, used everywhere a
// date is derived.

const FALLBACK_TZ = "America/New_York";

function validTz(tz: string | undefined): string {
  // The fragment is inlined into SQL (DEFAULTs and joins can't take a bind
  // parameter), so the name is allowlisted, never interpolated blind.
  if (tz && /^[A-Za-z0-9_+\-/]+$/.test(tz)) return tz;
  return FALLBACK_TZ;
}

/** The clinic's timezone. Env-overridable for a future clinic setting. */
export const APP_TZ = validTz(process.env.APP_TZ);

/** SQL: today's date where the clinic is. */
export const APP_DAY = `(now() AT TIME ZONE '${APP_TZ}')::date`;

/** SQL: the clinic-local calendar day of a timestamptz expression. */
export function dayOf(expr: string): string {
  return `(${expr} AT TIME ZONE '${APP_TZ}')::date`;
}
