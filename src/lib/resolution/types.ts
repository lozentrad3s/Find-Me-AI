/**
 * Types for the resolution engine (master document, Part III).
 *
 * The pipeline is: capture -> parse -> candidates -> score -> band
 *                  -> disambiguate -> confirm -> reverse-translate
 *
 * THE HARD RULE (Part III, 3.2): the model never produces a coordinate.
 * It produces a *query*. Coordinates enter this system only from a Places
 * provider, a geocoder, the device, or a previously confirmed resolution.
 * `ParsedPlace` deliberately has nowhere to put a lat/lng.
 */

import type { LatLng } from "@/lib/geo/distance";

export type { LatLng };

// ---------------------------------------------------------------------------
// Step 1 — Capture
// ---------------------------------------------------------------------------

/** Everything known at the moment the user says the phrase. */
export interface ResolutionContext {
  /** Device position, when permission has been granted. */
  currentLocation?: LatLng;
  /** City the user appears to be in, or has selected. */
  city?: string;
  /** Places the user has saved. Cheap, high-signal candidate source. */
  savedPlaces?: KnownPlace[];
  /** Recently visited or recently resolved places. */
  recentPlaces?: KnownPlace[];
  /** Places shared with the user by trusted contacts. */
  contactSharedPlaces?: KnownPlace[];
  /** Destination of the active trip, if one is running. */
  activeTripDestination?: LatLng;
  /** Stable id used to scope personal candidate sources. */
  userId?: string;
}

/** A place this system already holds a confirmed point for. */
export interface KnownPlace {
  id: string;
  name: string;
  formattedAddress?: string;
  point: LatLng;
  /** How many times a human has confirmed this exact point. */
  confirmations?: number;
  city?: string;
}

// ---------------------------------------------------------------------------
// Step 2 — Parse (structured extraction; no searching yet)
// ---------------------------------------------------------------------------

export type RelationType =
  | "behind"
  | "beside"
  | "opposite"
  | "in_front_of"
  | "near"
  | "after"
  | "before"
  | "inside"
  | "along"
  | "between";

/** "behind the mosque" -> { type: "behind", anchor: "mosque" } */
export interface LandmarkRelation {
  type: RelationType;
  anchor: string;
}

/**
 * The structured form of a described place.
 *
 * Note the absence of any coordinate field. This is enforced by the type,
 * not by convention.
 */
export interface ParsedPlace {
  /** Category word: "guest house", "filling station", "bank". */
  placeType: string | null;
  /** Proper name, when one was given: "Bluewiz", "Crunchies". */
  placeName: string | null;
  street: string | null;
  /** Neighbourhood or district: "Wuse", "Rayfield". */
  area: string | null;
  city: string | null;
  /** House or plot number, when stated. */
  houseNumber: string | null;
  landmarkRelations: LandmarkRelation[];
  /** Anything the parser flagged as underspecified. */
  ambiguityNotes: string[];
}

// ---------------------------------------------------------------------------
// Step 3 — Candidate generation
// ---------------------------------------------------------------------------

export type CandidateSource =
  /** Places text search. */
  | "places_text"
  /** Places nearby search, anchored on a landmark. */
  | "places_nearby"
  /** Forward geocoding of the street/area/city components. */
  | "geocode"
  /** The user's own saved places. */
  | "saved"
  /** The user's recent or historical places. */
  | "history"
  /** Places shared by a trusted contact. */
  | "contact_shared"
  /** Find Me's own address graph — previously confirmed resolutions. */
  | "graph";

export interface Candidate {
  id: string;
  source: CandidateSource;
  name: string;
  formattedAddress: string;
  point: LatLng;
  /** Provider place id, where the source has one. */
  placeId?: string;
  /** Provider category tags. */
  types?: string[];
  /**
   * How well-known the place is, 0..1. Derived from review counts or an
   * equivalent importance measure. Absent means unknown, not zero.
   */
  prominence?: number;
  /** The provider's own confidence, 0..1, where it reports one. */
  providerConfidence?: number;
  /** Number of prior human confirmations at this point. */
  confirmations?: number;
  /** Number of prior human corrections away from this point. */
  corrections?: number;
}

