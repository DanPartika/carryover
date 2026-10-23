import { describe, expect, it } from "vitest";
import { screenDraft } from "./closing";

// The closing-summary screen is a blocklist, and a blocklist is only as good as
// its list. These pin the wording the review showed slipping through.

const FACTS =
  "Care ran 36 days. You logged 41 home sessions across 22 different days. Climbing stairs: you rated it 3 at the start and 7 later (it rose). You were seen in the office 3 times.";

const BASE =
  "This summary covers your care for a right knee problem, from the first visit to the last, a stretch of 36 days. " +
  "You logged 41 home sessions across 22 different days, and you were seen in the office 3 times. " +
  "On the goal you rated yourself, climbing stairs, you rated it 3 at the start and 7 later, which is a rise in your own rating. " +
  "Your plan changed along the way, and your PT will add their own reading to this record.";

describe("screenDraft", () => {
  it("passes a plain, grounded draft", () => {
    expect(screenDraft(BASE, FACTS)).toEqual([]);
  });

  it.each([
    "You met your stairs goal.",
    "You reached a 7 on climbing stairs.",
    "You achieved what you set out to do.",
    "Your knee healed well.",
    "You are stronger now.",
    "Your gains were steady.",
    "Things are back to normal.",
    "You should keep icing.",
    "You can now manage the stairs.",
    "The swelling went away.",
    "You are on track.",
    "You are doing well.",
  ])("rejects evaluative wording: %s", (sentence) => {
    const out = screenDraft(`${BASE} ${sentence}`, FACTS);
    expect(out.some((v) => v.startsWith("uses evaluative or forward-looking language")), sentence).toBe(true);
  });

  it("rejects a count spelled out in words, which the digit check can't see", () => {
    for (const phrase of ["you were seen three visits", "over a couple of weeks", "across several sessions", "about two months"]) {
      const out = screenDraft(`${BASE} Also, ${phrase}.`, FACTS);
      expect(out.some((v) => v.startsWith("states a count in words")), phrase).toBe(true);
    }
  });

  it("does not trip on ordinary words that merely contain those letters", () => {
    // "metrics", "abnormality", "reaching toward" must not be mistaken for verdicts.
    expect(screenDraft(`${BASE} Your PT logged the metrics.`, FACTS)).toEqual([]);
  });
});
