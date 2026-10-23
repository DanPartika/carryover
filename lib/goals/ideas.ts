// Ideas for goals, for people who "weren't sure what else".
//
// Two sources, kept apart on purpose:
//   * STARTER_IDEAS — a fixed, hand-written list keyed by body region. Shown to
//     patients (intake and Today) and used as the fallback everywhere.
//   * AI ideas (lib/ai/goals.ts) — tailored to the intake, shown to the PT only.
//     Nothing the model writes reaches a patient without a PT choosing it; the
//     patient-facing list is authored content, like the exercise library.
//
// An idea is only ever a short, neutral activity — never advice, a target or a
// prediction. screenIdea() is what holds AI output to that.

import { goalKey, GOAL_TEXT_MAX } from "./model";

/** What people most often want back, by region. Phrased as the activity itself,
 *  in the patient's words, so it drops straight into the goal field. */
export const STARTER_IDEAS: Record<string, string[]> = {
  knee: [
    "Walking without a limp",
    "Climbing stairs",
    "Getting in and out of the car",
    "Getting up from a low chair",
    "Standing for as long as I need to",
  ],
  hip: [
    "Putting on socks and shoes",
    "Getting out of a chair",
    "Walking the dog",
    "Lying on my side",
    "Getting in and out of the car",
  ],
  ankle_foot: [
    "Walking on uneven ground",
    "Standing on my feet all day",
    "Walking barefoot around the house",
    "Going up and down stairs",
    "Getting back to my usual shoes",
  ],
  spine: [
    "Sitting for an hour",
    "Bending to pick something up",
    "Getting out of bed in the morning",
    "Driving for a while",
    "A full day at work",
  ],
  core: [
    "Getting out of bed without pushing off",
    "Lifting a bag of groceries",
    "Standing up straight at the end of the day",
    "Getting in and out of the car",
  ],
  shoulder: [
    "Reaching a high shelf",
    "Getting dressed",
    "Washing my hair",
    "Sleeping on that side",
    "Carrying groceries",
  ],
  elbow: [
    "Lifting a full cup or kettle",
    "Carrying a bag",
    "Opening doors and jars",
    "Typing for a while",
  ],
  wrist_hand: [
    "Opening jars",
    "Typing for a while",
    "Gripping a pan or a tool",
    "Carrying a bag",
  ],
  neck: [
    "Turning my head to check traffic",
    "Looking at a screen for an hour",
    "Sleeping without waking with a stiff neck",
    "Carrying a bag on one shoulder",
  ],
  full_body: [
    "A full day without having to rest",
    "Walking for half an hour",
    "Getting back to my usual exercise",
  ],
};

/** Not tied to a region — what an injury or surgery most often costs. */
export const GENERAL_IDEAS = [
  "Sleeping through the night",
  "Getting around the house",
  "Showering and dressing myself",
  "Getting back to work",
  "Getting back to my usual exercise",
];

/** Up to `limit` ideas for the regions given, region-specific first, minus
 *  anything already on the list. Order is stable so the chips don't shuffle. */
export function starterIdeas(regions: readonly string[], exclude: readonly string[] = [], limit = 6): string[] {
  const taken = new Set(exclude.map(goalKey));
  const out: string[] = [];
  const add = (s: string) => {
    const k = goalKey(s);
    if (out.length < limit && !taken.has(k)) {
      taken.add(k);
      out.push(s);
    }
  };
  // Round-robin across regions so a two-region problem shows both, rather than
  // the first region's five filling every slot.
  const lists = regions.map((r) => STARTER_IDEAS[r] ?? []);
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) add(l[i]);
  }
  for (const g of GENERAL_IDEAS) add(g);
  return out;
}

// What an idea may not sound like. These are activities, not advice: no
// number, no timeline, no promise, no judgement about the person's recovery.
const IDEA_BANNED =
  /\b(should|must|will|won't|never|always|guarantee|recover|recovery|heal|healed|cure|cured|fix|fixed|normal|full strength|pain[- ]free|no pain|within|weeks?|months?|days|years?|percent|ready|progress)\b/i;

/** Screen one model-written idea. Returns the cleaned text, or null to drop it.
 *  Short, no digits or markup, no advice/prediction wording. */
export function screenIdea(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  if (s.length < 4 || s.length > 70) return null;
  if (s.split(" ").length > 11) return null;
  if (/[0-9<>*_`#[\]{}|\\\/%]/.test(s)) return null;
  if (IDEA_BANNED.test(s)) return null;
  if (/[?!:;]/.test(s)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1, GOAL_TEXT_MAX);
}

/** The screened, de-duplicated list, minus anything already a goal. */
export function cleanIdeas(raw: unknown, exclude: readonly string[] = [], limit = 6): string[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set(exclude.map(goalKey));
  const out: string[] = [];
  for (const r of raw) {
    const s = screenIdea(r);
    if (!s) continue;
    const k = goalKey(s);
    if (taken.has(k)) continue;
    taken.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
