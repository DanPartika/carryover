"use client";

// The waiting-room clipboard, at home. Shown on the patient's Today only
// while there's no active plan: fill it before the first visit so the PT
// spends the session probing instead of transcribing. After the PT reviews
// (or once a plan is live) this surface steps aside — later changes go
// through the raise-a-hand check-in, not intake edits.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import IntakeForm, { type IntakePayload } from "@/components/IntakeForm";
import type { IntakeRecord } from "@/lib/intake/fields";

type State = "no_clinic" | "none" | "submitted" | "reviewed" | "planned";

type Data = { state: State; intake: IntakeRecord | null; birthYear: number | null };

export default function PatientIntake() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false); // form expanded (fresh or editing)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/me/intake");
      if (res.ok) setData((await res.json()) as Data);
    } catch {
      // Silence — Today still works without this card.
    }
  }, []);

  useEffect(() => {
    // setState happens inside load() after the await, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function submit(payload: IntakePayload) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/me/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? "couldn't save that — try again");
        return;
      }
      setOpen(false);
      await load();
    } catch {
      setError("network error — try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data || data.state === "no_clinic" || data.state === "planned") return null;

  if (data.state === "reviewed") {
    return (
      <section className="rounded-xl border border-edge bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your intake</h2>
        <p className="mt-1 text-sm text-muted">
          On file with your PT — they&apos;ve reviewed it. Anything new to add? Mention it in
          your journal below.
        </p>
      </section>
    );
  }

  if (open) {
    return (
      <section className="rounded-xl border border-accent bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Before your first visit
        </h2>
        <p className="mt-1 text-sm text-muted">
          The first session is mostly questions — answer what you can here, at your own
          pace, and your PT can spend the visit on you instead of a clipboard. Skip
          anything you&apos;re unsure about.
        </p>
        {error && <p className="mt-2 text-sm text-flag">{error}</p>}
        <IntakeForm
          persona="patient"
          initial={data.intake}
          initialBirthYear={data.birthYear}
          busy={busy}
          submitLabel="Send to my PT"
          onSubmit={(p) => void submit(p)}
          onCancel={() => setOpen(false)}
        />
      </section>
    );
  }

  if (data.state === "submitted") {
    // Sent, PT hasn't reviewed yet — still the patient's to amend.
    return (
      <section className="rounded-xl border border-edge bg-card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your intake</h2>
        <p className="mt-1 text-sm">
          Sent to your PT on {new Date(data.intake!.createdAt).toLocaleDateString()}.
          They&apos;ll go over it with you at your first visit.
        </p>
        <button
          onClick={() => setOpen(true)}
          className="mt-2 rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:bg-raise"
        >
          Add or change something
        </button>
      </section>
    );
  }

  // state === "none" — invite, don't ambush Today with a nine-section form.
  return (
    <section className="rounded-xl border border-accent bg-card p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        Before your first visit
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your PT will start by asking a lot of questions. Answer them here first — from
        your couch, at your own pace — and the first visit gets to be about you.
      </p>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-lg bg-accent-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
      >
        Fill it in now
      </button>
    </section>
  );
}
