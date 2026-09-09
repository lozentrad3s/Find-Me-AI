/**
 * Step 5 — confidence bands.
 *
 * Two numbers decide the band, and both are necessary:
 *
 *   score  — how well the best candidate explains the phrase
 *   margin — how much better it is than the runner-up
 *
 * Score alone is not enough. Three Buhari Streets in one city each score well
 * on name, area and prominence; the top one might hit 0.8. Acting on that
 * confidently is precisely the failure this product exists to prevent, and the
 * margin is what catches it — three near-identical scores means a margin near
 * zero, which is ambiguity no matter how high the top score is.
 *
 * The bands are deliberately conservative. In a safety product, a wrong
 * confident answer costs far more than an extra question.
 */

import type { BandDecision, ConfidenceBand, ScoredCandidate } from "./types";

export interface BandThresholds {
  /** Minimum top score to be considered at all. */
  floor: number;
  /** Top score needed for the high band. */
  highScore: number;
  /** Lead over the runner-up needed for the high band. */
  highMargin: number;
  /**
   * A lead this large is conclusive on its own.
   *
   * Requiring score AND margin together was too strict: a candidate scoring
   * 0.55 while everything else scores 0.08 is not a close call, it is the only
   * answer. Without this path the engine asked a question in cases where the
   * runner-up was not remotely plausible, which trains users to ignore the
   * questions that matter.
   */
  dominantMargin: number;
}

export const DEFAULT_THRESHOLDS: BandThresholds = {
  floor: 0.35,
  highScore: 0.62,
  highMargin: 0.12,
  dominantMargin: 0.3,
};

export function decideBand(
  ranked: ScoredCandidate[],
  thresholds: BandThresholds = DEFAULT_THRESHOLDS,
): BandDecision {
  const best = ranked[0];

  if (!best) {
    return {
      band: "low",
      margin: 0,
      rationale: "No candidates were found for this description.",
    };
  }

  const runnerUp = ranked[1];
  const margin = runnerUp ? best.score - runnerUp.score : 1;

  if (best.score < thresholds.floor) {
    return {
      band: "low",
      margin,
      rationale: `Best match scored ${fmt(best.score)}, below the ${fmt(
        thresholds.floor,
      )} floor — not enough in the description to identify a place.`,
    };
  }

  if (best.score >= thresholds.highScore && margin >= thresholds.highMargin) {
    return {
      band: "high",
      margin,
      rationale: `Clear winner at ${fmt(best.score)}, ahead of the next candidate by ${fmt(
        margin,
      )}.`,
    };
  }

  // Scored modestly, but nothing else comes close. That is not ambiguity.
  if (margin >= thresholds.dominantMargin) {
    return {
      band: "high",
      margin,
      rationale: `Only real candidate — leads the next by ${fmt(
        margin,
      )}, so the ${fmt(best.score)} score reflects a thin description rather than a close call.`,
    };
  }

  if (best.score >= thresholds.highScore) {
    return {
      band: "moderate",
      margin,
      rationale: `Top candidate scored well (${fmt(
        best.score,
      )}) but only leads by ${fmt(margin)} — several places fit this description equally.`,
    };
  }

  return {
    band: "moderate",
    margin,
    rationale: `Best match scored ${fmt(
      best.score,
    )} — plausible, but not certain enough to act on without confirming.`,
  };
}

/** UI copy for each band. Kept next to the thresholds that produce them. */
export const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: "Found it",
  moderate: "A few possibilities",
  low: "Need more detail",
};

export const BAND_MARKER: Record<ConfidenceBand, string> = {
  high: "🟢",
  moderate: "🟡",
  low: "🔴",
};

function fmt(value: number): string {
  return value.toFixed(2);
}
