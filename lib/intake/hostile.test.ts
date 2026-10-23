import { describe, expect, it } from "vitest";
import { scrubNames } from "@/lib/ai/closing";
import { extractOrders, ordersBlock } from "./orders";
import { redactIdentifiers } from "./redact";

// Layouts a reviewer built to get identifiers and wrong clinical values through
// the referral parser. Each of these reproduced against the first version.

const NAMES = ["Pat", "Quimby"];

const run = (text: string) => {
  const res = extractOrders(text, { scrub: (s) => scrubNames(s, NAMES) });
  const out = JSON.stringify(res.found) + ordersBlock(res.found);
  // The plan-draft route redacts the stored block again before the model sees it.
  const sent = redactIdentifiers(scrubNames(ordersBlock(res.found), NAMES));
  return { res, out, sent };
};

describe("identifiers behind an unusual layout", () => {
  it("drops the value line under a label-only demographic, so a DOB isn't read as a wrapped note", () => {
    const { res, out } = run(
      "Diagnosis: Right TKA\nNotes: PT to begin POD 1-3\nDate of Birth\n07/07/1970\nAddress\n12 Maple Street\nSpringfield",
    );
    expect(res.found.timing).toBe("PT to begin POD 1-3");
    expect(out).not.toMatch(/1970|Maple|Springfield/);
  });

  it("drops a bare demographics line (Last, First, date, age/sex) between clinical lines", () => {
    const { out } = run(
      "Diagnosis: Right TKA\nNotes: PT to begin POD 1-3 with gentle ROM\nQuimby, Pat Q   07/07/1970   55 y F\nVisits per Week: 2",
    );
    expect(out).not.toMatch(/Quimby|1970|55 y/);
    expect(out).toContain("PT to begin POD 1-3 with gentle ROM");
  });

  it("doesn't carry account, encounter, subscriber or SSN-shaped numbers", () => {
    for (const line of [
      "Acct # 1234567",
      "Encounter # 4455667",
      "Chart no. 99812",
      "Bill subscriber ID BX778899001 for these visits.",
      "SSN 078 05 1120",
      "Member # ZX-99812-A",
    ]) {
      const { out, sent } = run(`Diagnosis: Right TKA\nNotes: Begin PT at 1 week post-op\n${line}\nVisits per Week: 2`);
      expect(out + sent, line).not.toMatch(/1234567|4455667|99812|BX778899001|078 05 1120|ZX-99812/);
    }
  });

  it("drops a name that sits under a bare 'Name' or 'Patient:' label", () => {
    const a = run("Procedure: Total knee arthroplasty\nName\nPatricia M Quimby\nVisits per Week: 2");
    expect(a.out).not.toMatch(/Patricia|Quimby/);
    expect(a.res.found.procedure).toBe("Total knee arthroplasty");
    const b = run("Procedure: Total knee arthroplasty\nPatient:\nQuimby, Pat Q\nVisits per Week: 2");
    expect(b.out).not.toMatch(/Quimby/);
    expect(b.res.found.procedure).toBe("Total knee arthroplasty");
  });

  it("removes a birth date and age/sex written as prose", () => {
    const { out, sent } = run(
      "Post-op: a 65 year old man born on 02/09/1961 who is s/p right TKA, weight bearing as tolerated.",
    );
    expect(out + sent).not.toMatch(/1961|65 year old man/);
  });

  it("catches a phone number with no space after the parenthesis", () => {
    expect(redactIdentifiers("call (555)010-3333 today")).toBe("call [phone removed] today");
  });

  it("doesn't let a value run across a page break", () => {
    const pages = ["Notes: PT to begin POD 1-3", "Quimby, Pat Q   07/07/1970   55 y F\nRiverside Ortho"];
    const { out } = run(pages.join("\n\n"));
    expect(out).not.toMatch(/Quimby|1970|55 y/);
  });
});

