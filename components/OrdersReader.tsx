"use client";

// "Fill from the doctor's referral" — inside the PT's intake form.
//
// The PT picks the referral PDF (or one already attached to the patient) and
// the app reads it: the diagnosis, procedure, side, weight-bearing status,
// protocol, visits and start timing come out as a DRAFT beside the form. The PT
// ticks what to use and the form fills in; nothing is saved until they save the
// intake. Fields that already hold something stay untouched unless the PT ticks
// them to be replaced — a referral never silently overwrites the PT's own words.
//
// The text is read in the browser's request to our server, with no AI. If the
// file also holds pictures (a protocol sheet that is a flat image of a table),
// the PT is told, and can ask for them to be read — a separate, deliberate click
// that says plainly what leaves the server.

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { labelFor, PROVIDER_PLAN_MAX, REGION_OPTIONS } from "@/lib/intake/fields";
import type { OrdersFound, SuggestedFields } from "@/lib/intake/orders";

export type OrdersContext = { clinicId: string; patientUserId: string; episodeId: string | null };

export type FormSnapshot = {
  condition: string;
  side: string | null;
  regions: string[];
  onsetDate: string;
  surgeries: string;
  restrictions: string;
  providerPlan: string;
};

export type OrdersUpdate = Partial<{
  condition: string;
  side: string;
  bodyRegions: string[];
  onsetDate: string;
  surgeries: string;
  restrictions: string;
  providerPlan: string;
}>;

type Extracted = {
  kind: "pdf" | "text" | "image";
  label: string;
  found: OrdersFound | null;
  fields: SuggestedFields | null;
  hasContent: boolean;
  pictures: { count: number; pages: number[] };
  warnings: string[];
};

type Source = { kind: "file"; file: File } | { kind: "doc"; id: string; name: string };
type Attached = { id: string; filename: string; contentType: string };
type Key = "condition" | "side" | "bodyRegions" | "onsetDate" | "surgeries" | "restrictions" | "providerPlan" | "pictures";

const READABLE = new Set(["application/pdf", "text/plain", "image/png", "image/jpeg", "image/webp"]);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pagesLabel = (pages: number[]) =>
  pages.length === 0 ? "" : pages.length === 1 ? ` (page ${pages[0]})` : ` (pages ${pages.join(", ")})`;

async function problem(res: Response): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? `couldn't read that (${res.status})`;
}

