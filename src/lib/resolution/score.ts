/**
 * Step 4 — scoring.
 *
 * Weighted sum over applicable signals only. A signal that does not apply
 * returns null and leaves both the numerator and the denominator, so the
 * score always means "how well does this candidate explain what the user
 * actually said", not "how many boxes did it happen to tick".
 *
 * Weights are exported and overridable because they are the main thing the
 * harness exists to tune. Treat the defaults as a starting position, not a
 * result — they were set by reasoning about the domain, and only the exit
 * test on real addresses can tell us whether they are right.
 */

import { distanceMetres, proximityScore } from "@/lib/geo/distance";
import {
  editSimilarity,
  streetType,
  tokenContainment,
  tokenSimilarity,
} from "@/lib/text/similarity";
import type {
  Candidate,
  ParsedPlace,
  RelationType,
  ResolutionContext,
  ScoreSignals,
  ScoredCandidate,
  ScoreWeights,
} from "./types";
import { AGREEMENT_RADIUS_M, clusterCandidates, type AnchorPoint } from "./candidates";

/**
 * Signal weights.
 *
 * Two classes of signal, and the gap between them is deliberate:
 *
 *   Evidence  — nameMatch, anchorProximity, areaMatch, correctionHistory.
 *               These are things the user actually told us, or things a human
 *               previously confirmed. They decide the answer.
 *
 *   Priors    — prominence, userProximity. These are guesses about what people
 *               usually mean. They break ties and nothing more.
 *
 * The priors are weighted an order of magnitude lower than the evidence, and
 * that is load-bearing. Because the score is a weighted mean, a mid-range prior
 * pulls a perfect match down toward it — an exact name hit on a place with
 * unremarkable prominence was scoring 0.67 and banding "moderate", so the
 * engine asked a question it had no reason to ask. Prominence in particular is
 * the signal that buries the small guest house we exist to find; it gets 0.15.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  // What the user called it. The primary signal.
  nameMatch: 2.0,
  // The wedge. When someone gives a landmark, it is usually the most reliable
  // thing in the sentence — more reliable than the street name they also gave.
  anchorProximity: 1.6,
  // Prior human confirmation is the strongest evidence there is, which is why
  // capturing corrections from day one matters so much.
  correctionHistory: 1.5,
  areaMatch: 1.0,
  /*
   * Zero on purpose — precision is applied as a discount, not a signal.
   *
   * It was briefly weighted at 0.9 alongside the evidence signals, and that
   * was wrong in a way the harness caught immediately: only some sources
   * report precision at all. A candidate that reports high precision gained a
   * heavily-weighted signal, while one whose precision is simply *unknown* had
   * it excluded — so "Buhari Street", a geocoded route with a known bounding
   * box, outscored "Bluewiz Lodge", the guest house actually being asked for.
   * Unknown precision was being punished as though it were low precision.
   *
   * Precision does not tell you whether this is the right *place*; it tells
   * you how much to trust the *point* once you have decided. That is a
   * discount on confidence, applied in `combine`, not a vote on identity.
   */
  pointPrecision: 0,
  sourceAgreement: 0.7,
  // Priors below this line.
  prominence: 0.15,
  userProximity: 0.12,
};

/**
 * How close a candidate should be to its anchor, by relation.
 *
 * These are half-life distances: the distance at which the signal scores 0.5.
 * "Behind" a building means tens of metres. "After the junction" can mean
 * several hundred. Treating them identically loses real information.
 */
/**
 * Within this distance a candidate is treated as *being* the anchor rather
 * than sitting next to it. Geocoders disagree by a few tens of metres on the
 * same building, so an exact-zero test would not catch it.
 */
const ANCHOR_SELF_RADIUS_M = 30;

const RELATION_HALF_LIFE_M: Record<RelationType, number> = {
  inside: 25,
  behind: 60,
  in_front_of: 60,
  beside: 60,
  opposite: 80,
  between: 150,
  along: 250,
  near: 250,
  after: 400,
  before: 400,
};

export interface ScoreInput {
  parsed: ParsedPlace;
  candidates: Candidate[];
  anchors: AnchorPoint[];
  context: ResolutionContext;
  weights?: ScoreWeights;
}

