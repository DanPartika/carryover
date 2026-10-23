import { describe, expect, it } from "vitest";
import { extractOrders, isIdentifyingLine, ordersBlock, parseDate, suggestFields } from "./orders";

// The LAYOUT of a real EHR referral (labelled fields printed right beside the
// patient's demographics and insurance), with every value invented.
const REFERRAL = `Riverside Orthopaedics • 100 Example Avenue, SPRINGFIELD VA 22000-1234
EXAMPLE, Jordan (id #11223344, dob: 01/02/1990)
Referral Order
03/04/2026
Order Timestamp: 03/04/2026 9:15am
To Provider From Provider
NPI #
ALEX SAMPLE, MD
1234567890
ALEX SAMPLE, MD
Riverside Office
100 Example Avenue Suite 120
Phone: (555) 010-2000
Fax: (555) 010-2001
Referral Order Information
Diagnosis Tear of anterior cruciate ligament of right knee, initial encounter - Right
ICD-10: S83.511A: Sprain of anterior cruciate ligament of right knee, initial
encounter
Order Name Orders included: 1
Tear of anterior cruciate ligament of right knee, initial encounter - Right
ICD-10: S83.511A: Sprain of anterior cruciate ligament of right knee, initial encounter
PHYSICAL THERAPIST REFERRAL
Schedule Within: provider's discretion Note to Provider: PT to begin POD 1-3;
Surgery Date 03/20/2026
Evaluate & Treat: s/p right knee ACL reconstruction with hamstring autograft and
partial medial meniscectomy
Visits per Week: 2
Number of Weeks: 12
Exercises: as indicated
Protocols: ACL Reconstruction : PHASE I
Side: RIGHT
Weight Bearing Status: Weight bearing as tolerated with brace locked in extension
Notes PT to begin POD 1-3; Surgery Date 03/20/2026
Patient Information
Patient Name EXAMPLE, JORDAN
Sex - DOB - Age F 01/02/1990 36yo
Address 12 MAPLE ST/APT 4
SPRINGFIELD, VA 22001-0001
Phone H: (555) 123-4567
M: (555) 123-4568
Primary Insurance ACME HEALTH (PPO)
ID: ZZ12345678
Group: 98765AB
Policy Holder: EXAMPLE, JORDAN
Secondary Insurance None recorded.
Electronically Signed by: ALEX SAMPLE, MD
Riverside Orthopaedics • 100 Example Avenue, SPRINGFIELD VA 22000-1234
EXAMPLE, Jordan (id #11223344, dob: 01/02/1990)`;

// Every identifier in the sample above — none may survive into the output.
const IDENTIFIERS = [
  "EXAMPLE, JORDAN",
  "Jordan",
  "01/02/1990",
  "11223344",
  "MAPLE",
  "22001",
  "22000",
  "555) 123",
  "123-4567",
  "123-4568",
  "ZZ12345678",
  "98765AB",
  "ACME",
  "1234567890",
  "010-2000",
  "010-2001",
  "Example Avenue",
  "Riverside",
];

