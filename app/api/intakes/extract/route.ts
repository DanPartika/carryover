// POST /api/intakes/extract — read a doctor's referral and propose the intake.
//
// multipart: clinicId, patientUserId?, and either `file` (chosen from the PT's
// computer — read and dropped) or `documentId` (already attached to the episode).
// PT/admin only. Changes NOTHING: no row is written. It answers with what it
// found, as a draft for the PT to read against the page and apply to the form;
// nothing is saved until they save the intake.
//
// This is the TEXT reader — deterministic, no model, no network. Pictures inside
// the file (a protocol sheet that is an image) are reported here and read, only
// on a deliberate click, by /api/intakes/read-pictures.

import { NextRequest, NextResponse } from "next/server";
import { scrubNames } from "@/lib/ai/closing";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { extractOrders, suggestFields } from "@/lib/intake/orders";
import { readPdf } from "@/lib/intake/pdf";
import { loadOrdersSource, tooLargeToRead } from "@/lib/intake/source";

const MIN_TEXT_CHARS = 40;

const pagesLabel = (pages: number[]) =>
  pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (tooLargeToRead(req)) {
    return NextResponse.json({ error: "that file is too large to read here" }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "couldn't read that upload" }, { status: 400 });
  const loaded = await loadOrdersSource(pool, user.id, form);
  if ("response" in loaded) return loaded.response;
  const { source } = loaded;

  const warnings: string[] = [];
  let pictures = { count: 0, pages: [] as number[] };
  let text = "";

  if (source.kind === "image") {
    pictures = { count: 1, pages: [] };
    warnings.push(
      "This is a picture, so there is no text to read. Use “Read the picture with AI” to transcribe it.",
    );
  } else if (source.kind === "pdf") {
    const pdf = await readPdf(source.bytes);
    if (pdf.problem === "too_long") {
      return NextResponse.json(
        { error: `that PDF is ${pdf.pages} pages — too long to read here. Paste the part you need.` },
        { status: 422 },
      );
    }
    if (pdf.problem === "unreadable") {
      return NextResponse.json(
        { error: "couldn't read that PDF — it may be password-protected or damaged" },
        { status: 422 },
      );
    }
    // A blank line between pages, so a value can't run on across a page break
    // into the next page's running header.
    text = pdf.pageTexts.join("\n\n");
    pictures = { count: pdf.pictures.length, pages: [...new Set(pdf.pictures.map((p) => p.page))] };
  } else {
    text = new TextDecoder().decode(source.bytes);
  }

  let result: ReturnType<typeof extractOrders> | null = null;
  if (source.kind !== "image") {
    if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
      warnings.push(
        pictures.count > 0
          ? "This PDF has almost no text — it looks like a scan. Use “Read the pictures with AI” to transcribe it."
          : "This file has almost no text to read. Paste the key lines instead.",
      );
    } else {
      result = extractOrders(text, { scrub: (s) => scrubNames(s, source.names) });
      const f = result.found;
      if (!result.hasContent) {
        warnings.push("No referral fields were recognised in the text of this file.");
      } else {
        if (!f.weightBearing) {
          warnings.push("No weight-bearing status was found. If the doctor set one, add it under Restrictions.");
        }
        if (f.surgeryDateTbd) {
          warnings.push(
            "The referral says the surgery date isn't set yet — the AI can't tell which phase of a protocol applies until it is.",
          );
        }
        if (result.protocolNamedOnly) {
          warnings.push(
            pictures.count > 0
              ? `The referral names a protocol (“${f.protocol}”) but its steps aren't in the text — this file has ${pictures.count === 1 ? "a picture" : `${pictures.count} pictures`} (${pagesLabel(pictures.pages)}) that may be it.`
              : `The referral names a protocol (“${f.protocol}”) but doesn't include its steps. The AI won't fill them in from memory — paste them in if you have them.`,
          );
        }
      }
    }
  }

  return NextResponse.json({
    kind: source.kind,
    label: source.label,
    found: result?.found ?? null,
    fields: result?.hasContent ? suggestFields(result.found) : null,
    hasContent: result?.hasContent ?? false,
    pictures,
    warnings,
  });
}
