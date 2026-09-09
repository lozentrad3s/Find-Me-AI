/**
 * Google Geocoding API. Server-side only.
 *
 * The `location_type` field is the valuable part for this product: it is
 * Google admitting how sure it is. ROOFTOP means a building; APPROXIMATE
 * usually means the centroid of a whole district, which for an informal
 * address is close to useless. That admission is carried into `precision`
 * and heavily discounted by the scorer.
 */

import type { GeocodeResult, GeocodingProvider } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

interface GoogleGeocodeEntry {
  formatted_address?: string;
  geometry?: {
    location?: { lat?: number; lng?: number };
    location_type?: string;
  };
  address_components?: Array<{
    long_name?: string;
    types?: string[];
  }>;
}

export class GoogleGeocodingProvider implements GeocodingProvider {
  readonly name = "google";

  constructor(private readonly apiKey: string) {}

  async forward(address: string, bias?: LatLng): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({ address, key: this.apiKey });
    // Nigeria-only, so a search for "Buhari Street" cannot wander abroad.
    params.set("components", "country:NG");
    if (bias) params.set("location", `${bias.lat},${bias.lng}`);
    return this.get(params);
  }

  async reverse(point: LatLng): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      latlng: `${point.lat},${point.lng}`,
      key: this.apiKey,
    });
    return this.get(params);
  }

  private async get(params: URLSearchParams): Promise<GeocodeResult[]> {
    const response = await fetch(`${GEOCODE_URL}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(
        `Geocoding request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      status?: string;
      results?: GoogleGeocodeEntry[];
      error_message?: string;
    };

    // ZERO_RESULTS is a legitimate answer, not a failure.
    if (payload.status === "ZERO_RESULTS") return [];
    if (payload.status !== "OK") {
      throw new Error(
        `Geocoding error: ${payload.status ?? "unknown"} ${payload.error_message ?? ""}`.trim(),
      );
    }

    return (payload.results ?? []).flatMap(toGeocodeResult);
  }
}

function toGeocodeResult(entry: GoogleGeocodeEntry): GeocodeResult[] {
  const lat = entry.geometry?.location?.lat;
  const lng = entry.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return [];

  const components: Record<string, string> = {};
  for (const component of entry.address_components ?? []) {
    const type = component.types?.[0];
    if (type && component.long_name) components[type] = component.long_name;
  }

  return [
    {
      formattedAddress: entry.formatted_address ?? "",
      point: { lat, lng },
      precision: mapPrecision(entry.geometry?.location_type),
      components,
    },
  ];
}

function mapPrecision(locationType?: string): GeocodeResult["precision"] {
  switch (locationType) {
    case "ROOFTOP":
      return "rooftop";
    case "RANGE_INTERPOLATED":
      return "interpolated";
    case "GEOMETRIC_CENTER":
      return "centroid";
    default:
      return "approximate";
  }
}
