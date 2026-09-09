/**
 * Mock Places provider backed by the local fixtures.
 *
 * It scores fixture rows against the query the way a real text-search endpoint
 * roughly would — name match, address match, prominence, distance bias — and
 * returns the top N. The point is not to imitate Google precisely, but to give
 * the resolution pipeline a realistically *noisy and ambiguous* candidate set
 * so the scorer and the disambiguator are exercised honestly.
 */

import type {
  NearbySearchInput,
  PlaceResult,
  PlacesProvider,
  TextSearchInput,
} from "@/lib/providers/types";
import { distanceMetres, proximityScore } from "@/lib/geo/distance";
import { tokenSimilarity } from "@/lib/text/similarity";
import { ALL_FIXTURES, type FixturePlace } from "./fixtures";

function toResult(place: FixturePlace): PlaceResult {
  return {
    placeId: place.placeId,
    name: place.name,
    formattedAddress: place.formattedAddress,
    point: place.point,
    types: place.types,
    prominence: place.prominence,
  };
}

export class MockPlacesProvider implements PlacesProvider {
  readonly name = "mock";

  constructor(private readonly fixtures: FixturePlace[] = ALL_FIXTURES) {}

  async textSearch(input: TextSearchInput): Promise<PlaceResult[]> {
    const max = input.maxResults ?? 8;

    const scored = this.fixtures.map((place) => {
      const nameScore = tokenSimilarity(input.query, place.name);
      const addressScore = tokenSimilarity(input.query, place.formattedAddress);
      // Category words in the query ("guest house", "mosque") should pull the
      // matching types up even when the proper name was never given.
      const typeScore = tokenSimilarity(input.query, place.types.join(" "));

      let score =
        0.5 * nameScore + 0.3 * addressScore + 0.2 * typeScore;

      // Prominence is a mild tiebreaker, not a driver.
      score += 0.08 * place.prominence;

      if (input.bias) {
        const d = distanceMetres(input.bias.center, place.point);
        // Outside the bias radius the pull tapers rather than cutting off,
        // matching how a real bias behaves.
        score += 0.15 * proximityScore(d, input.bias.radiusM);
      }

      return { place, score };
    });

    return scored
      .filter((s) => s.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((s) => toResult(s.place));
  }

  async nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]> {
    const max = input.maxResults ?? 10;

    const within = this.fixtures
      .map((place) => ({
        place,
        distance: distanceMetres(input.center, place.point),
      }))
      .filter((row) => row.distance <= input.radiusM);

    const matched = input.keyword
      ? within.filter(({ place }) => {
          const keyword = input.keyword as string;
          return (
            tokenSimilarity(keyword, place.name) > 0.3 ||
            tokenSimilarity(keyword, place.types.join(" ")) > 0.3
          );
        })
      : within;

    return matched
      .sort((a, b) => a.distance - b.distance)
      .slice(0, max)
      .map((row) => toResult(row.place));
  }
}
