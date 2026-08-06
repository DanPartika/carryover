// One place that knows how a prescription reads, so the PT's editor, the
// patient's logger, the visit list, and the read-only plan can never describe
// the same item three different ways.

export type DosageType = "reps" | "hold" | "time";

export type Dosed = {
  dosageType?: DosageType | null;
  sets: number | null;
  reps: number | null;
  holdSecs: number | null;
  durationMins?: number | null;
  intensity?: string | null;
};

/** Fall back to inspecting the numbers when an older row predates
 *  exercises.dosage_type, so nothing renders blank during a rollout. */
export function dosageTypeOf(it: Dosed): DosageType {
  if (it.dosageType) return it.dosageType;
  if (it.durationMins) return "time";
  if (it.holdSecs) return "hold";
  return "reps";
}

/** "3×10", "3 × 20s hold", "10 min · level 2" — the dosage alone, no frequency. */
export function dosageText(it: Dosed): string {
  switch (dosageTypeOf(it)) {
    case "time": {
      const parts = [it.durationMins ? `${it.durationMins} min` : null, it.intensity || null];
      return parts.filter(Boolean).join(" · ") || "as directed";
    }
    case "hold": {
      const hold = it.holdSecs ? `${it.holdSecs}s hold` : "hold";
      return it.sets ? `${it.sets} × ${hold}` : hold;
    }
    default: {
      if (it.sets && it.reps) return `${it.sets}×${it.reps}`;
      if (it.reps) return `${it.reps} reps`;
      if (it.sets) return `${it.sets} sets`;
      return "as directed";
    }
  }
}

/** The full line a patient reads: dosage plus how often. */
export function dosageLine(it: Dosed & { frequencyPerWeek: number }): string {
  const perWeek = it.frequencyPerWeek === 7 ? "daily" : `${it.frequencyPerWeek}/wk`;
  return `${dosageText(it)} · ${perWeek}`;
}

/** What the patient actually logged for one session. */
export type Done = {
  setsDone: number | null;
  repsDone: number | null;
  durationDoneMins: number | null;
};

/** The performed side of "3×10 → 3×8", rendered in the SAME shape as the
 *  prescription so the PT is comparing like with like. A held item records
 *  sets but not seconds — the logger never asks — so it says so rather than
 *  inventing a duration. */
export function doneText(type: DosageType, d: Done): string {
  switch (type) {
    case "time":
      return d.durationDoneMins ? `${d.durationDoneMins} min` : "marked done";
    case "hold":
      return d.setsDone ? `${d.setsDone} sets` : "marked done";
    default: {
      if (d.setsDone && d.repsDone) return `${d.setsDone}×${d.repsDone}`;
      if (d.repsDone) return `${d.repsDone} reps`;
      if (d.setsDone) return `${d.setsDone} sets`;
      return "marked done";
    }
  }
}

/** Did the session reach what was asked for? Null when there is nothing to
 *  compare — an unprescribed care log, or a session logged with no numbers.
 *  Arithmetic only: whether falling short matters is the PT's read. */
export function metPrescription(type: DosageType, rx: Dosed | null, d: Done): boolean | null {
  if (!rx) return null;
  if (type === "time") {
    if (!rx.durationMins || d.durationDoneMins === null) return null;
    return d.durationDoneMins >= rx.durationMins;
  }
  if (type === "hold") {
    if (!rx.sets || d.setsDone === null) return null;
    return d.setsDone >= rx.sets;
  }
  // Volume, not sets-and-reps separately: 2×15 covers a prescribed 3×10.
  const want = (rx.sets ?? 0) * (rx.reps ?? 0);
  const got = (d.setsDone ?? 0) * (d.repsDone ?? 0);
  if (!want || !got) return null;
  return got >= want;
}
