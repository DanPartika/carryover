// POST /api/intakes/read-pictures — read the PICTURES in a doctor's document.
//
// Same inputs as /api/intakes/extract plus `confirm=yes`, which the page only
// sends after telling the PT what this does: the picture(s) go to the AI. Only
// the embedded pictures are sent — never the PDF's text layer, never the file
// name — but a photo of a whole referral shows the model whatever is printed on
// it, and pixels can't be redacted. So it is PT-only, per click, and what comes
// back is a draft transcription for the PT to check against the page.
//
// Never a dead end: any failure answers { ok: false, reason } and the PT can
// paste the content instead. Changes nothing.

import { NextRequest, NextResponse } from "next/server";
import { ordersModel, readPictures, type PictureInput } from "@/lib/ai/orders";
import { requireUser } from "@/lib/auth/identity";
import { getPool } from "@/lib/db/pool";
import { readPdf } from "@/lib/intake/pdf";
import { loadOrdersSource, tooLargeToRead } from "@/lib/intake/source";

/** The platform's AI route takes at most 10 MB a request, base64 included. */
const MAX_PAYLOAD_BYTES = 7 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const pool = getPool();
  const user = await requireUser(req, pool);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (tooLargeToRead(req)) {
    return NextResponse.json({ error: "that file is too large to read here" }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "couldn't read that upload" }, { status: 400 });
  if (form.get("confirm") !== "yes") {
    return NextResponse.json(
      { error: "confirm that the picture(s) may be sent to the AI" },
      { status: 400 },
    );
  }
  const loaded = await loadOrdersSource(pool, user.id, form);
  if ("response" in loaded) return loaded.response;
  const { source } = loaded;

  const warnings: string[] = [];
  const images: PictureInput[] = [];
  let pages: number[] = [];

  if (source.kind === "text") {
    return NextResponse.json({ error: "a text file has no pictures to read" }, { status: 415 });
  }
  if (source.kind === "image") {
    if (source.bytes.length > MAX_PHOTO_BYTES) {
      return NextResponse.json(
        { error: "that photo is too large to read — try a smaller one" },
        { status: 413 },
      );
    }
    images.push({
      mediaType: source.mime as PictureInput["mediaType"],
      base64: Buffer.from(source.bytes).toString("base64"),
    });
  } else {
    const pdf = await readPdf(source.bytes, { rasterize: true });
    if (pdf.problem) {
      return NextResponse.json(
        {
          error:
            pdf.problem === "too_long"
              ? `that PDF is ${pdf.pages} pages — too long to read here`
              : "couldn't read that PDF — it may be password-protected or damaged",
        },
        { status: 422 },
      );
    }
    let used = 0;
    let skipped = 0;
    for (const pic of pdf.pictures) {
      if (!pic.png) continue;
      const base64 = Buffer.from(pic.png).toString("base64");
      if (used + base64.length > MAX_PAYLOAD_BYTES) {
        skipped++;
        continue;
      }
      used += base64.length;
      images.push({ mediaType: "image/png", base64 });
      pages.push(pic.page);
    }
    pages = [...new Set(pages)];
    if (skipped > 0) warnings.push(`${skipped} more picture(s) were too large to include.`);
    if (images.length === 0) {
      return NextResponse.json(
        { ok: false, reason: "No pictures were found in that PDF that can be read.", pages, warnings },
        { status: 200 },
      );
    }
  }

  const started = Date.now();
  const result = await readPictures({ images, jwt: user.token });

  await pool.query(
    `INSERT INTO ai_call_log (user_id, kind, mode, model, status, latency_ms, error)
     VALUES ($1, 'orders-pictures', $2, $3, $4, $5, $6)`,
    [
      user.id,
      result.mode,
      result.model ?? (result.mode === "lithe" ? ordersModel() : null),
      result.ok ? "ok" : "error",
      Date.now() - started,
      result.ok ? null : result.reason,
    ],
  );

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, pages, warnings });
  }
  return NextResponse.json({ ok: true, block: result.block, pages, warnings });
}
