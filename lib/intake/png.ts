// Turning the raw pixels a PDF holds into a PNG a model can be sent.
//
// PDF.js hands back decoded images as flat byte arrays in one of three layouts;
// to show one to the AI it has to become a real image file, small enough to
// travel (the platform's AI route takes at most 10 MB a request, and a model
// downsizes anything past ~1.5k pixels on a side anyway, so sending more only
// costs bytes). Pure functions over bytes — no canvas, no native code, so it
// works in the slim container the app ships in.

import { deflateSync } from "node:zlib";

/** Tightly packed 8-bit RGB, three bytes a pixel. */
export type Raster = { width: number; height: number; rgb: Uint8Array };

/** PDF.js's own numbering for decoded image data. */
export const KIND_GRAY_1BPP = 1;
export const KIND_RGB_24 = 2;
export const KIND_RGBA_32 = 3;

export type DecodedImage = { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray };

/** Decoded PDF image → RGB, or null for a layout we don't handle. Transparent
 *  pixels are flattened onto WHITE: left as-is they would encode as black and
 *  turn a dark-on-clear scan into a black rectangle. */
export function toRaster(img: DecodedImage): Raster | null {
  const { width, height, kind, data } = img;
  if (!(width > 0 && height > 0)) return null;
  const rgb = new Uint8Array(width * height * 3);

  if (kind === KIND_RGB_24) {
    if (data.length < width * height * 3) return null;
    rgb.set(data.subarray(0, width * height * 3));
    return { width, height, rgb };
  }

  if (kind === KIND_RGBA_32) {
    if (data.length < width * height * 4) return null;
    for (let i = 0, o = 0; i < width * height * 4; i += 4, o += 3) {
      const a = data[i + 3] / 255;
      rgb[o] = Math.round(data[i] * a + 255 * (1 - a));
      rgb[o + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
      rgb[o + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
    }
    return { width, height, rgb };
  }

  if (kind === KIND_GRAY_1BPP) {
    // One bit a pixel, each row padded to a whole byte; a set bit is white.
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 3;
        rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
      }
    }
    return { width, height, rgb };
  }

  return null;
}

/** Shrink so the longer side is at most `maxEdge`, averaging each block of
 *  source pixels (a box filter — text stays legible where plain subsampling
 *  would drop strokes). Returns the input untouched when it already fits. */
export function downscale(r: Raster, maxEdge: number): Raster {
  const longest = Math.max(r.width, r.height);
  if (longest <= maxEdge) return r;
  const scale = maxEdge / longest;
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * r.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * r.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * r.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * r.width) / w));
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * r.width + xx) * 3;
          sr += r.rgb[i];
          sg += r.rgb[i + 1];
          sb += r.rgb[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = Math.round(sr / n);
      out[o + 1] = Math.round(sg / n);
      out[o + 2] = Math.round(sb / n);
    }
  }
  return { width: w, height: h, rgb: out };
}

// CRC-32 (the PNG flavour), table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit RGB PNG. */
export function encodePng(r: Raster): Uint8Array {
  const stride = r.width * 3;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(r.rgb.buffer, r.rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
