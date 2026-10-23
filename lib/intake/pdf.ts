// Reading a PDF an episode was sent: its text, and its pictures.
//
// A doctor's PDF is often BOTH. The referral's fields are real text; the
// surgeon's protocol sheet stapled behind it is frequently a flat picture of a
// table, which no text extractor can see (the first real one had exactly that:
// pages of text, then one page that was a single embedded image). So this reads
// the text layer page by page and also lists the embedded pictures — and, when
// asked, turns them into PNGs.
//
// Pictures are lifted out of the file as pictures. The page is never RENDERED:
// a page's text layer carries the patient's name and DOB in its running header,
// and rendering would stamp that onto the pixels. Lifting the embedded image
// leaves it behind.
//
// The input is an untrusted file parsed in-process, so everything is bounded:
// a page cap, a picture-size floor (skips logos and signature scribbles), a
// picture count cap, a downscale, and a time limit. Needs Node 22+ (the app's image is built on it).

import { downscale, encodePng, toRaster, type DecodedImage } from "./png";

export const PDF_MAX_PAGES = 40;
/** Below this many pixels an image is a logo or a signature, not a document. */
export const PICTURE_MIN_PIXELS = 80_000;
export const PICTURE_MAX_EDGE = 1568;
export const PICTURE_MAX_COUNT = 6;
/** The most pixels pdf.js will decode for any one image. A scan of a full page
 *  is ~8 million; without a ceiling a few-hundred-byte PDF can declare an image
 *  of billions of pixels and make the server try to allocate gigabytes. */
export const MAX_DECODED_PIXELS = 25_000_000;
const READ_TIMEOUT_MS = 25_000;
const OBJECT_TIMEOUT_MS = 5_000;

export type PdfPicture = {
  page: number;
  width: number;
  height: number;
  /** Present only when the caller asked for pictures to be rasterised. */
  png?: Uint8Array;
};

export type PdfRead = {
  pages: number;
  pageTexts: string[];
  pictures: PdfPicture[];
  /** Why nothing could be read, if nothing could. */
  problem: null | "unreadable" | "too_long";
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** A cheap fingerprint of an image's pixels, so a logo repeated on every page
 *  is counted once. Samples the buffer rather than hashing all of it. */
function fingerprint(img: DecodedImage): string {
  const step = Math.max(1, Math.floor(img.data.length / 512));
  let h = 17;
  for (let i = 0; i < img.data.length; i += step) h = (h * 31 + img.data[i]) | 0;
  return `${img.width}x${img.height}:${h}`;
}

type PdfJsPage = {
  objs: { get: (name: string, cb: (o: unknown) => void) => unknown };
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  cleanup: () => void;
};

function resolveObject(page: PdfJsPage, name: string): Promise<DecodedImage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), OBJECT_TIMEOUT_MS);
    try {
      page.objs.get(name, (o) => {
        clearTimeout(timer);
        resolve((o as DecodedImage | null) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function readPdf(
  bytes: Uint8Array,
  opts: { rasterize?: boolean } = {},
): Promise<PdfRead> {
  const { getDocumentProxy, getResolvedPDFJS, extractText } = await import("unpdf");
  const empty = (problem: PdfRead["problem"], pages = 0): PdfRead => ({
    pages,
    pageTexts: [],
    pictures: [],
    problem,
  });

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy.
    pdf = await withTimeout(
      getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_DECODED_PIXELS }),
      READ_TIMEOUT_MS,
    );
  } catch {
    return empty("unreadable");
  }

  try {
    if (pdf.numPages > PDF_MAX_PAGES) return empty("too_long", pdf.numPages);

    const { text } = await withTimeout(extractText(pdf, { mergePages: false }), READ_TIMEOUT_MS);

    const { OPS } = await getResolvedPDFJS();
    const pictures: PdfPicture[] = [];
    const seen = new Set<string>();
    // A bad or oversized picture must not cost the caller the text it already
    // has: the picture scan is allowed to fail on its own.
    try {
    for (let p = 1; p <= pdf.numPages && pictures.length < PICTURE_MAX_COUNT; p++) {
      const page = (await pdf.getPage(p)) as unknown as PdfJsPage;
      const ops = await withTimeout(page.getOperatorList(), READ_TIMEOUT_MS);
      for (let i = 0; i < ops.fnArray.length && pictures.length < PICTURE_MAX_COUNT; i++) {
        const fn = ops.fnArray[i];
        let img: DecodedImage | null = null;
        if (fn === OPS.paintImageXObject) img = await resolveObject(page, String(ops.argsArray[i][0]));
        else if (fn === OPS.paintInlineImageXObject) img = (ops.argsArray[i][0] as DecodedImage) ?? null;
        else continue;
        if (!img?.data || img.width * img.height < PICTURE_MIN_PIXELS) continue;

        const key = fingerprint(img);
        if (seen.has(key)) continue;
        const raster = toRaster(img);
        if (!raster) continue; // a layout we don't decode — not a picture we can offer
        seen.add(key);

        pictures.push({
          page: p,
          width: img.width,
          height: img.height,
          png: opts.rasterize ? encodePng(downscale(raster, PICTURE_MAX_EDGE)) : undefined,
        });
      }
      page.cleanup();
    }
    } catch {
      // keep what was found so far
    }

    return { pages: pdf.numPages, pageTexts: text, pictures, problem: null };
  } catch {
    return empty("unreadable", pdf.numPages);
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
}
