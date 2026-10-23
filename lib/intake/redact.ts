// Taking identifiers out of a doctor's plan before a model reads it.
//
// This is the SECOND line of defence. The first is structural: the referral
// parser (lib/intake/orders) drops identifying lines before it reads a field. But
// the doctor's-plan box also holds whatever a PT or patient typed or pasted, and
// a parser can be walked around by an unusual layout, so what goes to a model is
// passed through here as well.
//
// Best effort, and honestly so: these are patterns for the shapes identifiers
// usually take, and the patient's own name parts are removed by the caller
// (scrubNames). A pattern list can't promise that nothing slips through — which
// is why the PT sees the text before it is saved and the screen says "best
// effort", not "removed". Dates of SURGERY and onset are deliberately kept: a
// protocol's phases are defined by them. Only a date labelled as a birth date
// goes.

const DATE =
  "(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4})";

// A record-style token must contain a digit: "member id: BX778899001" is an id,
// "group exercise" is not.
const TOKEN = "(?=[A-Z0-9-]*\\d)[A-Z0-9-]{4,}";

const RULES: [RegExp, string][] = [
  // a birth date, by its label ("DOB: 3/14/84") or in words ("born on 02/09/1961")
  [
    new RegExp(
      `(?:\\bd\\.?o\\.?b\\b|\\bdate\\s+of\\s+birth\\b|\\bbirth\\s*date\\b|\\bborn(?:\\s+on)?\\b)\\.?\\s*[:#-]?\\s*${DATE}`,
      "gi",
    ),
    "[date of birth removed]",
  ],
  // a record, member, account or encounter number, by its label
  [
    new RegExp(
      `\\b(?:mrn|medical\\s+record(?:\\s+(?:number|no\\.?|#))?|acct|account|chart|fin|csn|encounter|visit|claim|auth(?:orization)?|member|subscriber|group|policy|patient|medicare|medicaid|mbi|ssn)\\s*(?:#|no\\.?|number|id)?\\s*[:#]?\\s*${TOKEN}`,
      "gi",
    ),
    "[id removed]",
  ],
  // US social security number: dashed or spaced
  [/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[id removed]"],
  // phone numbers: 555-123-4567, (555) 123-4567, (555)123-4567, 555.123.4567, +1 555 123 4567
  [/(?:\+?1[\s.-])?\(\s*\d{3}\s*\)\s*\d{3}[\s.-]?\d{4}\b/g, "[phone removed]"],
  [/(?:\+?1[\s.-])?\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone removed]"],
  // age and sex as a demographic: "55 y F", "65 yo M", "36-year-old female"
  [/\b\d{1,3}\s*(?:y\/?o|yo|y\.o\.|yrs?|years?)\b[\s-]*(?:old)?[\s,/]*(?:male|female|man|woman|M|F)\b/gi, "[age/sex removed]"],
  // any long unbroken digit run is an identifier, not a clinical value
  [/\b\d{8,}\b/g, "[id removed]"],
];

// Emails get their own bounded pass: an unbounded `[A-Z0-9._%+-]+@…` backtracks
// quadratically on a long run of dots and letters with no "@".
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;

/** The most text it will examine; anything beyond is cut, not scanned. A real
 *  plan is a few thousand characters. */
const MAX_REDACT_CHARS = 200_000;

export function redactIdentifiers(text: string): string {
  let out = text.length > MAX_REDACT_CHARS ? text.slice(0, MAX_REDACT_CHARS) : text;
  if (out.includes("@")) out = out.replace(EMAIL, "[email removed]");
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