describe("clinical values the first version got wrong", () => {
  it("doesn't read a NEGATED weight-bearing phrase as the status", () => {
    const a = run("Precautions: avoid full weight bearing until week 6");
    expect(a.res.found.weightBearing).toBeNull();
    expect(a.res.found.precautions.join(" ")).toContain("avoid full weight bearing until week 6");
    const b = run("Post-op: no WBAT before 4 weeks. Progress to full weight bearing at week 8.");
    expect(b.res.found.weightBearing).toBeNull();
    // A plain statement still counts.
    expect(run("Patient is NWB on the left leg for 6 weeks.").res.found.weightBearing).toMatch(/^NWB on the left leg/);
  });

  it("leaves the side blank when both sides are named, instead of choosing the first", () => {
    expect(run("Diagnosis: right knee ACL tear, left knee meniscus tear").res.found.side).toBeNull();
    expect(run("Side: Bilateral").res.found.side).toBe("both");
    expect(run("Side: LEFT").res.found.side).toBe("left");
  });

  it("doesn't take a tentative, pending or cancelled surgery date as the date", () => {
    for (const v of [
      "tentative 03/20/2026",
      "03/20/2026 (pending insurance approval)",
      "CANCELLED - was 03/20/2026",
      "approx. 03/20/2026",
    ]) {
      const r = run(`Diagnosis: Right TKA\nSurgery Date: ${v}`).res.found;
      expect(r.surgeryDate, v).toBeNull();
      expect(r.surgeryDateTbd, v).toBe(true);
    }
    expect(run("Diagnosis: Right TKA\nSurgery Date: 03/20/2026").res.found.surgeryDate).toBe("2026-03-20");
  });

  it("keeps clinical lines that merely contain a street-like word", () => {
    const { res } = run(
      "Notes: Return to drive in 6 weeks.\nPrecautions: 2 weeks before you may drive or use a ladder.\nWeight Bearing Status: Touch down only for 4 weeks then progress by Way of crutches",
    );
    expect(res.found.weightBearing).toMatch(/Touch down only for 4 weeks/);
    expect(res.found.precautions.join(" ")).toContain("2 weeks before you may drive");
    expect(JSON.stringify(res.found)).toContain("Return to drive in 6 weeks");
  });

  it("keeps a long list of precautions, not just the first three lines", () => {
    const things = ["running", "jumping", "kneeling", "twisting", "lifting", "squatting"];
    const lines = things.map((t) => `No ${t} until cleared`);
    const { res } = run(`Precautions: ${lines[0]}\n${lines.slice(1).join("\n")}`);
    const got = res.found.precautions.join(" ");
    for (const l of lines) expect(got).toContain(l);
  });

  it("keeps orders that follow a mid-document signature", () => {
    const { res } = run(
      "Weight Bearing Status: NWB\nElectronically Signed by: A. SAMPLE, MD\nA. SAMPLE, MD\nPrecautions: no running or jumping until cleared",
    );
    expect(res.found.precautions.join(" ")).toContain("no running or jumping until cleared");
  });

  it("keeps short precautions, not only lines over twelve characters", () => {
    const { res } = run("Brace locked in extension\nNo running\nDiagnosis: Right TKA");
    expect(JSON.stringify(res.found)).toContain("No running");
  });
});

describe("hostile input", () => {
  it("a long run of commas, dots and labels can't hold the server busy", () => {
    const hostile = [
      "Notes: " + ",;".repeat(60_000) + "x",
      "a.".repeat(100_000) + "@" + "b.".repeat(50_000),
      "Notes:\n".repeat(20_000),
    ].join("\n");
    const started = Date.now();
    extractOrders(hostile);
    redactIdentifiers(hostile);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("scrubNames", () => {
  it("matches accented, hyphenated and apostrophe names, with or without the accents", () => {
    expect(scrubNames("José and JOSE said Renée's knee is fine, Renee too.", ["José", "Renée"])).toBe(
      "the patient and the patient said the patient's knee is fine, the patient too.",
    );
    expect(scrubNames("Anne-Marie and Marie O'Brien came; Obrien too", ["Anne-Marie", "O'Brien"])).toBe(
      "the patient-the patient and the patient the patient came; the patient too",
    );
  });

  it("doesn't corrupt clinical text for a patient whose name is an ordinary word", () => {
    const out = scrubNames("Will rested. He will ice, and mark the swelling.", ["Will Smith", "Mark"]);
    expect(out).toBe("the patient rested. He will ice, and mark the swelling.");
  });

  it("takes the parts of an email local part, and leaves words that merely contain a name", () => {
    expect(scrubNames("Silva said the patient is Patricia", ["jo.silva", "Pat"])).toBe(
      "the patient said the patient is Patricia",
    );
  });
});
