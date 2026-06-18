/**
 * MTP draft token limits — aligned with llama.cpp MTP bench guidance.
 * nMax=2 is the practical sweet spot on ~12GB GPUs; higher n often lowers tok/s.
 */

/** Recommended default (--spec-draft-n-max). */
export const MTP_DRAFT_NMAX_DEFAULT = 2

/** Hard cap for manual UI / saved config. */
export const MTP_DRAFT_NMAX_ABSOLUTE = 5

export const MTP_DRAFT_NMIN_DEFAULT = 0

/** Hard cap for n-min in UI. */
export const MTP_DRAFT_NMIN_ABSOLUTE = 2

export function clampMtpDraftLimits(
  nMax?: number,
  nMin?: number
): { nMax: number; nMin: number } {
  let max = Math.round(Number.isFinite(nMax) ? (nMax as number) : MTP_DRAFT_NMAX_DEFAULT)
  max = Math.max(1, Math.min(MTP_DRAFT_NMAX_ABSOLUTE, max))
  let min = Math.round(Number.isFinite(nMin) ? (nMin as number) : MTP_DRAFT_NMIN_DEFAULT)
  min = Math.max(0, Math.min(MTP_DRAFT_NMIN_ABSOLUTE, min))
  if (max > 1) min = Math.min(min, max - 1)
  return { nMax: max, nMin: min }
}
