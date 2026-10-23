import { describe, expect, it } from "vitest";
import { attachmentHeader, cleanFilename, fileSize, MAX_DOC_BYTES, megabytes, sniffDocument } from "./documents";
import { INTAKE_INSERT_SQL, intakeInsertValues, parseIntakeFields, PROVIDER_PLAN_MAX } from "./fields";
import { redactIdentifiers } from "./redact";

// A synthetic referral: the SHAPE of what gets pasted from a chart, with
// invented values. The clinical lines must survive redaction, because they are
// the whole reason the text is sent; the identifying ones must not.
const REFERRAL = `PHYSICAL THERAPIST REFERRAL
Patient: Jordan Example   DOB: 03/14/1984   MRN: 00482913   Phone: (555) 123-4567
Email: jordan.example@mail.test
Diagnosis: Complex tear of lateral meniscus, left knee ICD-10: S83.272D
Surgery date: 08/12/2026
Protocol: MACI Patellofemoral PATHWAY B
Weight Bearing Status: No weight bearing for 6 weeks
Visits per Week: 2-3   Number of Weeks: 4-6 weeks   PT to begin POD 1-3
Insurance member id: ZX99812344   SSN 123-45-6789`;

describe("redactIdentifiers", () => {
  const out = redactIdentifiers(REFERRAL);

  it("removes what identifies the person", () => {
    expect(out).not.toMatch(/03\/14\/1984/);
    expect(out).not.toMatch(/00482913/);
    expect(out).not.toMatch(/555\) 123-4567|123-4567/);
    expect(out).not.toMatch(/jordan\.example@mail\.test/);
    expect(out).not.toMatch(/ZX99812344/);
    expect(out).not.toMatch(/123-45-6789/);
    expect(out).toContain("[date of birth removed]");
    expect(out).toContain("[phone removed]");
    expect(out).toContain("[email removed]");
  });

  it("keeps every clinical line the draft depends on", () => {
    expect(out).toContain("Complex tear of lateral meniscus, left knee ICD-10: S83.272D");
    expect(out).toContain("Surgery date: 08/12/2026");
    expect(out).toContain("MACI Patellofemoral PATHWAY B");
    expect(out).toContain("Weight Bearing Status: No weight bearing for 6 weeks");
    expect(out).toContain("Visits per Week: 2-3");
    expect(out).toContain("Number of Weeks: 4-6 weeks");
    expect(out).toContain("PT to begin POD 1-3");
  });

  it("handles the other ways a birth date is written", () => {
    for (const t of [
      "DOB 1984-03-14",
      "D.O.B.: 3.14.84",
      "Date of birth: March 14, 1984",
      "birthdate - 03/14/1984",
    ]) {
      expect(redactIdentifiers(`x ${t} y`)).toBe("x [date of birth removed] y");
    }
  });

  it("leaves a surgery date and ordinary numbers alone", () => {
    const clinical = "Surgery 10/17/2026. ROM 0-90 degrees. Bike 20 minutes. 3 sets of 10.";
    expect(redactIdentifiers(clinical)).toBe(clinical);
  });

  it("catches phone numbers in the usual shapes", () => {
    for (const p of ["555-123-4567", "(555) 123-4567", "555.123.4567", "+1 555 123 4567"]) {
      expect(redactIdentifiers(`call ${p} now`)).toContain("[phone removed]");
    }
  });

  it("is a no-op on text with nothing to remove", () => {
    expect(redactIdentifiers("No weight bearing. Quad sets, ankle pumps.")).toBe(
      "No weight bearing. Quad sets, ankle pumps.",
    );
  });
});

// Bytes for each kind we keep. Only the leading bytes matter to the sniffer.
const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const pad = (head: Uint8Array, n = 64) => {
  const out = new Uint8Array(Math.max(n, head.length));
  out.set(head);
  return out;
};

