// The patient's view of a closed episode — pure shapes and functions, no server
// imports, so the PT's confirmation step can render EXACTLY what the patient
// will see before anything is published.
//
// An allowlist, built by picking fields: what a patient never gets is the
// adherence percent / expected sessions (a score is a verdict to someone
// reading their own record), pain (the pain slider starts at 0 and always
// posts, so an untouched slider logs "no pain" — an unreliable number to hand
// a patient as fact), flag counts, the check-in count, the "watch for" line
// (it exists to steer the PT's next draft), the intake, notes, and anything
// from plans.ai_note.

import type { ClosingContext, PlanSnapshot } from "./closing";

/** The counts a patient sees about their own closed episode. */
export type PatientStats = {
  daysInCare: number;
  daysLogged: number;
  sessionsLogged: number;
  visits: number;
  goals: { activity: string; baseline: number; current: number | null }[];
};

export function patientStats(c: ClosingContext): PatientStats {
  return {
    daysInCare: c.daysInCare,
    daysLogged: c.sessions.daysLogged,
    sessionsLogged: c.sessions.sessionsLogged,
    visits: c.visits.count,
    goals: (c.goals ?? []).map((g) => ({
      activity: g.activity,
      baseline: g.baseline,
      current: g.current,
    })),
  };
}

export type PatientPlanSnapshot = {
  approvedOn: string;
  items: { name: string; line: string; location: string }[];
};

export function patientPlan(p: PlanSnapshot): PatientPlanSnapshot {
  return {
    approvedOn: p.approvedOn,
    items: p.items.map((i) => ({ name: i.name, line: i.line, location: i.location })),
  };
}

/** What a patient sees of their own closed episode. */
export type PatientPastEpisode = {
  id: string;
  condition: string;
  openedOn: string;
  endedOn: string;
  closedByName: string | null;
  /** Closed within the PT's undo window. While true the app doesn't invite the
   *  patient to start something new — a curious tap would open a newer episode
   *  and make the undo impossible. */
  recent: boolean;
  summary: string;
  stats: PatientStats | null;
  finalPlan: PatientPlanSnapshot | null;
  /** Notes the PT chose to share with the patient during this episode — they
   *  stop appearing on Today when the episode closes, so they live here. */
  messages: { on: string; body: string }[];
};
