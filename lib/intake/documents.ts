// Files attached to an episode — a doctor's plan, a referral, a protocol, an
// imaging report, a photo of the paper someone was handed.
//
// Two rules shape everything here:
//   * What a file IS is decided by its bytes, never by the name or the type the
//     browser claimed. These are served back to other people from our own
//     origin, so an "image" that is really HTML must never be stored as one.
//   * The AI never reads a file. A scan can't be de-identified (the patient's
//     name is baked into the pixels), so only the pasted text field — which
//     goes through redaction — reaches a model. The PT reads files themselves.

export const MAX_DOC_BYTES = 8 * 1024 * 1024;
export const MAX_DOCS_PER_EPISODE = 6;
export const MAX_DOC_BYTES_PER_EPISODE = 24 * 1024 * 1024;

export type DocType = {
  /** The Content-Type we store and serve — chosen by us, from the bytes. */
  mime: string;
  label: string;
};

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What the file picker is told to offer. The server re-checks every upload. */
export const DOC_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.docx,.txt";

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "heif"]);

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  return b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
}

/** True for text we are willing to store as text/plain: valid UTF-8, no NULs. */
function looksLikeText(b: Uint8Array): boolean {
  const head = b.subarray(0, Math.min(b.length, 64 * 1024));
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    // A multi-byte character cut by the 64 KB window is fine; anything else isn't.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - 3));
      return true;
    } catch {
      return false;
    }
  }
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** Identify an upload from its bytes. Null means "not a kind of file we keep". */
export function sniffDocument(bytes: Uint8Array, filename: string): DocType | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: "application/pdf", label: "PDF" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", label: "Image" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", label: "Image" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { mime: "image/webp", label: "Image" };
  if (ascii(bytes, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 12))) {
    return { mime: "image/heic", label: "Image" };
  }
  // A .docx is a zip; a zip alone proves nothing, so the name has to agree too.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && extOf(filename) === "docx") {
    return { mime: DOCX, label: "Word document" };
  }
  if (looksLikeText(bytes) && ["txt", "text", "md"].includes(extOf(filename))) {
    return { mime: "text/plain", label: "Text" };
  }
  return null;
}

const EXT_FOR: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "text/plain": "txt",
  [DOCX]: "docx",
};

/** The stored name's extension must agree with what the file IS. The client
 *  saves a download under this name, so "update.exe" holding a PDF must not
 *  come back as update.exe. */
export function withExtension(filename: string, mime: string): string {
  const want = EXT_FOR[mime];
  if (!want) return filename;
  const have = extOf(filename);
  const same =
    have === want ||
    (want === "jpg" && have === "jpeg") ||
    (want === "txt" && (have === "text" || have === "md"));
  if (same) return filename;
  const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "document";
  return `${stem}.${want}`;
}

/** A name safe to store and to put in a Content-Disposition header: no path, no
 *  control characters or quotes, capped, never empty. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "document";
  if (cleaned.length <= 120) return cleaned;
  const ext = extOf(cleaned);
  const stem = cleaned.slice(0, cleaned.length - (ext ? ext.length + 1 : 0));
  return `${stem.slice(0, 115 - ext.length)}${ext ? `.${ext}` : ""}`;
}

/** Content-Disposition for a download: ASCII fallback plus the real name. */
export function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** A limit, in the units people think of limits in: "8.0 MB". */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file's own size, readable at any scale — a one-page referral is KB, not "0.00 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return megabytes(bytes);
}