describe("sniffDocument", () => {
  it("identifies each kind from its bytes, whatever the name says", () => {
    expect(sniffDocument(pad(text("%PDF-1.7\n")), "x.pdf")?.mime).toBe("application/pdf");
    expect(sniffDocument(pad(text("%PDF-1.4")), "renamed.txt")?.mime).toBe("application/pdf");
    expect(sniffDocument(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "a.png")?.mime).toBe("image/png");
    expect(sniffDocument(pad(bytes(0xff, 0xd8, 0xff, 0xe0)), "a.jpg")?.mime).toBe("image/jpeg");
    const webp = pad(text("RIFF\0\0\0\0WEBPVP8 "));
    expect(sniffDocument(webp, "a.webp")?.mime).toBe("image/webp");
    const heic = pad(new Uint8Array([0, 0, 0, 24, ...text("ftypheic")]));
    expect(sniffDocument(heic, "IMG_1.HEIC")?.mime).toBe("image/heic");
  });

  it("takes a zip as a Word document only when the name agrees", () => {
    const zip = pad(bytes(0x50, 0x4b, 0x03, 0x04));
    expect(sniffDocument(zip, "protocol.docx")?.label).toBe("Word document");
    expect(sniffDocument(zip, "archive.zip")).toBeNull();
    expect(sniffDocument(zip, "protocol.txt")).toBeNull();
  });

  it("keeps plain text, and only real text", () => {
    expect(sniffDocument(text("Weight bearing as tolerated after week 6.\n"), "orders.txt")?.mime).toBe("text/plain");
    expect(sniffDocument(text("café — naïve ✓"), "notes.md")?.mime).toBe("text/plain");
    expect(sniffDocument(pad(bytes(0x41, 0x00, 0x42)), "binary.txt")).toBeNull();
    expect(sniffDocument(bytes(0xff, 0xfe, 0xfd, 0x80, 0x81), "bad.txt")).toBeNull();
  });

  it("refuses what could run, or was never a document", () => {
    expect(sniffDocument(text("<!doctype html><script>alert(1)</script>"), "photo.png")).toBeNull();
    expect(sniffDocument(text("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"), "a.svg")).toBeNull();
    expect(sniffDocument(text("<html>"), "plan.txt")?.mime).toBe("text/plain"); // stored AND served as text, never rendered
    expect(sniffDocument(pad(bytes(0x4d, 0x5a, 0x90)), "setup.pdf")).toBeNull(); // an .exe wearing a .pdf name
    expect(sniffDocument(new Uint8Array(0), "empty.pdf")).toBeNull();
  });

  it("the per-file limit is the one the column enforces", () => {
    expect(MAX_DOC_BYTES).toBe(8388608);
  });
});

describe("cleanFilename", () => {
  it("drops any path, quotes and control characters", () => {
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("C:\\Users\\me\\protocol.pdf")).toBe("protocol.pdf");
    expect(cleanFilename('pla"n\u0007\n.pdf')).toBe("plan.pdf");
    expect(cleanFilename("  .hidden  ")).toBe("hidden");
  });

  it("never returns nothing", () => {
    expect(cleanFilename("")).toBe("document");
    expect(cleanFilename("///")).toBe("document");
    expect(cleanFilename("???")).toBe("document");
  });

  it("caps a long name but keeps its extension", () => {
    const out = cleanFilename(`${"a".repeat(300)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("file sizes", () => {
  it("reads at the scale of the file, and limits read in megabytes", () => {
    expect(fileSize(45)).toBe("45 B");
    expect(fileSize(1536)).toBe("2 KB");
    expect(fileSize(340 * 1024)).toBe("340 KB");
    expect(fileSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
    expect(megabytes(MAX_DOC_BYTES)).toBe("8.0 MB");
  });
});

describe("attachmentHeader", () => {
  it("is always a download, with an ASCII fallback beside the real name", () => {
    const h = attachmentHeader("Réhab plan.pdf");
    expect(h.startsWith("attachment;")).toBe(true);
    expect(h).toContain('filename="R_hab plan.pdf"');
    expect(h).toContain("filename*=UTF-8''R%C3%A9hab%20plan.pdf");
  });
});

describe("the doctor's plan on the intake row", () => {
  it("is parsed, capped, and carried in the INSERT with one placeholder per value", () => {
    const f = parseIntakeFields({ providerPlan: "  No weight bearing for six weeks.  " });
    expect(f.providerPlan).toBe("No weight bearing for six weeks.");
    expect(parseIntakeFields({}).providerPlan).toBeNull();
    expect(parseIntakeFields({ providerPlan: "   " }).providerPlan).toBeNull();
    expect(parseIntakeFields({ providerPlan: "x".repeat(PROVIDER_PLAN_MAX + 500) }).providerPlan).toHaveLength(
      PROVIDER_PLAN_MAX,
    );

    const values = intakeInsertValues("e", "u", "c", f);
    const highest = Math.max(...[...INTAKE_INSERT_SQL.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(highest).toBe(values.length);
    expect(values[values.length - 1]).toBe("No weight bearing for six weeks.");
  });
});
