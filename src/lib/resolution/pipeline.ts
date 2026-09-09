/**
 * The resolution pipeline (master document, Part III).
 *
 *   capture -> parse -> candidates -> score -> band -> disambiguate
 *           -> [confirm] -> reverse-translate
 *
 * Confirm is not in this function on purpose. Confirmation is a user action,
 * not a computation: it arrives later, from a tap or a spoken yes, and gets
 * recorded via `recordConfirmation` in the store. That event is the valuable
 * one — it is what turns this from a wrapper around Places into an address
 * graph nobody else has.
 */

import type { Providers } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { KNOWN_AREAS, type FixtureCity } from "@/lib/providers/mock/fixtures";
import { generateCandidates } from "./candidates";
import { scoreCandidates, DEFAULT_WEIGHTS } from "./score";
import { decideBand, DEFAULT_THRESHOLDS, type BandThresholds } from "./band";
import { buildQuestion } from "./disambiguate";
import { describeForHumans } from "./reverse";
import type {
  KnownPlace,
  ParsedPlace,
  ResolutionContext,
  ResolutionResult,
  ScoreWeights,
} from "./types";

/**
 * Candidates further than this from the search centre are dropped outright.
 *
 * A text search for "Buhari Street" can return a match in another state. No
 * weighting fixes that — it is not a weak candidate, it is the wrong city — so
 * it is filtered before scoring rather than allowed to dilute the margin.
 */
const MAX_DISTANCE_FROM_CENTRE_M = 75_000;

/** How long the optional landmark/driver-line lookup may take before it is dropped. */
const REVERSE_BUDGET_MS = 4_000;

export interface ResolveOptions {
  context?: ResolutionContext;
  weights?: ScoreWeights;
  thresholds?: BandThresholds;
  /** Allow landmark-based disambiguation, which costs extra Places calls. */
  enableLandmarkQuestions?: boolean;
  graphLookup?: (
    parsed: ParsedPlace,
    context: ResolutionContext,
  ) => Promise<KnownPlace[]>;
}

export async function resolvePlace(
  rawPhrase: string,
  providers: Providers,
  options: ResolveOptions = {},
): Promise<ResolutionResult> {
  const context = options.context ?? {};
  const timings: Record<string, number> = {};

  // --- Step 2: parse ------------------------------------------------------
  const parseStart = performance.now();
  const parsed = await providers.llm.parsePlacePhrase(rawPhrase, {
    city: context.city,
    knownAreas: areaHints(context.city),
  });
  timings.parse = performance.now() - parseStart;

  /*
   * Nothing identifying was said, so there is nothing to look for.
   *
   * "Somewhere in Jos" names a city and no place. Left to the scorer, the
   * prominent places in that city still accumulate a respectable score from
   * prominence, proximity and city-name containment, and the engine confidently
   * answered "Jabi Lake Mall" — a location the user never described. In a
   * product people use to find each other that is the most damaging failure
   * there is, and no threshold tuning fixes it, because the score is not
   * actually wrong: those candidates really are the best available. The premise
   * is wrong.
   *
   * A city is not an identifier. Anything more specific — a name, a category, a
   * street, a house number, a landmark, a district — is.
   *
   * Checking before candidate generation also means the hopeless case costs
   * zero Places calls, which matters given Part X.
   */
  if (!hasIdentifyingContent(parsed)) {
    return {
      rawPhrase,
      parsed,
      ranked: [],
      best: null,
      band: {
        band: "low",
        margin: 0,
        rationale:
          "No name, category, street or landmark was given — a city on its own does not identify a place.",
      },
      question: null,
      reverse: null,
      timings: { ...timings, total: timings.parse ?? 0 },
      providers: {
        places: providers.places.name,
        geocoding: providers.geocoding.name,
        llm: providers.llm.name,
      },
    };
  }

  // --- Step 3: candidates -------------------------------------------------
  const candidateStart = performance.now();
  const generated = await generateCandidates({
    rawPhrase,
    parsed,
    context,
    providers,
    graphLookup: options.graphLookup,
  });
  timings.candidates = performance.now() - candidateStart;

  const centre = generated.searchCentre;
  const candidates = centre
    ? generated.candidates.filter(
        (candidate) =>
          distanceMetres(centre, candidate.point) <= MAX_DISTANCE_FROM_CENTRE_M,
      )
    : generated.candidates;

  // --- Step 4: score ------------------------------------------------------
  const scoreStart = performance.now();
  const ranked = scoreCandidates({
    parsed,
    candidates,
    anchors: generated.anchors,
    context,
    weights: options.weights ?? DEFAULT_WEIGHTS,
  });
  timings.score = performance.now() - scoreStart;

  // --- Step 5: band -------------------------------------------------------
  const band = decideBand(ranked, options.thresholds ?? DEFAULT_THRESHOLDS);
  const best = band.band === "low" ? null : (ranked[0] ?? null);

  // --- Step 6: disambiguate ----------------------------------------------
  let question = null;
  if (band.band === "moderate") {
    const questionStart = performance.now();
    question = await buildQuestion({
      ranked,
      places: options.enableLandmarkQuestions === false ? undefined : providers.places,
    });
    timings.disambiguate = performance.now() - questionStart;
  }

  // --- Step 8: reverse-translate -----------------------------------------
  let reverse = null;
  if (band.band === "high" && best) {
    const reverseStart = performance.now();

    /*
     * The landmark lookup gets a hard deadline.
     *
     * By this point the question is already answered — the pin is known and
     * correct. Everything this step adds is the spoken driver line, which is
     * valuable but strictly a bonus. Overpass is volunteer-run and its latency
     * swings from two seconds to twenty depending on load, and letting that
     * variance sit in front of a finished answer made a resolved query feel
     * broken. Better to return the address without the landmark sentence.
     */
    reverse = await Promise.race([
      describeForHumans({
        candidate: best.candidate,
        places: providers.places,
        origin: context.currentLocation,
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), REVERSE_BUDGET_MS),
      ),
    ]).catch(() => null);

    timings.reverse = performance.now() - reverseStart;
  }

  timings.total = Object.entries(timings)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0);

  return {
    rawPhrase,
    parsed,
    ranked,
    best,
    band,
    question,
    reverse,
    timings,
    providers: {
      places: providers.places.name,
      geocoding: providers.geocoding.name,
      llm: providers.llm.name,
    },
  };
}

/**
 * Did the phrase contain anything that could identify a place?
 *
 * `city` is excluded on purpose — see the guard in `resolvePlace`. Everything
 * else, including a bare district, narrows the search to somewhere a person
 * could actually have meant.
 */
function hasIdentifyingContent(parsed: ParsedPlace): boolean {
  return Boolean(
    parsed.placeName ||
      parsed.placeType ||
      parsed.street ||
      parsed.houseNumber ||
      parsed.area ||
      parsed.landmarkRelations.length > 0,
  );
}

/** Area names to hint the parser with, based on the city in context. */
function areaHints(city?: string): string[] {
  if (!city) return [...KNOWN_AREAS.jos, ...KNOWN_AREAS.abuja];
  const key = city.toLowerCase() as FixtureCity;
  return KNOWN_AREAS[key] ?? [...KNOWN_AREAS.jos, ...KNOWN_AREAS.abuja];
}

/** Re-exported so callers need only import from the pipeline. */
export type { ResolutionResult, ResolutionContext, LatLng };
export { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS };
