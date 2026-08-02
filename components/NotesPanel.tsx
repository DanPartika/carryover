"use client";

// PT-side notes (PRD build step 7). One stream: the PT's own notes — private
// unless deliberately shared — interleaved with the patient's journal.
//
// Every note states its audience on its face. A clinician glancing at a screen
// with the patient beside them must never have to remember which of these the
// patient can read.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

type Note = {
  id: string;
  body: string;
  shared: boolean;
  authorRole: "pt" | "patient";
  authorName: string | null;
  createdAt: string;
  mine: boolean;
};

export default function NotesPanel({
  episodeId,
  patientName,
}: {
  episodeId: string;
  patientName: string;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [shareIt, setShareIt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/notes?episodeId=${episodeId}`);
      if (!res.ok) {
        setError(`notes load failed (${res.status})`);
        return;
      }
      setError(null);
      setNotes(((await res.json()) as { notes: Note[] }).notes);
    } catch {
      setError("network error loading notes");
    }
  }, [episodeId]);

  useEffect(() => {
    // setState runs inside load() after an await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, body, shared: shareIt }),
      });
      if (!res.ok) {
        setError(`could not save the note (${res.status})`);
        return;
      }
      setDraft("");
      setShareIt(false);
      await load();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  async function toggleShared(n: Note) {
    setNotes((prev) =>
      prev ? prev.map((x) => (x.id === n.id ? { ...x, shared: !x.shared } : x)) : prev,
    );
    try {
      const res = await apiFetch(`/api/notes/${n.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared: !n.shared }),
      });
      if (!res.ok) await load();
    } catch {
      setError("network error — that change didn't save");
      await load();
    }
  }

  async function remove(id: string) {
    setNotes((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
    try {
      await apiFetch(`/api/notes/${id}`, { method: "DELETE" });
    } catch {
      setError("network error — that change didn't save");
      await load();
    }
  }

  const firstName = patientName.split(" ")[0];

  return (
    <section className="rounded-xl border border-edge bg-card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Notes</h2>

      <div className="mt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Clinical note — private to you unless you share it"
          className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={() => void add()}
            disabled={busy || !draft.trim()}
            className="rounded-lg bg-accent-deep px-4 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Add note"}
          </button>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={shareIt}
              onChange={(e) => setShareIt(e.target.checked)}
            />
            Share with {firstName}
          </label>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-flag">{error}</p>}

      {notes && notes.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          No notes yet. Anything {firstName} writes in their journal lands here too.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {notes?.map((n) => (
          <li
            key={n.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              n.authorRole === "patient" ? "bg-[var(--color-clinic)]/10" : "bg-raise/60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span className="font-medium text-ink">
                {n.authorRole === "patient" ? `${firstName}'s journal` : (n.authorName ?? "PT")}
              </span>
              <span>{new Date(n.createdAt).toLocaleString()}</span>
              {n.authorRole === "pt" && (
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    n.shared ? "bg-accent-deep text-white" : "border border-edge"
                  }`}
                >
                  {n.shared ? `shared with ${firstName}` : "private"}
                </span>
              )}
              {n.mine && (
                <span className="ml-auto flex gap-2">
                  {n.authorRole === "pt" && (
                    <button
                      onClick={() => void toggleShared(n)}
                      className="underline decoration-dotted hover:text-ink"
                    >
                      {n.shared ? "make private" : "share"}
                    </button>
                  )}
                  <button onClick={() => void remove(n.id)} className="hover:text-flag">
                    delete
                  </button>
                </span>
              )}
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
