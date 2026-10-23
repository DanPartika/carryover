// Where an "extract the orders" request gets its file from, and who may ask.
//
// Two ways in, one set of rules: the PT picks a file from their computer (the
// bytes are read and dropped — nothing is stored), or points at a file already
// attached to the patient's episode. Either way the caller must be a PT or admin
// of the clinic, and for a stored file must actually treat that patient. The
// patient's own name parts come back so the caller can scrub them from the text
// before parsing — and so a file called "Jordan_Example_referral.pdf" stays a
// label for the PT's screen and never reaches a model.

import { NextResponse } from "next/server";
import type { Pool } from "pg";
import { canManage, rolesInClinic } from "@/lib/auth/roles";
import { canTreat } from "@/lib/auth/treatment";
import { UUID_RE } from "@/lib/review/goal-http";
import { cleanFilename, MAX_DOC_BYTES, megabytes, sniffDocument } from "./documents";

export type OrdersSource = {
  bytes: Uint8Array;
  kind: "pdf" | "text" | "image";
  mime: string;
  /** The patient's name parts, for scrubbing. Empty when the patient is unknown. */
  names: string[];
  /** For the PT's own screen only. Never sent anywhere. */
  label: string;
};

const fail = (error: string, status: number) =>
  ({ response: NextResponse.json({ error }, { status }) }) as const;

const KIND: Record<string, OrdersSource["kind"] | undefined> = {
  "application/pdf": "pdf",
  "text/plain": "text",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

async function patientNames(pool: Pool, patientUserId: string): Promise<string[]> {
  const {
    rows: [u],
  } = await pool.query<{ display_name: string | null; email: string | null }>(
    "SELECT display_name, email FROM users WHERE id = $1",
    [patientUserId],
  );
  return [...(u?.display_name ?? "").split(/\s+/), (u?.email ?? "").split("@")[0]].filter(Boolean);
}

export async function loadOrdersSource(
  pool: Pool,
  userId: string,
  form: FormData,
): Promise<{ source: OrdersSource } | { response: NextResponse }> {
  const clinicId = form.get("clinicId");
  if (typeof clinicId !== "string" || !UUID_RE.test(clinicId)) return fail("clinicId required", 400);
  if (!canManage(await rolesInClinic(pool, userId, clinicId))) return fail("forbidden", 403);

  const patientRaw = form.get("patientUserId");
  const patientUserId = typeof patientRaw === "string" && UUID_RE.test(patientRaw) ? patientRaw : null;
  if (patientUserId && !(await canTreat(pool, userId, patientUserId, clinicId))) {
    return fail("forbidden", 403);
  }

  // A file already attached to the episode.
  const docRaw = form.get("documentId");
  if (typeof docRaw === "string" && docRaw) {
    if (!UUID_RE.test(docRaw)) return fail("not found", 404);
    const {
      rows: [doc],
    } = await pool.query<{
      episode_id: string;
      filename: string;
      content_type: string;
      data: Buffer | null;
      removed_at: Date | null;
      patient_user_id: string;
      clinic_id: string;
    }>(
      `SELECT d.episode_id, d.filename, d.content_type, d.data, d.removed_at,
              e.patient_user_id, e.clinic_id
       FROM intake_documents d JOIN episodes e ON e.id = d.episode_id
       WHERE d.id = $1`,
      [docRaw],
    );
    if (
      !doc ||
      doc.removed_at ||
      !doc.data ||
      doc.clinic_id !== clinicId ||
      (patientUserId && doc.patient_user_id !== patientUserId) ||
      !(await canTreat(pool, userId, doc.patient_user_id, doc.clinic_id))
    ) {
      return fail("not found", 404);
    }
    const kind = KIND[doc.content_type];
    if (!kind) return fail("that kind of file can't be read here — save it as a PDF, or paste the text", 415);
    return {
      source: {
        bytes: new Uint8Array(doc.data),
        kind,
        mime: doc.content_type,
        names: await patientNames(pool, doc.patient_user_id),
        label: doc.filename,
      },
    };
  }

  // A file chosen from the PT's computer: read, used, dropped.
  const file = form.get("file");
  if (!(file instanceof File)) return fail("choose a file to read", 400);
  if (file.size > MAX_DOC_BYTES) {
    return fail(`that file is too large — the limit is ${megabytes(MAX_DOC_BYTES)}`, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = cleanFilename(file.name);
  const type = sniffDocument(bytes, filename);
  const kind = type ? KIND[type.mime] : undefined;
  if (!type || !kind) {
    return fail(
      type
        ? "that kind of file can't be read here — save it as a PDF, or paste the text"
        : "that kind of file can't be read — use a PDF, a text file, or a photo",
      415,
    );
  }
  return {
    source: {
      bytes,
      kind,
      mime: type.mime,
      names: patientUserId ? await patientNames(pool, patientUserId) : [],
      label: filename,
    },
  };
}

/** A multipart body is refused up front when its declared size is plainly over
 *  the file limit, before any of it is buffered. */
export function tooLargeToRead(req: Request): boolean {
  const declared = Number(req.headers.get("content-length"));
  return Number.isFinite(declared) && declared > MAX_DOC_BYTES + 256 * 1024;
}