export function scoreCandidates(input: ScoreInput): ScoredCandidate[] {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const clusters = clusterCandidates(input.candidates);

  // Map each candidate to the set of distinct sources agreeing on its point.
  const agreementBySource = new Map<string, Set<Candidate["source"]>>();
  for (const cluster of clusters) {
    const sources = new Set(cluster.map((c) => c.source));
    for (const member of cluster) agreementBySource.set(member.id, sources);
  }

  const scored = input.candidates.map((candidate) => {
    const signals = computeSignals(candidate, input, agreementBySource);
    const score = combine(signals, weights);
    return { candidate, signals, score, reasons: explain(signals, input) };
  });

  return collapseClusters(applyNameDominance(scored, input)).sort((a, b) => b.score - a.score);
}

/**
 * When the user named a place and something matches that name, places that do
 * not match it are not answers.
 *
 * Weighting alone does not settle this. Asked for "Christian Community
 * School", every school in the district scores a perfect category match, and
 * the priors — being 139 m away rather than 700 m, being better known — are
 * then free to decide which one wins. They did, and the app routed to the
 * wrong school. Distance is a tie-breaker between places that fit the
 * description; it must never override the description itself.
 *
 * A discount rather than a filter: the near-misses stay in the list as
 * alternatives, they simply stop winning.
 */
