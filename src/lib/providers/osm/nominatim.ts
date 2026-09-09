/**
 * Nominatim — OpenStreetMap geocoding. Free, no key, no billing.
 *
 * Two constraints that shape this file, both from the usage policy:
 *   - one request per second, absolute maximum
 *   - a User-Agent that identifies the application, or you get 403s
 * Both are handled by `throttledFetchJson`.
 *
 * A caveat worth stating plainly, because it decides how much of the product
 * this can carry: OSM coverage in Nigeria is real but uneven. Testing against
 * live Nominatim, "mosque Wuse Abuja" returns properly named places, while
 * "Buhari Street Wuse Abuja" returns nothing at all, and Jos mosques come back
 * named simply "Mosque". So this is a genuine geocoder for free, but the
 * address graph it can bootstrap from is thinner than Google's — which is,
 * uncomfortably, the same gap the product exists to fill.
 */

import type {
  GeocodeResult,
  GeocodingProvider,
  NearbySearchInput,
  PlaceResult,
  PlacesProvider,
  TextSearchInput,
} from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";

const BASE = "https://nominatim.openstreetmap.org";
/** The policy limit is 1/sec. Leave headroom rather than ride the line. */
const MIN_INTERVAL_MS = 1200;

/**
 * Our category words -> the phrases Nominatim actually recognises.
 *
 * Nominatim supports "<category> in <place>" queries, but only for its own
 * vocabulary, and the mismatch is unforgiving rather than fuzzy: measured
 * against the live service, "fuel in Maitama, Abuja" returns four stations
 * while "filling station in Maitama, Abuja" returns zero — for the same
 * places. Same for several others below.
 *
 * This matters far more than a lookup table usually would, because it is what
 * lets category search run on Nominatim at roughly 1.5s instead of Overpass at
 * 20s+. Every entry here is one category that answers quickly rather than
 * hanging. Verify additions against the live service; do not assume a word
 * works because it seems obvious.
 */
const NOMINATIM_CATEGORY: Record<string, string> = {
  "filling station": "fuel",
  fuel: "fuel",
  petrol: "fuel",
  pharmacy: "pharmacy",
  chemist: "pharmacy",
  hospital: "hospital",
  clinic: "clinic",
  restaurant: "restaurant",
  hotel: "hotel",
  "guest house": "hotel",
  lodge: "hotel",
  bank: "bank",
  atm: "atm",
  supermarket: "supermarket",
  market: "marketplace",
  school: "school",
  university: "university",
  "police station": "police",
  mall: "mall",
  airport: "aerodrome",
  church: "church",
  mosque: "mosque",
  park: "park",
  cinema: "cinema",
  stadium: "stadium",
};

/**
 * Build a Nominatim category query, or null when the word is not in its
 * vocabulary — in which case the caller should fall back to Overpass rather
 * than send a query that will silently return nothing.
 */
export function categoryQuery(
  placeType: string,
  area?: string | null,
  city?: string | null,
): string | null {
  const phrase = NOMINATIM_CATEGORY[placeType.trim().toLowerCase()];
  if (!phrase) return null;

  const where = [area, city].filter(Boolean).join(", ");
  if (!where) return null;

  return `${phrase} in ${where}`;
}

interface NominatimPlace {
  place_id: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
  place_rank?: number;
  importance?: number;
  addresstype?: string;
  address?: Record<string, string>;
}