// ---------------------------------------------------------------------------
// Step 4 — Scoring
// ---------------------------------------------------------------------------

/**
 * The individual signals, kept separate so the harness can show its working.
 *
 * `null` means *not applicable*, which is materially different from 0. If the
 * user named no landmark, `anchorProximity` is null and drops out of both the
 * numerator and the denominator. Scoring it as 0 instead would cap every
 * landmark-free phrase below the high band and make the engine look far worse
 * than it is.
 */
export interface ScoreSignals {
  /** Parsed name/type vs candidate name. */
  nameMatch: number | null;
  /** Parsed area and city vs candidate address. */
  areaMatch: number | null;
  /** Candidate closeness to the named landmark anchors. */
  anchorProximity: number | null;
  /** How well-known the candidate is. */
  prominence: number | null;
  /** Independent sources that produced a point near this one. */
  sourceAgreement: number | null;
  /** Prior human confirmations near this point, minus corrections away from it. */
  correctionHistory: number | null;
  /** Mild prior that people ask about places near themselves. */
  userProximity: number | null;
  /**
   * How tightly the source located this point.
   *
   * A rooftop match and a district centroid are not the same claim, and
   * treating them as one is the most direct cause of an imprecise pin.
   */
  pointPrecision: number | null;
}

export type ScoreWeights = Record<keyof ScoreSignals, number>;

export interface ScoredCandidate {
  candidate: Candidate;
  signals: ScoreSignals;
  /** Weighted total, normalised to 0..1. */
  score: number;
  /** Signals that fired strongly, for explaining the result to a human. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Step 5 — Confidence bands
// ---------------------------------------------------------------------------

export type ConfidenceBand = "high" | "moderate" | "low";

export interface BandDecision {
  band: ConfidenceBand;
  /** Top score minus runner-up. Small margins mean "several plausible". */
  margin: number;
  /** Why this band, in one sentence, for the UI and the harness. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Step 6 — Disambiguation
// ---------------------------------------------------------------------------

/** The feature that actually separates the top candidates. */
export type DiscriminatorKind = "area" | "anchor" | "street" | "name" | "distance";

export interface DisambiguationQuestion {
  /** One specific question. Never a generic "can you be more specific?". */
  question: string;
  discriminator: DiscriminatorKind;
  options: DisambiguationOption[];
}

export interface DisambiguationOption {
  candidateId: string;
  label: string;
  /** The distinguishing detail this option turns on. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Step 8 — Reverse translation (machine -> human; seeds Tell My Driver)
// ---------------------------------------------------------------------------

export interface NearbyLandmark {
  name: string;
  distanceM: number;
  bearing: number;
  /** "north-east" etc., relative to the resolved point. */
  direction: string;
}

export interface ReverseDescription {
  landmarks: NearbyLandmark[];
  /** Approach description, when a starting point is known. */
  approach: string | null;
  /** A sentence that can be read aloud to a driver. */
  driverInstruction: string;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface ResolutionResult {
  /** The phrase exactly as the user gave it. */
  rawPhrase: string;
  parsed: ParsedPlace;
  /** Every candidate considered, scored, best first. */
  ranked: ScoredCandidate[];
  /** Best candidate, or null when nothing cleared the floor. */
  best: ScoredCandidate | null;
  band: BandDecision;
  /** Present when the band is moderate — the one specific question to ask. */
  question: DisambiguationQuestion | null;
  /** Present when the band is high and a point was settled on. */
  reverse: ReverseDescription | null;
  /** Per-stage timings, in ms. */
  timings: Record<string, number>;
  /** Which provider implementations served this run. */
  providers: { places: string; geocoding: string; llm: string };
}
