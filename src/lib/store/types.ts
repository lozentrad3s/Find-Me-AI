/**
 * The resolution record (master document, Part III, 3.3).
 *
 * "This schema must exist in the first migration. Retrofitting it loses every
 * early user's data." That is why this file exists before there is a UI to
 * produce the data.
 *
 * The valuable column is `userCorrected` / `correctedTo`. A confirmation says
 * the ranking was right; a correction says exactly how it was wrong and where
 * the truth was. Corrections are the training signal for the address graph,
 * and they only exist if they are captured at the moment they happen.
 */

import type { LatLng } from "@/lib/geo/distance";
import type {
  ConfidenceBand,
  ParsedPlace,
  ScoredCandidate,
} from "@/lib/resolution/types";

/** A candidate as it was shown to the user, frozen at decision time. */
export interface RecordedCandidate {
  candidateId: string;
  source: string;
  name: string;
  formattedAddress: string;
  point: LatLng;
  placeId?: string;
  score: number;
}

export interface ResolutionRecord {
  id: string;
  userId: string | null;

  /** Exactly what the user said. Never cleaned up — the noise is the data. */
  rawPhrase: string;
  parsedComponents: ParsedPlace;

  /** Every candidate offered, in the order shown. */
  candidatesShown: RecordedCandidate[];
  /** Landmarks the pipeline resolved and used. */
  anchorsUsed: Array<{ anchor: string; name: string; point: LatLng }>;

  band: ConfidenceBand;
  topScore: number;
  margin: number;

  /** Where the system landed. Null when nothing cleared the floor. */
  chosenPoint: LatLng | null;
  chosenCandidateId: string | null;

  /** Set when the user moved the pin or picked a different candidate. */
  userCorrected: boolean;
  correctedTo: LatLng | null;

  city: string | null;
  /** Provider implementations that served this resolution. */
  providers: { places: string; geocoding: string; llm: string };
  createdAt: string;
  confirmedAt: string | null;
}

export interface ResolutionStore {
  readonly name: string;
  save(record: ResolutionRecord): Promise<void>;
  /** Record that a human accepted the chosen point. */
  confirm(id: string, point: LatLng): Promise<void>;
  /** Record that a human rejected the chosen point and supplied the truth. */
  correct(id: string, correctedTo: LatLng): Promise<void>;
  list(limit?: number): Promise<ResolutionRecord[]>;
  /**
   * Confirmed points near a query, for the `graph` candidate source.
   * This is the address graph reading back into the pipeline.
   */
  nearbyConfirmed(point: LatLng, radiusM: number): Promise<ResolutionRecord[]>;
}

/** Build a record from a pipeline result. */
export function toRecord(params: {
  id: string;
  userId?: string | null;
  rawPhrase: string;
  parsed: ParsedPlace;
  ranked: ScoredCandidate[];
  anchors: Array<{ anchor: string; name: string; point: LatLng }>;
  band: ConfidenceBand;
  topScore: number;
  margin: number;
  chosen: ScoredCandidate | null;
  city: string | null;
  providers: { places: string; geocoding: string; llm: string };
}): ResolutionRecord {
  return {
    id: params.id,
    userId: params.userId ?? null,
    rawPhrase: params.rawPhrase,
    parsedComponents: params.parsed,
    candidatesShown: params.ranked.map((entry) => ({
      candidateId: entry.candidate.id,
      source: entry.candidate.source,
      name: entry.candidate.name,
      formattedAddress: entry.candidate.formattedAddress,
      point: entry.candidate.point,
      placeId: entry.candidate.placeId,
      score: entry.score,
    })),
    anchorsUsed: params.anchors,
    band: params.band,
    topScore: params.topScore,
    margin: params.margin,
    chosenPoint: params.chosen?.candidate.point ?? null,
    chosenCandidateId: params.chosen?.candidate.id ?? null,
    userCorrected: false,
    correctedTo: null,
    city: params.city,
    providers: params.providers,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}
