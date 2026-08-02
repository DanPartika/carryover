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