export default function OrdersReader({
  ctx,
  current,
  onApply,
}: {
  ctx: OrdersContext;
  current: FormSnapshot;
  onApply: (update: OrdersUpdate) => void;
}) {
  const [attached, setAttached] = useState<Attached[]>([]);
  const [src, setSrc] = useState<Source | null>(null);
  const [busy, setBusy] = useState<"text" | "pictures" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extracted | null>(null);
  const [picked, setPicked] = useState<Partial<Record<Key, boolean>>>({});
  const [consenting, setConsenting] = useState(false);
  const [pictures, setPictures] = useState<{ ok: boolean; block?: string; reason?: string; pages: number[] } | null>(null);
  const [done, setDone] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  // Files already attached to this patient's episode, offered as sources.
  useEffect(() => {
    if (!ctx.episodeId) return;
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/episodes/${ctx.episodeId}/documents`);
        if (!res.ok || !alive) return;
        const d = (await res.json()) as { documents: Attached[] };
        setAttached(d.documents.filter((x) => READABLE.has(x.contentType)));
      } catch {
        // The picker still works without the list.
      }
    })();
    return () => {
      alive = false;
    };
  }, [ctx.episodeId]);

  function form(source: Source, extra: Record<string, string> = {}): FormData {
    const fd = new FormData();
    fd.append("clinicId", ctx.clinicId);
    fd.append("patientUserId", ctx.patientUserId);
    if (source.kind === "file") fd.append("file", source.file);
    else fd.append("documentId", source.id);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }

  // What each field would change, so the PT can see it before agreeing.
  const proposals = (r: Extracted) => {
    const f = r.fields;
    if (!f) return [];
    const regionNow = current.regions.join(",");
    const rows: { key: Key; label: string; value: string; now: string; take: boolean }[] = [];
    const add = (key: Key, label: string, value: string | null, now: string, same = value === now) => {
      if (value) rows.push({ key, label, value, now, take: !now.trim() && !same });
    };
    add("condition", "Condition", f.condition, current.condition);
    add("side", "Side", f.side ? cap(f.side) : null, current.side ? cap(current.side) : "");
    add(
      "bodyRegions",
      "Region",
      f.bodyRegions.length ? f.bodyRegions.map((x) => labelFor(REGION_OPTIONS, x)).join(", ") : null,
      current.regions.map((x) => labelFor(REGION_OPTIONS, x)).join(", "),
      f.bodyRegions.join(",") === regionNow,
    );
    add("onsetDate", "Surgery / onset date", f.onsetDate, current.onsetDate);
    add("surgeries", "Surgical history", f.surgeries, current.surgeries);
    add("restrictions", "Restrictions", f.restrictions, current.restrictions);
    return rows;
  };

  async function read(source: Source) {
    setBusy("text");
    setError(null);
    setResult(null);
    setPictures(null);
    setConsenting(false);
    setDone(false);
    setSrc(source);
    try {
      const res = await apiFetch("/api/intakes/extract", { method: "POST", body: form(source) });
      if (!res.ok) {
        setError(await problem(res));
        return;
      }
      const r = (await res.json()) as Extracted;
      setResult(r);
      const take: Partial<Record<Key, boolean>> = {};
      for (const row of proposals(r)) take[row.key] = row.take;
      take.providerPlan = true; // appended, never replacing what's there
      setPicked(take);
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  async function readPictures() {
    if (!src) return;
    setBusy("pictures");
    setError(null);
    setConsenting(false);
    try {
      const res = await apiFetch("/api/intakes/read-pictures", {
        method: "POST",
        body: form(src, { confirm: "yes" }),
      });
      if (!res.ok) {
        setError(await problem(res));
        return;
      }
      const d = (await res.json()) as { ok: boolean; block?: string; reason?: string; pages: number[] };
      setPictures(d);
      if (d.ok) setPicked((p) => ({ ...p, pictures: true }));
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(null);
    }
  }

  function apply() {
    if (!result) return;
    const u: OrdersUpdate = {};
    const f = result.fields;
    if (f) {
      if (picked.condition && f.condition) u.condition = f.condition;
      if (picked.side && f.side) u.side = f.side;
      if (picked.bodyRegions && f.bodyRegions.length) u.bodyRegions = f.bodyRegions;
      if (picked.onsetDate && f.onsetDate) u.onsetDate = f.onsetDate;
      if (picked.surgeries && f.surgeries) u.surgeries = f.surgeries;
      if (picked.restrictions && f.restrictions) u.restrictions = f.restrictions;
    }
    const blocks = [
      picked.providerPlan && f?.providerPlan ? f.providerPlan : null,
      picked.pictures && pictures?.ok && pictures.block ? pictures.block : null,
    ].filter((b): b is string => !!b && !current.providerPlan.includes(b));
    if (blocks.length) {
      u.providerPlan = [current.providerPlan.trim(), ...blocks].filter(Boolean).join("\n\n");
      if (u.providerPlan.length > PROVIDER_PLAN_MAX) {
        setError(
          `That would make the doctor's-plan box longer than its ${PROVIDER_PLAN_MAX.toLocaleString()}-character limit, and the end would be lost. Untick one of the blocks, or shorten what's already there.`,
        );
        return;
      }
    }
    onApply(u);
    setDone(true);
    setResult(null);
    setPictures(null);
    setSrc(null);
  }

  const rows = result ? proposals(result) : [];
  const nothingChecked =
    !rows.some((r) => picked[r.key]) &&
    !(picked.providerPlan && result?.fields) &&
    !(picked.pictures && pictures?.ok);
  const hasPictures = !!result && result.pictures.count > 0;

  return (
    <div className="rounded-lg border border-dashed border-edge bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-xs text-muted">
          Have the doctor&apos;s referral as a PDF? Read it and the form fills itself in — you check
          it before anything is saved.
        </p>
        <input
          ref={picker}
          type="file"
          accept=".pdf,.txt,.png,.jpg,.jpeg,.webp"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose a referral to read"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void read({ kind: "file", file });
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={busy !== null}
          className="rounded-full border border-edge px-3 py-1 text-xs font-medium text-accent-deep hover:bg-raise disabled:opacity-40"
        >
          {busy === "text" ? "Reading…" : "Read a referral…"}
        </button>
        {attached.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => void read({ kind: "doc", id: d.id, name: d.filename })}
            disabled={busy !== null}
            className="max-w-48 truncate rounded-full border border-edge px-2.5 py-1 text-xs text-muted hover:bg-raise disabled:opacity-40"
            title={`Read the attached file ${d.filename}`}
          >
            Use attached: {d.filename}
          </button>
        ))}
      </div>

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}
      {done && !result && (
        <p className="mt-2 text-xs text-muted" role="status">
          Filled in — read through the fields below. Nothing is saved until you save the intake.
        </p>
      )}

      {result && (
        <div className="mt-3 space-y-2.5 border-t border-edge pt-3 text-sm">
          <p className="text-xs text-muted">
            Read <span className="font-medium text-ink">{result.label}</span> — a draft for you to
            check against the page.
          </p>

          {result.warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-raise/60 px-3 py-2 text-xs">
              {result.warnings.map((w) => (
                <li key={w}>⚑ {w}</li>
              ))}
            </ul>
          )}

          {rows.map((row) => (
            <label key={row.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!picked[row.key]}
                onChange={(e) => setPicked((p) => ({ ...p, [row.key]: e.target.checked }))}
              />
              <span className="min-w-0">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">{row.label}</span>
                <span className="block break-words">{row.value}</span>
                {row.now.trim() && row.now !== row.value && (
                  <span className="block text-xs text-muted">
                    now: {row.now.length > 90 ? `${row.now.slice(0, 90)}…` : row.now} — tick to replace
                  </span>
                )}
              </span>
            </label>
          ))}

          {result.fields && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!picked.providerPlan}
                onChange={(e) => setPicked((p) => ({ ...p, providerPlan: e.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Doctor&apos;s plan (added to the box below)
                </span>
                <span className="mt-1 block max-h-44 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-raise/40 p-2 text-xs">
                  {result.fields.providerPlan}
                </span>
              </span>
            </label>
          )}

          {hasPictures && !pictures && (
            <div className="rounded-lg border border-edge px-3 py-2">
              <p className="text-xs">
                This file also holds{" "}
                {result.pictures.count === 1 ? "a picture" : `${result.pictures.count} pictures`}
                {pagesLabel(result.pictures.pages)}{" "}
                the text reader can&apos;t see — often a protocol table.
              </p>
              {!consenting ? (
                <button
                  type="button"
                  onClick={() => setConsenting(true)}
                  disabled={busy !== null}
                  className="mt-1.5 rounded-full border border-edge px-3 py-1 text-xs font-medium text-accent-deep hover:bg-raise disabled:opacity-40"
                >
                  Read {result.pictures.count === 1 ? "the picture" : "the pictures"} with AI…
                </button>
              ) : (
                <div className="mt-2 space-y-2 text-xs">
                  <p>
                    This sends {result.pictures.count === 1 ? "the picture" : "the pictures"} from
                    this file to the AI to be transcribed. It does <span className="font-semibold">not</span>{" "}
                    send the PDF&apos;s text or the file name — but a picture of a whole form shows
                    the AI whatever is printed on it, and that can&apos;t be removed first. Only
                    do this for pages like a protocol table. You&apos;ll check what comes back.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void readPictures()}
                      disabled={busy !== null}
                      className="rounded-lg bg-accent-deep px-3 py-1.5 font-semibold text-white hover:brightness-110 disabled:opacity-40"
                    >
                      {busy === "pictures" ? "Reading…" : "Send to the AI"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConsenting(false)}
                      className="rounded-lg border border-edge px-3 py-1.5 text-muted hover:bg-raise"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {busy === "pictures" && !pictures && <p className="text-xs text-muted">Reading the picture…</p>}

          {pictures && !pictures.ok && (
            <p className="rounded-lg bg-raise/60 px-3 py-2 text-xs">
              ⚑ The picture couldn&apos;t be read: {pictures.reason}. Paste the part you need into the
              box below instead.
            </p>
          )}

          {pictures?.ok && pictures.block && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!picked.pictures}
                onChange={(e) => setPicked((p) => ({ ...p, pictures: e.target.checked }))}
              />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Read from the picture{pagesLabel(pictures.pages)} — added to the box below
                </span>
                <span className="block text-xs text-muted">
                  Transcribed by AI. Check it against the page before relying on it.
                </span>
                <span className="mt-1 block max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-raise/40 p-2 text-xs">
                  {pictures.block}
                </span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={apply}
              disabled={nothingChecked}
              className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              Fill the form with what&apos;s ticked
            </button>
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setPictures(null);
                setSrc(null);
                setConsenting(false);
              }}
              className="rounded-lg border border-edge px-4 py-1.5 text-sm text-muted hover:bg-raise"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
