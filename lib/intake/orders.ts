// Pulling the clinical content out of a doctor's referral.
//
// A referral printed from an EHR is a form: labelled fields (Diagnosis, Visits
// per Week, Weight Bearing Status, Protocols…) sitting right beside the
// patient's name, date of birth, address, insurance ids and phone numbers. The
// AI draft needs the first and has no use for the second.
//
// So this READS rather than redacts. Lines that identify a person are dropped
// before anything is parsed, and only labelled clinical fields (plus a capped
// set of other lines that name a restriction, a phase or a weight-bearing rule)
// are carried out. An identifier therefore can't survive by slipping past a
// pattern — it was never taken. No model is involved: it works offline, it is
// the same every time, and nothing about the patient leaves the building.
//
// What it returns is a DRAFT for the PT: it fills the intake form, the PT reads
// it against the page, and nothing is saved until they save the intake.

import { redactIdentifiers } from "./redact";

export type OrdersFound = {
  orderDate: string | null;
  diagnosis: string | null;
  icd10: string[];
  procedure: string | null;
  side: "left" | "right" | "both" | null;
  bodyRegions: string[];
  weightBearing: string | null;
  protocol: string | null;
  frequency: string | null;
  duration: string | null;
  timing: string | null;
  surgeryDate: string | null;
  /** The referral says the surgery date is not set yet. */
  surgeryDateTbd: boolean;
  instructions: string | null;
  precautions: string[];
  other: string[];
};

export type OrdersResult = {
  found: OrdersFound;
  /** Anything at all worth showing — false means "this text has no orders in it". */
  hasContent: boolean;
  /** A protocol is named but nothing in the text spells out its steps. */
  protocolNamedOnly: boolean;
};

// ---------------------------------------------------------------------------
// Lines that identify a person: dropped before parsing, never carried forward.

