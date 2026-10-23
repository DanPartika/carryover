import { describe, expect, it } from "vitest";
import { parseRatings } from "@/lib/review/goals";
import { withExtension } from "./documents";

describe("withExtension — a saved file's extension follows what it is", () => {
  it("renames a file whose name claims a different type", () => {
    expect(withExtension("update.exe", "application/pdf")).toBe("update.pdf");
    expect(withExtension("referral", "image/png")).toBe("referral.png");
    expect(withExtension("scan.tiff", "image/jpeg")).toBe("scan.jpg");
    expect(withExtension("notes.pdf", "text/plain")).toBe("notes.txt");
  });

  it("keeps a name that already agrees, including the common variants", () => {
    expect(withExtension("Dr Smith protocol.pdf", "application/pdf")).toBe("Dr Smith protocol.pdf");
    expect(withExtension("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
    expect(withExtension("orders.md", "text/plain")).toBe("orders.md");
    expect(
      withExtension("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("plan.docx");
  });

  it("never produces an empty stem", () => {
    expect(withExtension(".exe", "application/pdf")).toBe("document.pdf");
  });
});

describe("parseRatings — a missing rating is not a zero", () => {
  const goals = [
    { activity: "Stairs", baseline: 4, baselineOn: "2026-10-01", current: null, currentOn: null },
  ];

  it("drops null, empty, boolean and array ratings instead of recording 0 ('can't do it at all')", () => {
    for (const rating of [null, "", "  ", false, [], {}, undefined, "lots"]) {
      expect(parseRatings([{ activity: "Stairs", rating }], goals), String(JSON.stringify(rating))).toEqual([]);
    }
  });

  it("still takes a real 0, a number, and a numeric string", () => {
    expect(parseRatings([{ activity: "Stairs", rating: 0 }], goals)).toEqual([{ activity: "Stairs", rating: 0 }]);
    expect(parseRatings([{ activity: "stairs", rating: "7" }], goals)).toEqual([{ activity: "Stairs", rating: 7 }]);
    expect(parseRatings([{ activity: "Stairs", rating: 11 }], goals)).toEqual([]);
  });
});