function toLatLng(place: NominatimPlace): LatLng | null {
  const lat = Number.parseFloat(place.lat);
  const lng = Number.parseFloat(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Nominatim `importance` is a Wikipedia-derived score. For ordinary POIs it is
 * around 1e-5 — effectively zero for everything that is not a country or a
 * major city. Rescaling it linearly would make prominence useless, so this
 * spreads the small values over a usable range while keeping the ordering.
 */
function toProminence(place: NominatimPlace): number | undefined {
  const importance = place.importance;
  if (typeof importance !== "number" || !Number.isFinite(importance)) {
    return undefined;
  }
  if (importance <= 0) return 0;
  // log10(1e-5) = -5 maps to 0; log10(1) = 0 maps to 1.
  const scaled = (Math.log10(importance) + 5) / 5;
  return Math.min(1, Math.max(0, scaled));
}

/** Prefer the short name; fall back to the first segment of the display name. */
function toName(place: NominatimPlace): string {
  if (place.name?.trim()) return place.name.trim();
  const first = place.display_name.split(",")[0]?.trim();
  return first || "Unnamed place";
}

function toPlaceResult(place: NominatimPlace): PlaceResult[] {
  const point = toLatLng(place);
  if (!point) return [];

  return [
    {
      placeId: `osm:${place.osm_type ?? "n"}:${place.osm_id ?? place.place_id}`,
      name: toName(place),
      formattedAddress: place.display_name,
      point,
      types: [place.category, place.type].filter((t): t is string => Boolean(t)),
      prominence: toProminence(place),
    },
  ];
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

export class NominatimGeocodingProvider implements GeocodingProvider {
  readonly name = "nominatim";

  constructor(private readonly countryCodes = "ng") {}

  async forward(address: string, bias?: LatLng): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q: address,
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      countrycodes: this.countryCodes,
    });

    if (bias) {
      // A viewbox without `bounded=1` biases rather than filters, which is what
      // we want: a correct answer just outside the box should still surface.
      const d = 0.25;
      params.set(
        "viewbox",
        [bias.lng - d, bias.lat + d, bias.lng + d, bias.lat - d].join(","),
      );
    }

    const results = await throttledFetchJson<NominatimPlace[]>(
      `${BASE}/search?${params.toString()}`,
      { minIntervalMs: MIN_INTERVAL_MS },
    ).catch(() => [] as NominatimPlace[]);

    return results.flatMap((place) => {
      const point = toLatLng(place);
      if (!point) return [];
      return [
        {
          formattedAddress: place.display_name,
          point,
          precision: precisionFromRank(place.place_rank),
          components: place.address,
        },
      ];
    });
  }

  async reverse(point: LatLng): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      lat: String(point.lat),
      lon: String(point.lng),
      format: "jsonv2",
      addressdetails: "1",
    });

    const place = await throttledFetchJson<NominatimPlace | { error: string }>(
      `${BASE}/reverse?${params.toString()}`,
      { minIntervalMs: MIN_INTERVAL_MS },
    ).catch(() => null);

    if (!place || "error" in place) return [];

    const resolved = toLatLng(place);
    if (!resolved) return [];

    return [
      {
        formattedAddress: place.display_name,
        point: resolved,
        precision: precisionFromRank(place.place_rank),
        components: place.address,
      },
    ];
  }
}

/**
 * OSM `place_rank` runs 0 (continent) to 30 (individual building).
 * Mapping it to our precision scale keeps the scorer's discount on vague
 * results working the same way it does with Google's `location_type`.
 */
function precisionFromRank(rank?: number): GeocodeResult["precision"] {
  if (typeof rank !== "number") return "approximate";
  if (rank >= 30) return "rooftop";
  if (rank >= 26) return "interpolated";
  if (rank >= 16) return "centroid";
  return "approximate";
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

/**
 * Nominatim also answers free-text POI queries, so it can serve `textSearch`.
 * `nearbySearch` is delegated to Overpass, which is far better at
 * "everything of this kind within N metres".
 */
export class NominatimPlacesProvider implements PlacesProvider {
  readonly name = "nominatim";

  constructor(
    private readonly nearby: PlacesProvider,
    private readonly countryCodes = "ng",
  ) {}

  async textSearch(input: TextSearchInput): Promise<PlaceResult[]> {
    const params = new URLSearchParams({
      q: input.query,
      format: "jsonv2",
      limit: String(input.maxResults ?? 8),
      addressdetails: "1",
      countrycodes: this.countryCodes,
    });

    if (input.bias) {
      const degrees = Math.max(0.05, input.bias.radiusM / 111_000);
      const { center } = input.bias;
      params.set(
        "viewbox",
        [
          center.lng - degrees,
          center.lat + degrees,
          center.lng + degrees,
          center.lat - degrees,
        ].join(","),
      );
    }

    const results = await throttledFetchJson<NominatimPlace[]>(
      `${BASE}/search?${params.toString()}`,
      { minIntervalMs: MIN_INTERVAL_MS },
    ).catch(() => [] as NominatimPlace[]);

    return results.flatMap(toPlaceResult);
  }

  nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]> {
    return this.nearby.nearbySearch(input);
  }
}