describe("a referral printed from an EHR", () => {
  const res = extractOrders(REFERRAL);
  const f = res.found;
  const block = ordersBlock(f);

  it("finds the clinical fields", () => {
    expect(f.diagnosis).toBe("Tear of anterior cruciate ligament of right knee, initial encounter");
    expect(f.icd10).toEqual(["S83.511A"]);
    expect(f.procedure).toBe("s/p right knee ACL reconstruction with hamstring autograft and partial medial meniscectomy");
    expect(f.side).toBe("right");
    expect(f.bodyRegions).toEqual(["knee"]);
    expect(f.weightBearing).toBe("Weight bearing as tolerated with brace locked in extension");
    expect(f.protocol).toBe("ACL Reconstruction: PHASE I");
    expect(f.frequency).toBe("2 visits per week");
    expect(f.duration).toBe("12 weeks");
    expect(f.instructions).toBe("as indicated");
    expect(f.surgeryDate).toBe("2026-03-20");
    expect(f.surgeryDateTbd).toBe(false);
    expect(f.orderDate).toBe("2026-03-04");
    expect(res.hasContent).toBe(true);
  });

  it("carries the start timing once, not as a second copy under 'also stated'", () => {
    expect(f.timing).toBe("PT to begin POD 1-3; Surgery Date 03/20/2026");
    expect(f.other).toEqual([]);
  });

  it("takes none of the patient's identifiers", () => {
    const everything = JSON.stringify(f) + block;
    for (const id of IDENTIFIERS) expect(everything.toLowerCase(), id).not.toContain(id.toLowerCase());
  });

  it("writes a labelled block the PT can read and the AI can't misread", () => {
    expect(block.split("\n")).toEqual([
      "Doctor's referral, dated 2026-03-04:",
      "Diagnosis: Tear of anterior cruciate ligament of right knee, initial encounter (ICD-10 S83.511A)",
      "Procedure: s/p right knee ACL reconstruction with hamstring autograft and partial medial meniscectomy",
      "Side: Right",
      "Weight-bearing status: Weight bearing as tolerated with brace locked in extension",
      "Protocol: ACL Reconstruction: PHASE I",
      "Visits: 2 visits per week for 12 weeks",
      "Surgery date: 2026-03-20",
      "Start: PT to begin POD 1-3; Surgery Date 03/20/2026",
      "Exercises: as indicated",
    ]);
  });

  it("proposes the intake fields it can fill", () => {
    const s = suggestFields(f);
    expect(s.condition).toBe(f.diagnosis);
    expect(s.side).toBe("right");
    expect(s.bodyRegions).toEqual(["knee"]);
    expect(s.onsetDate).toBe("2026-03-20");
    expect(s.surgeries).toBe(f.procedure);
    expect(s.restrictions).toBe("Weight bearing: Weight bearing as tolerated with brace locked in extension");
    expect(s.providerPlan).toBe(block);
  });
});

describe("a referral with the surgery date still open and a protocol only named", () => {
  const text = REFERRAL.replace("Surgery Date 03/20/2026", "Surgery Date TBD")
    .replace("PT to begin POD 1-3; Surgery Date 03/20/2026", "PT to begin POD 1-3; Surgery Date TBD")
    .replace("Weight bearing as tolerated with brace locked in extension", "No weight bearing")
    .replace("ACL Reconstruction : PHASE I", "MACI Patellofemoral : PATHWAY B");
  const res = extractOrders(text);

  it("says the date is unset, and keeps it out of the dates", () => {
    expect(res.found.surgeryDate).toBeNull();
    expect(res.found.surgeryDateTbd).toBe(true);
    expect(ordersBlock(res.found)).toContain("Surgery date: not set yet (TBD)");
  });

  it("notices that a protocol was named but its steps aren't in the text", () => {
    expect(res.found.protocol).toBe("MACI Patellofemoral: PATHWAY B");
    expect(res.protocolNamedOnly).toBe(true);
    expect(res.found.weightBearing).toBe("No weight bearing");
  });
});

