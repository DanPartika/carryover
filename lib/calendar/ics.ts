// ICS feed builder for the patient's home program (RFC 5545 subset that
// Google/Apple/Outlook subscription parsers accept).
//
// ONE recurring all-day event, not sixty stamped copies. The home program is
// the same every day — the plan prescribes frequencies ("3×/week"), never
// weekdays, so the app would be inventing schedule it doesn't have if it put
// TKE on Tuesdays. A single FREQ=DAILY series anchored on the plan's approval
// date says exactly what the app knows: "this is your program, every day it's
// been your program." The day's actual choosing stays with the patient.
//
// Deterministic on purpose: DTSTAMP and DTSTART come from the plan's approval
// date, so two fetches of the same plan state are byte-identical and Google
// never sees phantom updates. A new plan (every progression makes one) changes
// the UID and replaces the series wholesale.
//
// All-day and TRANSP:TRANSPARENT: nobody is busy because they owe themselves
// ten quad sets, and the plants app already learned that timed events crowd a
// calendar into noise.

import { dosageLine, type Dosed } from "@/lib/dosage";

export type FeedItem = Dosed & {
  name: string;
  kind: "exercise" | "modality";
  careTiming: "before" | "after" | null;
  frequencyPerWeek: number;
};

/** A real newline, named so nothing here carries an escaped one through a
 *  template literal. `esc` turns it into the literal \n DESCRIPTION needs. */
const NL = String.fromCharCode(10);

const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold long content lines at 74 units with a leading space (RFC 5545 §3.1).
 *  Counted in UTF-16 units; the only hard rule is never splitting a surrogate
 *  pair, since the summary is emoji-led and names are user text. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    const code = rest.charCodeAt(73);
    const at = code >= 0xd800 && code <= 0xdbff ? 73 : 74;
    out.push(rest.slice(0, at));
    rest = " " + rest.slice(at);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** "20260807" — the DATE form an all-day DTSTART takes. */
const icsDate = (day: string) => day.replace(/-/g, "");

/** The day after `day`, in UTC arithmetic (every day is 24h there). DTEND is
 *  EXCLUSIVE in iCalendar — a one-day event ends on the next day, and getting
 *  it wrong renders a zero-length event some clients drop. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function itemLine(i: FeedItem): string {
  return `• ${i.name} — ${dosageLine(i)}`;
}

export function buildPatientFeed(opts: {
  calendarName: string;
  /** Stable per-plan identity; a progression's new plan replaces the series. */
  planId: string | null;
  /** YYYY-MM-DD (UTC) the active plan was approved — the series anchor. */
  anchorDay: string | null;
  items: FeedItem[];
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lithe//Carryover//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:${esc(opts.calendarName)}`),
    "X-PUBLISHED-TTL:PT12H",
  ];

  const home = opts.items; // caller sends home-location items only
  if (opts.planId && opts.anchorDay && home.length > 0) {
    const before = home.filter((i) => i.careTiming === "before");
    const after = home.filter((i) => i.careTiming === "after");
    const main = home.filter((i) => i.careTiming === null);

    const summary = `↪ PT home program — ${home.length} to do`;

    // The description carries what one line can't: the program itself, in the
    // same before/exercises/after order the Today screen shows.
    const blocks: string[] = [];
    const grouped = before.length > 0 || after.length > 0;
    if (before.length) blocks.push(["Before you start:", ...before.map(itemLine)].join(NL));
    if (main.length)
      blocks.push([grouped ? "Your exercises:" : null, ...main.map(itemLine)].filter(Boolean).join(NL));
    if (after.length) blocks.push(["After you finish:", ...after.map(itemLine)].join(NL));
    blocks.push("Open Carryover to log what you did — your PT sees it before your next visit.");

    lines.push(
      "BEGIN:VEVENT",
      fold(`UID:plan-${opts.planId}@carryover.lithe`),
      `DTSTAMP:${icsDate(opts.anchorDay)}T000000Z`,
      `DTSTART;VALUE=DATE:${icsDate(opts.anchorDay)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(opts.anchorDay))}`,
      "RRULE:FREQ=DAILY",
      fold(`SUMMARY:${esc(summary)}`),
      fold(`DESCRIPTION:${esc(blocks.join(NL + NL))}`),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
