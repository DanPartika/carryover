// One resolver for exercise images. The library mixes two image regimes:
// free-exercise-db rows carry absolute hotlinks, authored rows carry
// app-relative owned art ("/exercise-art/<key>.svg") that must be prefixed
// with the gateway base path ("" in dev, "/apps/carryover" in prod). Every
// <img src> for an exercise goes through here so no surface can forget.

import { withBase } from "@/lib/config/basePath";

export function imageSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith("/") ? withBase(src) : src;
}

/** Owned line art is a transparent 4:3 drawing — cropping it (object-cover)
 *  beheads the figure. Photos crop fine. Renderers pick their fit class here. */
export function isOwnedArt(src: string | null | undefined): boolean {
  return !!src && (src.startsWith("/") || src.includes("/exercise-art/"));
}

export function imageFitClass(src: string | null | undefined): string {
  return isOwnedArt(src) ? "h-full w-full object-contain p-1" : "h-full w-full object-cover";
}
