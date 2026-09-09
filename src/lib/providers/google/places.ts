/**
 * Google Places API (New).
 *
 * Server-side only — Part V, decision 1. The field mask is deliberately tight:
 * Places bills by the fields requested, and "Maps API cost outruns revenue" is
 * a high-severity entry in the risk register. Do not widen it without checking
 * the SKU that the extra field moves the call into.
 */

import type {
  NearbySearchInput,
  PlaceResult,
  PlacesProvider,
  TextSearchInput,
} from "@/lib/providers/types";

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const NEARBY_SEARCH_URL = "https://places.googleapis.com/v1/places:searchNearby";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.rating",
  "places.userRatingCount",
].join(",");

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
}

export class GooglePlacesProvider implements PlacesProvider {
  readonly name = "google";

  constructor(private readonly apiKey: string) {}

  async textSearch(input: TextSearchInput): Promise<PlaceResult[]> {
    const body: Record<string, unknown> = {
      textQuery: input.query,
      maxResultCount: input.maxResults ?? 8,
    };

    if (input.bias) {
      body.locationBias = {
        circle: {
          center: {
            latitude: input.bias.center.lat,
            longitude: input.bias.center.lng,
          },
          radius: input.bias.radiusM,
        },
      };
    }

    return this.post(TEXT_SEARCH_URL, body);
  }

  async nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]> {
    const body: Record<string, unknown> = {
      maxResultCount: input.maxResults ?? 10,
      locationRestriction: {
        circle: {
          center: { latitude: input.center.lat, longitude: input.center.lng },
          radius: input.radiusM,
        },
      },
    };

    // searchNearby filters by type, not free text. A keyword that is not a
    // valid place type has to go through searchText instead.
    if (input.keyword) {
      return this.textSearch({
        query: input.keyword,
        bias: { center: input.center, radiusM: input.radiusM },
        maxResults: input.maxResults,
      });
    }

    return this.post(NEARBY_SEARCH_URL, body);
  }

  private async post(
    url: string,
    body: Record<string, unknown>,
  ): Promise<PlaceResult[]> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Places request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    const payload = (await response.json()) as { places?: GooglePlace[] };
    return (payload.places ?? []).flatMap(toPlaceResult);
  }
}

function toPlaceResult(place: GooglePlace): PlaceResult[] {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return [];

  return [
    {
      placeId: place.id ?? `${lat},${lng}`,
      name: place.displayName?.text ?? "Unnamed place",
      formattedAddress: place.formattedAddress ?? "",
      point: { lat, lng },
      types: place.types ?? [],
      prominence: normaliseProminence(place.userRatingCount),
      rating: place.rating,
      userRatingCount: place.userRatingCount,
    },
  ];
}

/**
 * Review count -> 0..1 importance, on a log scale.
 *
 * Linear would let one landmark with 40,000 reviews flatten every genuine
 * neighbourhood result to zero. 1,000 reviews lands near 0.5.
 */
function normaliseProminence(userRatingCount?: number): number | undefined {
  if (typeof userRatingCount !== "number" || userRatingCount < 0) return undefined;
  return Math.min(1, Math.log10(userRatingCount + 1) / 4);
}
