"use client";

// Files attached to an episode: a doctor's plan, a referral, a protocol, a photo
// of the paper someone was handed. Attach, download, remove — nothing more.
//
// Two audiences, two promises (and the server enforces both, this just says
// them): the PT sees every file and is told the AI does not read them; the
// patient sees only what they attached themselves.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { DOC_ACCEPT, fileSize, MAX_DOC_BYTES, megabytes } from "@/lib/intake/documents";

type Doc = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploaderRole: "patient" | "pt";
  mine: boolean;
  uploaderName: string | null;
  createdAt: string;
};

const KIND: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "Image",
  "image/jpeg": "Image",
  "image/webp": "Image",
  "image/heic": "Image",
  "text/plain": "Text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
};

async function problem(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `couldn't do that (${res.status})`;
}

export default function IntakeDocuments({
  episodeId,
  viewer,
  heading = "Doctor's plan & other files",
  card = false,
}: {
  episodeId: string;
  viewer: "pt" | "patient";
  heading?: string;
  /** Standalone card (the patient's Today) rather than a box inside another panel. */
  card?: boolean;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [maxFiles, setMaxFiles] = useState(6);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/episodes/${episodeId}/documents`);
      if (!res.ok) {
        setError(await problem(res));
        return;
      }
      const d = (await res.json()) as {
        documents: Doc[];
        canEdit: boolean;
        limits: { maxFiles: number };
      };
      setDocs(d.documents);
      setCanEdit(d.canEdit);
      setMaxFiles(d.limits.maxFiles);
    } catch {
      setError("network error — reload to see the files");
    }
  }, [episodeId]);

  useEffect(() => {
    // setState happens inside load() after the await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_DOC_BYTES) {
          setError(`${file.name} is too large — the limit is ${megabytes(MAX_DOC_BYTES)}`);
          break;
        }
        // No Content-Type header: the browser adds the multipart boundary.
        const body = new FormData();
        body.append("file", file);
        const res = await apiFetch(`/api/episodes/${episodeId}/documents`, { method: "POST", body });
        if (!res.ok) {
          setError(await problem(res));
          break;
        }
      }
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
      await load();
    }
  }

  async function download(d: Doc) {
    setError(null);
    try {
      // The route needs the bearer token, which a plain link can't send — fetch
      // the bytes and hand the browser a local file.
      const res = await apiFetch(`/api/documents/${d.id}`);
      if (!res.ok) {
        setError(await problem(res));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = d.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError("network error — try again");
    }
  }

  async function remove(d: Doc) {
    setError(null);
    try {
      const res = await apiFetch(`/api/documents/${d.id}`, { method: "DELETE" });
      if (!res.ok) setError(await problem(res));
    } catch {
      setError("network error — try again");
    } finally {
      setRemoving(null);
      await load();
    }
  }

  if (docs === null && !error) return card ? null : <p className="mt-3 text-xs text-muted">Loading files…</p>;
  // Nothing attached and nothing can be: a closed episode with no files has no
  // reason to show an empty box.
  if (docs && docs.length === 0 && !canEdit) return null;

  const who = (d: Doc) =>
    viewer === "patient" || d.mine
      ? "you"
      : d.uploaderRole === "patient"
        ? `${d.uploaderName ?? "the patient"} (patient)`
        : (d.uploaderName ?? "the clinic");

  return (
    <div
      className={card ? "rounded-xl border border-edge bg-card p-4" : "mt-3 rounded-lg border border-edge p-3"}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{heading}</h3>
      <p className="mt-1 text-xs text-muted">
        {viewer === "pt"
          ? "A referral, protocol or order sheet from the doctor. Files stay with this episode for the care team — the AI draft does not read them, so paste the orders you want it to follow into the doctor's-plan box in the intake."
          : "Have a plan, referral or protocol from your doctor on paper or as a PDF? Attach it here. Only you and your PT can see it — your PT may have an AI read a picture of it to help fill in your record."}
      </p>

      {docs && docs.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {docs.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-raise/60 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0">
                <button
                  type="button"
                  onClick={() => void download(d)}
                  className="max-w-full truncate text-left font-medium text-accent-deep underline"
                  title="Download"
                >
                  {d.filename}
                </button>
                <span className="ml-2 text-xs text-muted">
                  {KIND[d.contentType] ?? "File"} · {fileSize(d.sizeBytes)} · added by {who(d)} on{" "}
                  {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </span>
              {canEdit &&
                (removing === d.id ? (
                  <span className="text-xs text-muted">
                    Remove it?{" "}
                    <button
                      type="button"
                      onClick={() => void remove(d)}
                      className="font-semibold text-flag underline"
                    >
                      yes
                    </button>{" "}
                    ·{" "}
                    <button type="button" onClick={() => setRemoving(null)} className="underline">
                      no
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRemoving(d.id)}
                    className="text-xs text-muted underline hover:text-flag"
                  >
                    remove
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {docs && docs.length === 0 && <p className="mt-2 text-xs text-muted">Nothing attached yet.</p>}

      {canEdit && (
        <div className="mt-2">
          <input
            ref={picker}
            type="file"
            multiple
            accept={DOC_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label="Attach a file"
            onChange={(e) => void upload(e.target.files)}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={busy || (docs?.length ?? 0) >= maxFiles}
            className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:bg-raise disabled:opacity-40"
          >
            {busy ? "Attaching…" : "＋ Attach a file"}
          </button>
          <span className="ml-2 text-xs text-muted">
            PDF, photo, Word or text · up to {megabytes(MAX_DOC_BYTES)} each · {maxFiles} files
          </span>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
    </div>
  );
}
