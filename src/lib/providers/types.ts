/**
 * Provider seams.
 *
 * Every external dependency the resolution engine touches sits behind one of
 * these interfaces. Two reasons, both from the master document:
 *
 *  - Part V, decision 1: all Places and Geocoding traffic goes through the
 *    backend so it can be cached, deduplicated and capped. A single seam is
 *    where that caching will live.
 *  - Part X: "Maps API cost outruns revenue" is a high-severity risk. Being
 *    able to run the whole pipeline on mocks means development and the test
 *    harness cost nothing.
 */

import type { LatLng } from "@/lib/geo/distance";
import type { ParsedPlace } from "@/lib/resolution/types";

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface PlaceResult {
  placeId: string;
  name: string;
  formattedAddress: string;
  point: LatLng;
  types: string[];
  /** Normalised 0..1 importance. Providers report this differently. */
  prominence?: number;
  /**
   * How tightly the provider located this point, 0..1.
   *
   * A rooftop match and a district centroid are different claims and must not
   * compete on equal footing. Nominatim reports it via place_rank and the
   * bounding box; Google via location_type.
   */
  providerConfidence?: number;
  rating?: number;
  userRatingCount?: number;
}

export interface TextSearchInput {
  query: string;
  /** Bias, not a filter — results outside are still allowed. */
  bias?: { center: LatLng; radiusM: number };
  maxResults?: number;
}

export interface NearbySearchInput {
  center: LatLng;
  radiusM: number;
  /** Category or keyword, e.g. "mosque", "filling station". */
  keyword?: string;
  maxResults?: number;
}

export interface PlacesProvider {
  /** Identifier shown in harness output, e.g. "mock" or "google". */
  readonly name: string;
  textSearch(input: TextSearchInput): Promise<PlaceResult[]>;
  nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]>;
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

export interface GeocodeResult {
  formattedAddress: string;
  point: LatLng;
  /**
   * How precisely the geocoder placed this: a rooftop match is worth far more
   * than a centroid of a whole district. Feeds `providerConfidence`.
   */
  precision: "rooftop" | "interpolated" | "centroid" | "approximate";
  /** Provider's own components, where available. */
  components?: Record<string, string>;
  /** Short name of the matched feature, e.g. "Maitama". */
  name?: string;
  /** What kind of feature matched, e.g. "suburb", "neighbourhood". */
  kind?: string;
  /** Extent of the feature — a district's box, not just its centre. */
  bbox?: { south: number; north: number; west: number; east: number };
}

export interface GeocodingProvider {
  readonly name: string;
  forward(address: string, bias?: LatLng): Promise<GeocodeResult[]>;
  reverse(point: LatLng): Promise<GeocodeResult[]>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/**
 * The LLM's only job in this engine is structured extraction.
 *
 * The return type is `ParsedPlace`, which has no coordinate field. That is
 * the type-level expression of Part III, 3.2 — the model cannot return a
 * point even if it wants to.
 */
export interface LlmProvider {
  readonly name: string;
  parsePlacePhrase(
    phrase: string,
    hints: { city?: string; knownAreas?: string[] },
  ): Promise<ParsedPlace>;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface Providers {
  places: PlacesProvider;
  geocoding: GeocodingProvider;
  llm: LlmProvider;
}