describe("a protocol written out as text", () => {
  const text = `Rehabilitation Protocol — ACL reconstruction
Phase I (weeks 0-2): Non-weight bearing on crutches. Brace locked in extension.
ROM 0-90 degrees. Quad sets and heel slides.
Phase II (weeks 2-6): Progress to weight bearing as tolerated, unlock brace when quad control allows.
Avoid open-chain knee extension against resistance until week 12.
Precautions: no pivoting or twisting on the planted foot.
Clearance from the surgeon is required before jumping or running.`;
  const res = extractOrders(text);

  it("keeps the lines that state a rule, and sees the phases", () => {
    expect(res.hasContent).toBe(true);
    expect(res.protocolNamedOnly).toBe(false);
    // The protocol NAME is the one line it was printed on, not the page after it.
    expect(res.found.protocol).toBe("ACL reconstruction");
    expect(res.found.weightBearing).toMatch(/weight[\s-]*bearing/i);
    const stated = [...res.found.other, ...res.found.precautions].join("\n");
    expect(stated).toContain("Phase I (weeks 0-2)");
    expect(stated).toContain("Phase II (weeks 2-6)");
    expect(stated).toContain("0-90 degrees");
    expect(stated).toContain("Avoid open-chain knee extension");
    expect(stated).toContain("Clearance from the surgeon");
    expect(res.found.precautions.join(" ")).toContain("no pivoting or twisting");
  });

  it("caps what it carries, so a long protocol can't flood the box", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Week ${i + 1}: continue the brace and avoid impact loading`).join("\n");
    expect(extractOrders(long).found.other.length).toBeLessThanOrEqual(40);
  });
});

describe("text with nothing in it", () => {
  it("recognises that there are no orders", () => {
    const res = extractOrders("Thank you for your continued support of our practice.\nSee you soon.");
    expect(res.hasContent).toBe(false);
    expect(extractOrders("").hasContent).toBe(false);
  });

  it("finds a bare weight-bearing instruction without any labels", () => {
    const res = extractOrders("Post-op instructions: NWB left leg for 6 weeks, then progress as tolerated.");
    expect(res.found.weightBearing).toMatch(/^NWB left leg for 6 weeks/);
    expect(res.hasContent).toBe(true);
  });
});

describe("the patient's own name", () => {
  it("is removed by the scrub the caller supplies, wherever it sits in a clinical line", () => {
    const text = "Diagnosis: Right shoulder pain\nNotes: Jordan should avoid overhead lifting. Ms. Example may use a sling.";
    const scrub = (s: string) => s.replace(/\bjordan\b/gi, "the patient").replace(/\bexample\b/gi, "the patient");
    const res = extractOrders(text, { scrub });
    const out = JSON.stringify(res.found) + ordersBlock(res.found);
    expect(out).not.toMatch(/jordan|example/i);
    expect(out).toContain("the patient");
  });
});

describe("isIdentifyingLine", () => {
  it.each([
    "Patient Name EXAMPLE, JORDAN",
    "Sex - DOB - Age F 01/02/1990 36yo",
    "DOB: 01/02/1990",
    "Date of birth 1990-01-02",
    "Address 12 MAPLE ST/APT 4",
    "SPRINGFIELD, VA 22001-0001",
    "Phone H: (555) 123-4567",
    "M: (555) 123-4568",
    "Fax: (555) 010-2001",
    "Primary Insurance ACME HEALTH (PPO)",
    "ID: ZZ12345678",
    "Group: 98765AB",
    "Policy Holder: EXAMPLE, JORDAN",
    "EXAMPLE, Jordan (id #11223344, dob: 01/02/1990)",
    "To Provider From Provider",
    "1234567890",
    "Riverside Orthopaedics • 100 Example Avenue, SPRINGFIELD VA 22000-1234",
    "reach me at jordan@example.com",
  ])("drops %s", (line) => {
    expect(isIdentifyingLine(line)).toBe(true);
  });

  it.each([
    "Weight Bearing Status: No weight bearing",
    "Visits per Week: 2-3",
    "Number of Weeks: 4-6 weeks",
    "Notes PT to begin POD 1-3; Surgery Date TBD",
    "Protocols: MACI Patellofemoral : PATHWAY B",
    "Group exercise classes are fine after week 12",
    "ICD-10: S83.272D: Complex tear of lateral meniscus",
    "Phase II (weeks 6-12): progress to full weight bearing without brace",
    "Evaluate & Treat: s/p Left knee femoral trochlea MACI procedure",
  ])("keeps %s", (line) => {
    expect(isIdentifyingLine(line)).toBe(false);
  });
});

describe("parseDate", () => {
  it("reads the ways a form prints a date, and nothing else", () => {
    expect(parseDate("03/20/2026")).toBe("2026-03-20");
    expect(parseDate("3-4-26")).toBe("2026-03-04");
    expect(parseDate("2026-03-20")).toBe("2026-03-20");
    expect(parseDate("March 20, 2026")).toBe("2026-03-20");
    expect(parseDate("Mar. 5 2026")).toBe("2026-03-05");
    expect(parseDate("TBD")).toBeNull();
    expect(parseDate("13/45/2026")).toBeNull();
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("ordersBlock", () => {
  it("leaves out whatever wasn't found, rather than printing empty labels", () => {
    const res = extractOrders("Diagnosis: Right shoulder impingement\nVisits per Week: 3");
    const block = ordersBlock(res.found);
    expect(block).toContain("Diagnosis: Right shoulder impingement");
    expect(block).toContain("Visits: 3 visits per week");
    expect(block).not.toMatch(/Procedure:|Protocol:|Weight-bearing|Precaution|Surgery date/);
  });
});
