/**
 * Grading.
 *
 * Three outcomes, not two. The distinction between `soft` and `fail` matters
 * enormously for a location product:
 *
 *   pass — right place, and the engine was appropriately sure about it
 *   soft — right place at the top, but the engine asked instead of committing.
 *          A friction cost. The user gets there in one extra tap.
 *   fail — wrong place, or confidently wrong, or refused to answer something
 *          it should have resolved.
 *
 * The headline number is the strict pass rate, because that is what the exit
 * test in Part VIII asks for. But an engine at 60% pass / 30% soft is in a
 * completely different position from one at 60% pass / 30% fail, and a single
 * percentage would hide that.
 */

import { distanceMetres } from "@/lib/geo/distance";
import { ALL_FIXTURES } from "@/lib/providers/mock/fixtures";
import type { ResolutionResult, ScoredCandidate } from "@/lib/resolution/types";
import type { CorpusCase } from "@/lib/corpus/types";

export type Outcome = "pass" | "soft" | "fail";

/**
 * Correctness is geographic, not identity-based.
 *
 * Matching on placeId looks tidier but is wrong: a geocoder result has no
 * Places id at all, so a correct point arriving from the geocoding source
 * would be graded as a miss. What the user cares about is whether the pin
 * landed on the right building, so that is what gets measured.
 *
 * 120 m is roughly "same building or its immediate neighbour" at the density
 * these fixtures describe.
 */
const CORRECT_WITHIN_M = 120;

const FIXTURE_POINTS = new Map(
  ALL_FIXTURES.map((place) => [place.placeId, place.point] as const),
);

function matches(candidate: ScoredCandidate | null, placeId: string): boolean {
  if (!candidate) return false;
  if (candidate.candidate.placeId === placeId) return true;

  const expected = FIXTURE_POINTS.get(placeId);
  if (!expected) return false;

  return distanceMetres(expected, candidate.candidate.point) <= CORRECT_WITHIN_M;
}

export interface GradedCase {
  case: CorpusCase;
  result: ResolutionResult;
  outcome: Outcome;
  /** One line explaining the grade, shown for anything that is not a pass. */
  note: string;
}

/** How far down the ranking an expected answer may appear for an "asks" case. */
const SHORTLIST_DEPTH = 5;

export function grade(
  corpusCase: CorpusCase,
  result: ResolutionResult,
): GradedCase {
  const graded = (outcome: Outcome, note: string): GradedCase => ({
    case: corpusCase,
    result,
    outcome,
    note,
  });

  const topPlaceId = result.best?.candidate.placeId;
  const topName = result.best?.candidate.name ?? "nothing";

  switch (corpusCase.expect.kind) {
    case "resolves": {
      const wanted = corpusCase.expect.placeId;

      if (result.band.band === "low") {
        return graded(
          "fail",
          `Declined, but this should resolve to ${wanted}. Best available was ${topName}.`,
        );
      }

      if (!matches(result.best, wanted)) {
        return graded(
          "fail",
          `Resolved to ${topPlaceId ?? "an unidentified point"} (${topName}), expected ${wanted}.`,
        );
      }

      if (result.band.band === "moderate") {
        return graded(
          "soft",
          `Correct answer on top, but banded moderate (margin ${result.band.margin.toFixed(
            2,
          )}) so the user gets a question instead of an answer.`,
        );
      }

      return graded("pass", "");
    }

    case "asks": {
      if (result.band.band === "high") {
        return graded(
          "fail",
          `Committed confidently to ${topName}, but this phrase is genuinely ambiguous — it should have asked.`,
        );
      }

      if (result.band.band === "low") {
        return graded(
          "fail",
          "Declined outright, but there were real candidates worth asking about.",
        );
      }

      if (!result.question) {
        return graded(
          "fail",
          "Banded moderate but produced no question, so the user is left with nothing to act on.",
        );
      }

      const shortlist = result.ranked.slice(0, SHORTLIST_DEPTH);

      const missing = corpusCase.expect.mustIncludePlaceIds.filter(
        (id) => !shortlist.some((entry) => matches(entry, id)),
      );

      if (missing.length > 0) {
        return graded(
          "soft",
          `Asked, but ${missing.join(", ")} never made the top ${SHORTLIST_DEPTH} — the user cannot pick an option that is not offered.`,
        );
      }

      return graded("pass", "");
    }

    case "declines": {
      if (result.band.band === "low") return graded("pass", "");

      return graded(
        "fail",
        `Returned ${topName} at ${result.band.band} confidence for a phrase with nothing identifying in it. This is a hallucinated location.`,
      );
    }
  }
}

export interface Summary {
  total: number;
  pass: number;
  soft: number;
  fail: number;
  /** Strict pass rate — the number the exit test is measured against. */
  passRate: number;
  /** Pass plus soft: right answer found, confidence possibly miscalibrated. */
  reachRate: number;
  byDifficulty: Record<string, { pass: number; soft: number; fail: number }>;
}

export function summarise(graded: GradedCase[]): Summary {
  const summary: Summary = {
    total: graded.length,
    pass: 0,
    soft: 0,
    fail: 0,
    passRate: 0,
    reachRate: 0,
    byDifficulty: {},
  };

  for (const entry of graded) {
    summary[entry.outcome] += 1;

    const bucket = (summary.byDifficulty[entry.case.difficulty] ??= {
      pass: 0,
      soft: 0,
      fail: 0,
    });
    bucket[entry.outcome] += 1;
  }

  if (summary.total > 0) {
    summary.passRate = summary.pass / summary.total;
    summary.reachRate = (summary.pass + summary.soft) / summary.total;
  }

  return summary;
}