function applyNameDominance(
  scored: ScoredCandidate[],
  input: ScoreInput,
): ScoredCandidate[] {
  if (!input.parsed.placeName) return scored;

  const bestName = Math.max(0, ...scored.map((entry) => entry.signals.nameMatch ?? 0));
  if (bestName < 0.7) return scored;

  return scored.map((entry) => {
    const nameMatch = entry.signals.nameMatch ?? 0;
    if (nameMatch >= 0.45) return entry;

    return {
      ...entry,
      score: entry.score * 0.45,
      reasons: [...entry.reasons, `does not match the name asked for`],
    };
  });
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function computeSignals(
  candidate: Candidate,
  input: ScoreInput,
  agreement: Map<string, Set<Candidate["source"]>>,
): ScoreSignals {
  const { parsed, anchors, context } = input;

  return {
    nameMatch: scoreName(candidate, parsed),
    areaMatch: scoreArea(candidate, parsed),
    anchorProximity: scoreAnchors(candidate, anchors),
    prominence: candidate.prominence ?? null,
    sourceAgreement: scoreAgreement(candidate, agreement),
    correctionHistory: scoreHistory(candidate),
    pointPrecision: candidate.providerConfidence ?? null,
    userProximity: context.currentLocation
      ? proximityScore(distanceMetres(context.currentLocation, candidate.point), 4000)
      : null,
  };
}

/**
 * What the user called the place — its identity, not its location.
 *
 * The street deliberately does NOT count here unless the user gave nothing else
 * to go on. A street name says *where* something is, the same way an area does;
 * it does not say *what* it is. Scoring it as identity produces a specific and
 * bad failure: for "the guest house behind the mosque on Buhari Street", the
 * candidate literally named "Buhari Street" scores a perfect 1.0 on name and
 * outranks the guest house the user actually asked for.
 *
 * So the street is an area signal, and only becomes an identity signal when
 * there is no name and no category — which is exactly the case where the user
 * is asking for the street itself.
 */
function scoreName(candidate: Candidate, parsed: ParsedPlace): number | null {
  const askingForStreetItself = !parsed.placeName && !parsed.placeType;

  if (askingForStreetItself) {
    if (!parsed.street) return null;

    const streetScore = Math.max(
      tokenSimilarity(parsed.street, candidate.name),
      tokenSimilarity(parsed.street, candidate.formattedAddress),
    );

    return streetScore * streetTypePenalty(parsed.street, candidate);
  }

  // The category can match the name ("Green Palace Hotel") or the provider's
  // type tags ("lodging"), whichever is stronger.
  const typeScore = parsed.placeType
    ? Math.max(
        tokenSimilarity(parsed.placeType, candidate.name),
        tokenSimilarity(parsed.placeType, (candidate.types ?? []).join(" ")),
      )
    : null;

  if (!parsed.placeName) return typeScore;

  const nameScore = tokenSimilarity(parsed.placeName, candidate.name);
  if (typeScore === null) return nameScore;

  /*
   * When the user gave both a name and a category, the name decides and the
   * category is a small corroboration — never a substitute.
   *
   * Taking the maximum of the two was wrong in a way that showed up
   * immediately: for "Jos Main Market" every market in the city matched the
   * category perfectly, so Jos Main Market, Farin Gada Market and Bukuru
   * Market all scored identically and the margin collapsed to 0.01. The
   * category is nearly free — plenty of places satisfy it — so it can only
   * ever add a little on top of the identity match.
   */
  const TYPE_BONUS = 0.15;
  return Math.min(1, nameScore * (1 - TYPE_BONUS) + typeScore * TYPE_BONUS);
}

/**
 * Where the user said it is: area, city, and street.
 */
function scoreArea(candidate: Candidate, parsed: ParsedPlace): number | null {
  const askingForStreetItself = !parsed.placeName && !parsed.placeType;
  const streetIsLocality = parsed.street && !askingForStreetItself;

  if (!parsed.area && !parsed.city && !streetIsLocality) return null;

  const haystack = `${candidate.formattedAddress} ${candidate.name}`;
  const scores: number[] = [];

  /*
   * The district is the discriminating half. Three Buhari Streets in one city
   * are separated by their district, never by the city name — so once the user
   * has named a district, being in the right *city* stops counting as
   * evidence. Falling back to the city score for a candidate in the wrong
   * district gave it ~0.42 against the right district's ~0.7, a gap far too
   * narrow to act on. When a district is given it behaves as a soft filter.
   */
  if (parsed.area) {
    scores.push(tokenContainment(parsed.area, haystack));
  } else if (parsed.city) {
    scores.push(tokenContainment(parsed.city, haystack) * 0.7);
  }

  if (streetIsLocality && parsed.street) {
    const onThisStreet = tokenContainment(parsed.street, candidate.formattedAddress);
    scores.push(onThisStreet * streetTypePenalty(parsed.street, candidate));
  }

  if (scores.length === 0) return null;
  return Math.max(...scores);
}

/**
 * "Buhari Street" vs "Buhari Crescent" share their only content token, so token
 * similarity alone rates them identical. When both name a street type and the
 * types differ, that is a real mismatch, not a near-miss.
 */
function streetTypePenalty(street: string, candidate: Candidate): number {
  const wanted = streetType(street);
  const got =
    streetType(candidate.name) ?? streetType(candidate.formattedAddress);
  return wanted && got && wanted !== got ? 0.5 : 1;
}

function scoreAnchors(candidate: Candidate, anchors: AnchorPoint[]): number | null {
  if (anchors.length === 0) return null;

  // Group by the anchor phrase: several matches for "mosque" are alternative
  // guesses at one landmark, so the best one counts. Different anchors are
  // independent constraints, so those are averaged — a candidate should
  // satisfy all of them.
  const byAnchor = new Map<string, AnchorPoint[]>();
  for (const anchor of anchors) {
    const list = byAnchor.get(anchor.anchor) ?? [];
    list.push(anchor);
    byAnchor.set(anchor.anchor, list);
  }

  const perAnchor: number[] = [];
  for (const group of byAnchor.values()) {
    const best = Math.max(
      ...group.map((anchor) => {
        const metres = distanceMetres(anchor.point, candidate.point);

        /*
         * The anchor is not its own answer.
         *
         * "That place beside the bank" explicitly excludes the bank, but the
         * bank sits zero metres from itself and so scored a perfect 1.00 on
         * anchor proximity — winning the very query that ruled it out. The
         * engine then committed confidently to the wrong place on a phrase it
         * should have asked about, which is the worst failure class there is.
         *
         * `inside` is the exception: "inside the mall" really does mean the
         * mall's own position, so only the exclusive relations are guarded.
         */
        const isExclusive = anchor.relation !== "inside";
        if (isExclusive && metres <= ANCHOR_SELF_RADIUS_M) return 0;

        return proximityScore(metres, RELATION_HALF_LIFE_M[anchor.relation]);
      }),
    );
    perAnchor.push(best);
  }

  return perAnchor.reduce((sum, s) => sum + s, 0) / perAnchor.length;
}

function scoreAgreement(
  candidate: Candidate,
  agreement: Map<string, Set<Candidate["source"]>>,
): number {
  const sources = agreement.get(candidate.id);
  const distinct = sources ? sources.size : 1;

  // Three independent sources agreeing is close to conclusive; beyond that
  // there is little more to learn, so this saturates rather than growing.
  return Math.min(1, (distinct - 1) / 2);
}

function scoreHistory(candidate: Candidate): number | null {
  const confirmations = candidate.confirmations ?? 0;
  const corrections = candidate.corrections ?? 0;
  if (confirmations === 0 && corrections === 0) return null;

  // Corrections weigh double. Someone actively moving a pin away from a point
  // is a stronger statement than someone accepting a default.
  const net = confirmations - 2 * corrections;
  if (net <= 0) return 0;
  return Math.min(1, net / 3);
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

function combine(signals: ScoreSignals, weights: ScoreWeights): number {
  let weighted = 0;
  let total = 0;

  for (const [key, value] of Object.entries(signals) as Array<
    [keyof ScoreSignals, number | null]
  >) {
    if (value === null) continue;
    const weight = weights[key];
    if (weight === 0) continue;
    weighted += weight * clamp01(value);
    total += weight;
  }

  if (total === 0) return 0;

  return (weighted / total) * precisionDiscount(signals.pointPrecision);
}

/**
 * How much to trust a point once the place itself has been decided.
 *
 * Asymmetric on purpose. A high-precision match earns no bonus — being pinned
 * to a building says nothing about whether it is the *right* building. A
 * genuinely coarse match is discounted, because a district centroid presented
 * as an address sends someone to the wrong end of a neighbourhood while
 * looking exactly like a real answer on the map.
 *
 * Unknown precision is treated as no discount rather than as low precision.
 * Most sources do not report it, and punishing silence would systematically
 * favour whichever provider happens to be chattiest.
 */
function precisionDiscount(precision: number | null): number {
  if (precision === null) return 1;
  if (precision >= 0.5) return 1;

  // 0.5 -> no discount, 0.0 -> 0.7. Enough to lose a close contest to a
  // precise rival, not enough to bury an otherwise strong match.
  return 0.7 + 0.6 * clamp01(precision);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Collapse each cluster to its best representative.
 *
 * Without this, three sources agreeing on one point would occupy the top three
 * slots, the margin between first and second would be ~0, and the bander would
 * call a unanimous answer ambiguous — the exact inversion of the truth.
 */
function collapseClusters(scored: ScoredCandidate[]): ScoredCandidate[] {
  const kept: ScoredCandidate[] = [];

  for (const entry of [...scored].sort((a, b) => b.score - a.score)) {
    const duplicate = kept.some(
      (existing) =>
        distanceMetres(existing.candidate.point, entry.candidate.point) <=
        AGREEMENT_RADIUS_M,
    );
    if (!duplicate) kept.push(entry);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

function explain(signals: ScoreSignals, input: ScoreInput): string[] {
  const reasons: string[] = [];

  if ((signals.anchorProximity ?? 0) > 0.6) {
    const names = [...new Set(input.anchors.map((a) => a.name))].join(", ");
    reasons.push(`close to the named landmark (${names})`);
  }
  if ((signals.nameMatch ?? 0) > 0.75) reasons.push("name matches closely");
  if ((signals.areaMatch ?? 0) > 0.7) reasons.push("in the stated area");
  if ((signals.sourceAgreement ?? 0) >= 0.5) {
    reasons.push("several independent sources agree on this point");
  }
  if ((signals.correctionHistory ?? 0) > 0.5) {
    reasons.push("previously confirmed here by users");
  }
  if ((signals.pointPrecision ?? 0) > 0.85) {
    reasons.push("pinned to a specific building rather than an area");
  }
  // Worth saying out loud: an area-level answer looks identical to a precise
  // one on a map until you arrive at the wrong end of the district.
  if (signals.pointPrecision !== null && signals.pointPrecision < 0.35) {
    reasons.push("located to an area, not an exact point");
  }

  return reasons;
}

/** Exported for the harness, which prints similarity between two names. */
export const nameSimilarity = editSimilarity;