const IDENTIFYING: RegExp[] = [
  /^\s*patient\s+(?:name|id|number|information|demographics)\b/i,
  /^\s*name\s*:/i,
  /^\s*(?:sex|gender)\b.*\b(?:dob|age)\b/i,
  /^\s*(?:dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date)\b/i,
  /\b(?:dob|d\.o\.b\.?)\s*:/i,
  /^\s*(?:address|street|city|zip|postal)\b/i,
  /^\s*(?:phone|tel|telephone|mobile|cell|fax|e-?mail)\b/i,
  /^\s*[hmwc]\s*:\s*[(+\d]/i,
  /^\s*(?:primary|secondary|tertiary)\s+insurance\b/i,
  /^\s*(?:insurance|payer|policy|policy\s+holder|subscriber|member|guarantor)\b/i,
  /^\s*(?:id|group|member\s+id|policy|mrn|ssn|npi)\s*(?:#|no\.?|number)?\s*[:#]/i,
  /\bid\s*#\s*\d/i,
  /\bnpi\s*#?\s*\d?/i,
  /^\s*(?:to|from)\s+provider\b/i,
  /^\s*\d{9,11}\s*$/,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  // A street address: a number, then capitalised words, then a street word that
  // is itself capitalised ("900 N RANDOLPH ST", "12 Maple Street"). Deliberately
  // case-sensitive: "6 weeks before you may drive" is clinical, not an address.
  /\b\d{1,5}\s+(?:[A-Z][A-Za-z0-9.'-]*\s+){1,3}(?:ST|St|STREET|Street|AVE|Ave|AVENUE|Avenue|RD|Rd|ROAD|Road|BLVD|Blvd|BOULEVARD|Boulevard|DR|Dr|DRIVE|Drive|LN|Ln|LANE|Lane|CT|Ct|COURT|Court|WAY|Way|PL|Pl|PLACE|Place|PKWY|Pkwy|HWY|Hwy)\b\.?/,
  /@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
  /(?:\(\s*\d{3}\s*\)\s*|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/,
  // "55 y F", "65 yo M", "36-year-old female": age and sex as a demographics line.
  /\b\d{1,3}\s*(?:y\/?o|yo|y\.o\.|yrs?|years?)\b[\s-]*(?:old)?[\s,/]*(?:male|female|man|woman|M|F)\b/i,
  // A bare "Patient: Last, First" / "RE: Last, First" header.
  /^\s*(?:patient|pt|re)\s*:\s*[A-Z][A-Za-z'’-]+,\s*[A-Z]/,
  // "Acct # 1234567", "Encounter # 4455667", "Chart no. 99812": a record number.
  /\b(?:acct|account|chart|fin|csn|encounter|visit|claim|auth(?:orization)?)\s*(?:#|no\.?|number|id)\s*[:#]?\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}/i,
  /\b(?:member|subscriber|group|policy|medicare|medicaid|mbi)\s*(?:#|no\.?|number|id)?\s*[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}/i,
];

// A line that is only a demographic label: its VALUE is on the next line, so
// that line has to go too ("Date of Birth" / "07/07/1970").
const LABEL_ONLY =
  /^\s*(?:patient\s+)?(?:name|dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|address|street|phone|telephone|mobile|cell|fax|e-?mail|ssn|mrn|member\s+id|policy|group|patient\s+id|insurance|subscriber|patient|pt|re)\s*:?\s*$/i;
const LABEL_ONLY_WIDE = /^\s*(?:address|street|insurance|primary\s+insurance|secondary\s+insurance)\s*:?\s*$/i;

/** "Quimby, Pat Q" — a bare name line. Only when it is short, starts the line,
 *  and says nothing clinical, so "Rehab, Phase I" style lines are left alone. */
const LAST_FIRST = /^\s*[A-Z][A-Za-z'’-]+,\s+[A-Z][A-Za-z'’-]+(?:\s+[A-Z]\.?)?(?:\s|$)/;

const PATIENT_BLOCK_START = /^\s*(?:patient\s+(?:information|demographics)|demographics|insurance\s+information)\b/i;

export function isIdentifyingLine(line: string): boolean {
  if (IDENTIFYING.some((re) => re.test(line))) return true;
  // A short "Last, First" line with no clinical words in it is a name.
  return LAST_FIRST.test(line) && line.trim().split(/\s+/).length <= 8 && !CLINICAL_LINE.test(line);
}

// ---------------------------------------------------------------------------
// Labels

const LABELS = {
  diagnosis: ["Primary Diagnosis", "Diagnosis", "Dx", "Reason for Referral"],
  icd: ["ICD-?10(?:\\s+codes?)?", "ICD"],
  procedure: ["Surgical Procedure", "Procedure", "Operation"],
  surgeryDate: ["Surgery Date", "Date of Surgery", "Date of Procedure", "Procedure Date", "DOS"],
  evaluate: ["Evaluate\\s*(?:&|and|/)\\s*Treat"],
  frequency: ["Visits\\s*(?:per|/|a)\\s*Week", "Frequency"],
  duration: ["Number\\s+of\\s+Weeks", "Duration"],
  exercises: ["Therapeutic\\s+Exercises", "Exercises"],
  protocol: ["Rehab(?:ilitation)?\\s+Protocols?", "Protocols?"],
  side: ["Laterality", "Side"],
  weightBearing: ["Weight[\\s-]*Bearing\\s+Status", "Weight[\\s-]*Bearing", "WB\\s+Status"],
  notes: ["Note\\s+to\\s+Provider", "Special\\s+Instructions", "Instructions", "Comments?", "Notes?"],
  precautions: ["Precautions?", "Restrictions?", "Contraindications?", "Limitations?"],
  rom: ["ROM\\s+Restrictions?", "Range\\s+of\\s+Motion", "ROM"],
  brace: ["Bracing", "Brace"],
  schedule: ["Schedule\\s+Within"],
  orderDate: ["Order\\s+Date", "Date\\s+of\\s+Order"],
} as const;

/** Section titles and duplicated headings: they END a value but carry none. */
const BOUNDARY_ONLY = [
  "PHYSICAL\\s+THERAPIST\\s+REFERRAL",
  "PHYSICAL\\s+THERAPY\\s+REFERRAL",
  "Referral\\s+Order\\s+Information",
  "Referral\\s+Order",
  "Order\\s+Name",
  "Order\\s+Timestamp",
  "Clinical\\s+Documents",
];

const alt = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).join("|");
const ALL = alt([...Object.values(LABELS).flat(), ...BOUNDARY_ONLY]);

// A label at the start of a line (colon optional: "Diagnosis Complex tear…"),
// or after other words on the same line when it carries a colon
// ("…discretion Note to Provider: PT to begin…").
const LABEL_RE = new RegExp(
  `(?<![^\\n])[ \\t]*(${ALL})\\b[ \\t]*:?[ \\t]*|(?<=[^\\n])[ \\t](${ALL}):[ \\t]*`,
  "gi",
);

const which = (label: string): keyof typeof LABELS | "boundary" => {
  const l = label.replace(/\s+/g, " ").trim();
  for (const [key, patterns] of Object.entries(LABELS)) {
    if (patterns.some((p) => new RegExp(`^(?:${p})$`, "i").test(l))) return key as keyof typeof LABELS;
  }
  return "boundary";
};

// ---------------------------------------------------------------------------

/** How many printed lines a field's value may run over. A form wraps a long
 *  diagnosis onto a second line; it never wraps a protocol NAME into a page. */
const MAX_LINES: Record<keyof typeof LABELS, number> = {
  diagnosis: 3,
  icd: 2,
  procedure: 3,
  surgeryDate: 1,
  evaluate: 3,
  frequency: 1,
  duration: 1,
  exercises: 2,
  protocol: 1,
  side: 1,
  weightBearing: 3,
  notes: 4,
  precautions: 8,
  rom: 3,
  brace: 2,
  schedule: 1,
  orderDate: 1,
};

/** A field's value from the text after its label: at most `maxLines` lines,
 *  ending early at a blank line or at a line that finishes a sentence. */
function takeValue(raw: string, maxLines: number): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      if (out.length) break;
      continue;
    }
    // A bare date or number on its own line is a demographic, not a wrapped
    // continuation of the value above it ("…POD 1-3" / "07/07/1970").
    if (out.length && /^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d[\d\s().-]{5,})$/.test(t)) break;
    out.push(t);
    if (out.length >= maxLines || /[.!?]$/.test(t)) break;
  }
  return clean(out.join(" "));
}

/** Collapse whitespace and trim stray punctuation from both ends. The trailing
 *  trim is a loop, not a regex: `[\s;,]+$` backtracks quadratically on a long
 *  run of commas, and this runs on text from an untrusted file. */
function clean(s: string): string {
  const t = s.replace(/\s+/g, " ");
  let start = 0;
  while (start < t.length && /[\s:–—-]/.test(t[start])) start++;
  let end = t.length;
  while (end > start && /[\s;,]/.test(t[end - 1])) end--;
  return t.slice(start, end).trim();
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date as printed on a form → yyyy-mm-dd, or null when it isn't one. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  let hit: RegExpExecArray | null;
  if ((hit = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) {
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else if ((hit = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(s))) {
    [m, d] = [Number(hit[1]), Number(hit[2])];
    y = Number(hit[3]);
    if (y < 100) y += 2000;
  } else if ((hit = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s))) {
    m = MONTHS.indexOf(hit[1].slice(0, 3).toLowerCase()) + 1;
    [d, y] = [Number(hit[2]), Number(hit[3])];
  } else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const REGION_WORDS: [string, RegExp][] = [
  ["knee", /\b(knee|meniscus|meniscal|patell\w*|trochle\w*|acl|pcl|mcl|lcl|maci|tibial tubercle|tto)\b/i],
  ["hip", /\b(hip|femoroacetabular|acetabul\w*|fai)\b/i],
  ["shoulder", /\b(shoulder|rotator cuff|glenohumeral|labrum|acromio\w*|bankart)\b/i],
  ["ankle_foot", /\b(ankle|foot|achilles|plantar|metatars\w*|bunion|hallux)\b/i],
  ["spine", /\b(spine|spinal|lumbar|thoracic|sacr\w*|disc|laminectomy|fusion|stenosis|low back)\b/i],
  ["neck", /\b(neck|cervical)\b/i],
  ["elbow", /\b(elbow|epicondyl\w*)\b/i],
  ["wrist_hand", /\b(wrist|hand|carpal|thumb|finger)\b/i],
];

const WB_WORDS =
  /\b(?:NWB|TTWB|PWB|WBAT|FWB|non[\s-]*weight[\s-]*bearing|toe[\s-]*touch(?:\s+weight[\s-]*bearing)?|touch[\s-]*down(?:\s+weight[\s-]*bearing)?|heel[\s-]*touch(?:\s+weight[\s-]*bearing)?|partial\s+weight[\s-]*bearing|full\s+weight[\s-]*bearing|weight[\s-]*bearing\s+as\s+tolerated)\b[^.\n;]{0,70}/i;

/** Words that turn a weight-bearing phrase into a limit rather than a status. */
const WB_NEGATION =
  /\b(?:avoid|no|not|never|without|until|before|prior\s+to|do\s+not|don'?t|restrict\w*|prohibit\w*|unable|cannot|can'?t|once|when|progress\s+to|advance\s+to|then)\b/i;

/** Lines that, unlabelled, still name something the draft must respect. */
const CLINICAL_LINE =
  /\b(weight[\s-]*bearing|WBAT|NWB|PWB|TTWB|FWB|brace|crutch(?:es)?|walker|CPM|ROM|range\s+of\s+motion|degrees?|flexion|extension|phase\s+[ivx\d]+|stage\s+\d|week\s*\d|weeks?\s+\d|post[\s-]*op|POD\s*\d|s\/p|status\s+post|protocol|pathway|precaution|restrict\w*|contraindicat\w*|avoid|do\s+not|no\s+(?:running|jumping|impact|resisted|squat\w*|kneeling|twisting|lifting|active)|clearance|cleared)\b/i;

const MAX_OTHER_LINES = 40;
/** Input ceiling: everything past this is ignored, so a hostile file can't hold
 *  the server busy. */
const MAX_TEXT_CHARS = 200_000;
/** How far a "Patient Information" heading's demographics block can run. */
const PATIENT_BLOCK_LINES = 14;

export function extractOrders(text: string, opts: { scrub?: (s: string) => string } = {}): OrdersResult {
  const scrub = opts.scrub ?? ((s: string) => s);
  const redact = (s: string) => redactIdentifiers(scrub(s));

  // Untrusted text: bound the work. A real referral is a few thousand
  // characters; a protocol document a few tens of thousands.
  const body = text.replace(/\r/g, "").replace(/\u00a0/g, " ").slice(0, MAX_TEXT_CHARS);

  // Drop identifying lines. Also: the value line under a label-only demographic
  // ("Date of Birth" / "07/07/1970"), the signer's name under "Signed by", and a
  // bounded run of lines under a "Patient Information" heading (it ends at a
  // clinical label, at a blank line, or after PATIENT_BLOCK_LINES lines, so a
  // narrative that follows it is not swallowed).
  const labelStart = new RegExp(`^[ \\t]*(?:${ALL})\\b`, "i");
  const SIGNED = /^\s*(?:electronically\s+)?signed\s+by\b/i;
  const kept: string[] = [];
  let blockLeft = 0;
  let dropNext = 0;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      blockLeft = 0;
      dropNext = 0;
      kept.push(line);
      continue;
    }
    if (PATIENT_BLOCK_START.test(line)) {
      blockLeft = PATIENT_BLOCK_LINES;
      continue;
    }
    if (blockLeft > 0 && labelStart.test(line) && !isIdentifyingLine(line)) blockLeft = 0;
    if (blockLeft > 0) {
      blockLeft--;
      continue;
    }
    if (SIGNED.test(line)) {
      dropNext = 1;
      continue;
    }
    if (dropNext > 0) {
      // The value of a demographic label, or the signer: never carried.
      dropNext--;
      continue;
    }
    if (LABEL_ONLY.test(line)) {
      dropNext = LABEL_ONLY_WIDE.test(line) ? 2 : 1;
      continue;
    }
    if (isIdentifyingLine(line)) continue;
    kept.push(line);
  }
  const cleaned = scrub(kept.join("\n"));

  // Split at label positions: each label's value runs to the next label, or to
  // a blank line.
  const values = new Map<keyof typeof LABELS, string[]>();
  const marks = [...cleaned.matchAll(LABEL_RE)].map((m) => ({
    label: (m[1] ?? m[2]) as string,
    start: m.index as number,
    end: (m.index as number) + m[0].length,
  }));
  marks.forEach((m, i) => {
    const kind = which(m.label);
    if (kind === "boundary") return;
    const stop = i + 1 < marks.length ? marks[i + 1].start : cleaned.length;
    const value = takeValue(cleaned.slice(m.end, stop), MAX_LINES[kind]);
    if (value) values.set(kind, [...(values.get(kind) ?? []), value]);
  });
  const first = (k: keyof typeof LABELS) => values.get(k)?.[0] ?? null;
  const all = (k: keyof typeof LABELS) => values.get(k) ?? [];

  // Diagnosis and the ICD codes that often trail it on the same value.
  let diagnosis = first("diagnosis");
  if (diagnosis) {
    diagnosis = clean(diagnosis.replace(/\bICD-?10\b.*$/i, "").replace(/\s+-\s*(?:left|right|bilateral)\s*$/i, ""));
  }
  const icd10 = new Set<string>();
  for (const v of [...all("icd"), ...(diagnosis ? [] : []), cleaned]) {
    for (const m of v.matchAll(/\b([A-TV-Z]\d{2}\.[0-9A-Z]{1,4})\b/g)) icd10.add(m[1].toUpperCase());
  }

  const evaluate = first("evaluate");
  const looksSurgical = (s: string) => /\b(s\/p|status\s+post|post[\s-]*op|surg\w*|repair|reconstruct\w*|arthroplasty|replacement|maci|osteotomy)\b/i.test(s);
  const procedure =
    first("procedure") ?? (evaluate && looksSurgical(evaluate) ? evaluate : null);

  const sideText = first("side");
  const sideFrom = (s: string | null): OrdersFound["side"] => {
    if (!s) return null;
    if (/\b(?:both|bilateral)\b/i.test(s)) return "both";
    const left = /\bleft\b/i.test(s);
    const right = /\bright\b/i.test(s);
    // Both words in one text ("right knee ACL, left knee meniscus") is not
    // something to guess at: leave it for the PT rather than pick the first.
    if (left && right) return null;
    return left ? "left" : right ? "right" : null;
  };
  const side = sideFrom(sideText) ?? sideFrom(diagnosis) ?? sideFrom(procedure);

  // A labelled status is the doctor's own field. Without one, take a
  // weight-bearing phrase from the prose — but never one that is being negated
  // or deferred ("avoid full weight bearing", "no WBAT until week 6"): reading
  // that as "full weight bearing" would be the dangerous error. Those lines
  // still reach the PT under "also stated".
  const wbLabelled = first("weightBearing");
  let wbFromProse: string | null = null;
  for (const m of cleaned.matchAll(new RegExp(WB_WORDS.source, "gi"))) {
    const before = cleaned.slice(Math.max(0, (m.index as number) - 60), m.index as number);
    const sentence = before.slice(before.search(/[.!?;\n][^.!?;\n]*$/) + 1);
    if (WB_NEGATION.test(sentence)) continue;
    wbFromProse = clean(m[0]);
    break;
  }
  const weightBearing = wbLabelled ?? wbFromProse;

  const frequencyRaw = first("frequency");
  const frequency = frequencyRaw
    ? /^\d+(?:\s*[-–]\s*\d+)?$/.test(frequencyRaw)
      ? `${frequencyRaw} visits per week`
      : frequencyRaw
    : null;
  const durationRaw = first("duration");
  const duration = durationRaw
    ? /^\d+(?:\s*[-–]\s*\d+)?$/.test(durationRaw)
      ? `${durationRaw} weeks`
      : durationRaw
    : null;

  // When PT should start, from the notes and any scheduling window with a number.
  const noteValues = [...all("notes"), ...all("schedule").filter((v) => /\d/.test(v))];
  const timingCandidates = noteValues.filter((v) =>
    /\b(begin|start|POD|post[\s-]*op|within|surgery|after)\b/i.test(v),
  );
  // The same note is often printed twice, once cut short by a neighbouring
  // label: keep the fullest, and don't list what it already says.
  const timing = [...timingCandidates].sort((a, b) => b.length - a.length)[0] ?? null;
  const otherNotes = noteValues.filter((v) => !timing || !timing.toLowerCase().includes(v.toLowerCase()));

  // A surgery date that is tentative, pending or cancelled is NOT a date: the
  // phase of a protocol runs from it, so a wrong one is worse than none.
  const surgeryRaw = first("surgeryDate");
  const surgeryUncertain =
    !!surgeryRaw &&
    /\b(tbd|tba|to be determined|tentative|pending|cancel\w*|resched\w*|postpon\w*|approx\w*|estimated|about|around|not\s+(?:yet\s+)?(?:set|scheduled|confirmed))\b/i.test(surgeryRaw);
  const surgeryDate = surgeryRaw && !surgeryUncertain ? parseDate(surgeryRaw) : null;
  const surgeryDateTbd =
    surgeryUncertain ||
    (!!surgeryRaw && !surgeryDate) ||
    /\bsurgery\s+date\s+(?:is\s+)?(?:tbd|tba)\b/i.test(cleaned);

  const orderDateRaw =
    first("orderDate") ?? /\breferral\s+order\b[^\n]*\n\s*([^\n]{6,20})/i.exec(cleaned)?.[1] ?? null;
  const orderDate = orderDateRaw ? parseDate(orderDateRaw) : null;

  const precautions = [
    ...all("precautions").map((v) => v),
    ...all("rom").map((v) => `ROM: ${v}`),
    ...all("brace").map((v) => `Brace: ${v}`),
  ].map((v) => cap(v, 300));

  const protocol = first("protocol");
  const instructionsRaw = first("exercises");

  const regionText = [diagnosis, procedure, evaluate, first("protocol")].filter(Boolean).join(" ");
  const bodyRegions = REGION_WORDS.filter(([, re]) => re.test(regionText)).map(([r]) => r);

  // Everything else that still names a rule, minus what is already captured.
  const used = clean(
    [diagnosis, procedure, weightBearing, protocol, frequency, duration, timing, instructionsRaw, ...precautions, ...otherNotes, ...noteValues]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
  const labelAnywhere = new RegExp(`(?:^|\\s)(?:${ALL})(?:\\b\\s*:|\\b)`, "i");
  const other: string[] = [];
  const seen = new Set<string>();
  for (const line of cleaned.split("\n")) {
    const t = clean(line);
    if (t.length < 8 || t.length > 260) continue;
    if (!CLINICAL_LINE.test(t)) continue;
    if (labelStart.test(t) || /^[A-Za-z &/]{2,40}:/.test(t) && labelAnywhere.test(t)) continue;
    const norm = t.toLowerCase();
    if (used.includes(norm) || seen.has(norm)) continue;
    seen.add(norm);
    other.push(t);
    if (other.length >= MAX_OTHER_LINES) break;
  }
  for (const v of otherNotes) if (!other.includes(v)) other.unshift(cap(v, 300));

  const found: OrdersFound = {
    orderDate,
    diagnosis: diagnosis ? redact(cap(diagnosis, 300)) : null,
    icd10: [...icd10].slice(0, 6),
    procedure: procedure ? redact(cap(procedure, 400)) : null,
    side,
    bodyRegions,
    weightBearing: weightBearing ? redact(cap(weightBearing, 200)) : null,
    protocol: protocol ? redact(cap(protocol.replace(/\s+:/g, ":"), 200)) : null,
    frequency: frequency ? redact(cap(frequency, 120)) : null,
    duration: duration ? redact(cap(duration, 120)) : null,
    timing: timing ? redact(cap(timing, 300)) : null,
    surgeryDate,
    surgeryDateTbd,
    instructions: instructionsRaw ? redact(cap(instructionsRaw, 300)) : null,
    precautions: precautions.map(redact),
    other: other.map((l) => redact(cap(l, 260))),
  };

  const hasContent =
    !!(found.diagnosis || found.procedure || found.weightBearing || found.protocol || found.frequency || found.timing || found.instructions) ||
    found.precautions.length > 0 ||
    found.other.length > 0;

  // A protocol is "named only" when it has a name and nothing in the text
  // describes phases or stages (the steps are probably a picture).
  const phaseLines = cleaned.split("\n").filter((l) => /\bphase\s+[ivx\d]+\b|\bstage\s+\d\b/i.test(l)).length;
  const protocolNamedOnly = !!found.protocol && phaseLines === 0;

  return { found, hasContent, protocolNamedOnly };
}

// ---------------------------------------------------------------------------
// Output

const SIDE_LABEL = { left: "Left", right: "Right", both: "Both" } as const;

/** The block that goes in the intake's "Doctor's plan" box. Labelled lines the
 *  PT can read at a glance and the AI can't misread. No patient identifiers —
 *  none were taken. */
export function ordersBlock(f: OrdersFound): string {
  const lines: string[] = [];
  lines.push(`Doctor's referral${f.orderDate ? `, dated ${f.orderDate}` : ""}:`);
  if (f.diagnosis) {
    lines.push(`Diagnosis: ${f.diagnosis}${f.icd10.length ? ` (ICD-10 ${f.icd10.join(", ")})` : ""}`);
  } else if (f.icd10.length) lines.push(`ICD-10: ${f.icd10.join(", ")}`);
  if (f.procedure) lines.push(`Procedure: ${f.procedure}`);
  if (f.side) lines.push(`Side: ${SIDE_LABEL[f.side]}`);
  if (f.weightBearing) lines.push(`Weight-bearing status: ${f.weightBearing}`);
  if (f.protocol) lines.push(`Protocol: ${f.protocol}`);
  if (f.frequency || f.duration) {
    lines.push(`Visits: ${[f.frequency, f.duration ? `for ${f.duration}` : null].filter(Boolean).join(" ")}`);
  }
  if (f.surgeryDate) lines.push(`Surgery date: ${f.surgeryDate}`);
  else if (f.surgeryDateTbd) lines.push("Surgery date: not set yet (TBD)");
  if (f.timing) lines.push(`Start: ${f.timing}`);
  if (f.instructions) lines.push(`Exercises: ${f.instructions}`);
  for (const p of f.precautions) lines.push(`Precaution: ${p}`);
  if (f.other.length) {
    lines.push("Also stated in the document:");
    for (const o of f.other) lines.push(`- ${o}`);
  }
  return lines.join("\n");
}

export type SuggestedFields = {
  condition: string | null;
  side: string | null;
  bodyRegions: string[];
  onsetDate: string | null;
  surgeries: string | null;
  restrictions: string | null;
  providerPlan: string;
};

/** What the extraction proposes for each intake field it can fill. */
export function suggestFields(f: OrdersFound): SuggestedFields {
  const restrictions = [
    f.weightBearing ? `Weight bearing: ${f.weightBearing}` : null,
    ...f.precautions,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    condition: f.diagnosis,
    side: f.side,
    bodyRegions: f.bodyRegions,
    onsetDate: f.surgeryDate,
    surgeries: f.procedure,
    restrictions: restrictions || null,
    providerPlan: ordersBlock(f),
  };
}
