import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { downscale, encodePng, KIND_GRAY_1BPP, KIND_RGB_24, KIND_RGBA_32, toRaster } from "./png";
import { PDF_MAX_PAGES, PICTURE_MIN_PIXELS, readPdf } from "./pdf";

// ---------------------------------------------------------------------------
// PNG

describe("toRaster", () => {
  it("passes plain RGB straight through", () => {
    const r = toRaster({ width: 2, height: 1, kind: KIND_RGB_24, data: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    expect(Array.from(r!.rgb)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("flattens transparency onto WHITE, so a clear background never turns black", () => {
    const r = toRaster({
      width: 3,
      height: 1,
      kind: KIND_RGBA_32,
      data: new Uint8Array([0, 0, 0, 0, /* clear */ 10, 20, 30, 255, /* solid */ 0, 0, 0, 128 /* half */]),
    });
    expect(Array.from(r!.rgb.subarray(0, 3))).toEqual([255, 255, 255]);
    expect(Array.from(r!.rgb.subarray(3, 6))).toEqual([10, 20, 30]);
    // Half-transparent black over white lands mid-grey.
    expect(r!.rgb[6]).toBeGreaterThanOrEqual(126);
    expect(r!.rgb[6]).toBeLessThanOrEqual(128);
  });

  it("expands one-bit images, honouring each row's byte padding", () => {
    // 10 pixels wide → 2 bytes a row. Row 0: 1010101010; row 1: all set.
    const data = new Uint8Array([0b10101010, 0b10000000, 0xff, 0xff]);
    const r = toRaster({ width: 10, height: 2, kind: KIND_GRAY_1BPP, data })!;
    const px = (x: number, y: number) => r.rgb[(y * 10 + x) * 3];
    expect([0, 1, 2, 3, 8, 9].map((x) => px(x, 0))).toEqual([255, 0, 255, 0, 255, 0]);
    expect(px(9, 1)).toBe(255);
  });

  it("declines layouts it doesn't decode, and data that is too short", () => {
    expect(toRaster({ width: 2, height: 2, kind: 99, data: new Uint8Array(100) })).toBeNull();
    expect(toRaster({ width: 4, height: 4, kind: KIND_RGB_24, data: new Uint8Array(5) })).toBeNull();
    expect(toRaster({ width: 0, height: 4, kind: KIND_RGB_24, data: new Uint8Array(0) })).toBeNull();
  });
});

describe("downscale", () => {
  const solid = (w: number, h: number, v: number) => ({ width: w, height: h, rgb: new Uint8Array(w * h * 3).fill(v) });

  it("leaves a picture that already fits exactly as it is", () => {
    const r = solid(100, 50, 7);
    expect(downscale(r, 200)).toBe(r);
  });

  it("shrinks the longer side to the limit and keeps the proportions", () => {
    const out = downscale(solid(2000, 1000, 9), 1568);
    expect(out.width).toBe(1568);
    expect(out.height).toBe(784);
    expect(out.rgb.length).toBe(1568 * 784 * 3);
    expect(out.rgb[0]).toBe(9);
  });

  it("averages blocks rather than dropping pixels, so thin strokes survive as grey", () => {
    // 4x2 alternating black/white columns → 2x1: each output pixel averages a 2x2 block.
    const rgb = new Uint8Array(4 * 2 * 3);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) rgb.fill(x % 2 ? 255 : 0, (y * 4 + x) * 3, (y * 4 + x) * 3 + 3);
    const out = downscale({ width: 4, height: 2, rgb }, 2);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(out.rgb[0]).toBeGreaterThanOrEqual(127);
    expect(out.rgb[0]).toBeLessThanOrEqual(128);
  });
});

describe("encodePng", () => {
  const rgb = new Uint8Array(4 * 3 * 3).map((_, i) => i * 7);
  const png = Buffer.from(encodePng({ width: 4, height: 3, rgb }));

  it("is a well-formed PNG: signature, header, and a valid checksum on every chunk", () => {
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    let pos = 8;
    const types: string[] = [];
    while (pos < png.length) {
      const len = png.readUInt32BE(pos);
      const type = png.toString("ascii", pos + 4, pos + 8);
      const body = png.subarray(pos + 4, pos + 8 + len);
      expect(png.readUInt32BE(pos + 8 + len), `crc of ${type}`).toBe(crc32(body));
      types.push(type);
      pos += 12 + len;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
  });

  it("carries the pixels it was given", () => {
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((4 * 3 + 1) * 3);
    expect(raw[0]).toBe(0); // filter: none
    expect(Array.from(raw.subarray(1, 13))).toEqual(Array.from(rgb.subarray(0, 12)));
  });
});

// ---------------------------------------------------------------------------
// PDF — built in memory, so the real reading path is exercised.

type PageSpec = { lines?: string[]; image?: { w: number; h: number; declared?: { w: number; h: number } } };

function makePdf(pages: PageSpec[]): Uint8Array {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (b: string | Buffer) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    chunks.push(buf);
    pos += buf.length;
  };
  const obj = (n: number, body: string | Buffer[]) => {
    offsets[n] = pos;
    put(`${n} 0 obj\n`);
    if (typeof body === "string") put(body);
    else body.forEach(put);
    put("\nendobj\n");
  };

  put("%PDF-1.4\n");
  const kids: number[] = [];
  let next = 4;
  const plan = pages.map((p) => {
    const page = next++;
    const content = next++;
    const image = p.image ? next++ : null;
    kids.push(page);
    return { p, page, content, image };
  });

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  for (const { p, page, content, image } of plan) {
    obj(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ""} >> >>`,
    );
    const ops = [
      ...(p.lines ?? []).map((t, i) => `BT /F1 12 Tf 1 0 0 1 72 ${720 - 18 * i} Tm (${t}) Tj ET`),
      ...(p.image ? [`q ${p.image.w} 0 0 ${p.image.h} 72 100 cm /Im1 Do Q`] : []),
    ].join("\n");
    obj(content, [Buffer.from(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`, "latin1")]);
    if (image && p.image) {
      const { w, h, declared } = p.image;
      // `declared` lies about the size in the image dictionary while shipping a
      // tiny stream — the shape of a decompression bomb.
      const px = Buffer.alloc(declared ? 300 : w * h * 3);
      if (!declared)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) px.set([x % 256, y % 256, 128], (y * w + x) * 3);
      obj(image, [
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${declared?.w ?? w} /Height ${declared?.h ?? h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n`,
          "latin1",
        ),
        px,
        Buffer.from("\nendstream", "latin1"),
      ]);
    }
  }

  const count = next;
  const xref = pos;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

describe("readPdf", () => {
  it("reads the text of each page, line by line", async () => {
    const r = await readPdf(
      makePdf([
        { lines: ["Diagnosis: Right shoulder pain", "Weight Bearing Status: Full"] },
        { lines: ["Visits per Week: 3"] },
      ]),
    );
    expect(r.problem).toBeNull();
    expect(r.pages).toBe(2);
    expect(r.pageTexts[0]).toContain("Diagnosis: Right shoulder pain");
    expect(r.pageTexts[0]).toContain("Weight Bearing Status: Full");
    expect(r.pageTexts[1]).toContain("Visits per Week: 3");
    expect(r.pictures).toEqual([]);
  });

  it("finds a document-sized picture, and can turn it into a PNG", async () => {
    const w = 320;
    const h = 300;
    expect(w * h).toBeGreaterThanOrEqual(PICTURE_MIN_PIXELS);
    const bytes = makePdf([{ lines: ["Page one"] }, { image: { w, h } }]);

    const meta = await readPdf(bytes);
    expect(meta.pictures).toEqual([{ page: 2, width: w, height: h, png: undefined }]);

    const full = await readPdf(bytes, { rasterize: true });
    const png = Buffer.from(full.pictures[0].png!);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
    // The pixels survived the trip: row 0, pixel 5 was written as (5, 0, 128).
    const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    expect(Array.from(raw.subarray(1 + 5 * 3, 1 + 5 * 3 + 3))).toEqual([5, 0, 128]);
  });

  it("ignores logos and signature scribbles, and counts a repeated picture once", async () => {
    const small = await readPdf(makePdf([{ image: { w: 50, h: 50 } }]));
    expect(small.pictures).toEqual([]);
    const twice = await readPdf(makePdf([{ image: { w: 320, h: 300 } }, { image: { w: 320, h: 300 } }]));
    expect(twice.pictures).toHaveLength(1);
  });

  it("won't try to decode an image that declares billions of pixels, and still returns the text", async () => {
    const started = Date.now();
    const r = await readPdf(
      makePdf([
        { lines: ["Diagnosis: Right shoulder pain"] },
        { image: { w: 100, h: 100, declared: { w: 40000, h: 40000 } } },
      ]),
      { rasterize: true },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.pictures).toEqual([]);
    expect(r.pageTexts[0]).toContain("Diagnosis: Right shoulder pain");
  });

  it("says so when it isn't a PDF it can read", async () => {
    const r = await readPdf(new Uint8Array(Buffer.from("this is not a pdf at all")));
    expect(r.problem).toBe("unreadable");
    expect(r.pageTexts).toEqual([]);
  });

  it("won't read a document longer than it is willing to parse", async () => {
    const r = await readPdf(makePdf(Array.from({ length: PDF_MAX_PAGES + 1 }, () => ({ lines: ["x"] }))));
    expect(r.problem).toBe("too_long");
    expect(r.pages).toBe(PDF_MAX_PAGES + 1);
  });
});
