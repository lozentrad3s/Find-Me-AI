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
 *
 * "bus station" verified 2026-09-11: "bus station in Abuja" returns Mabushi
 * Bus Terminal, while "motor park in Abuja" returns nothing — so the words
 * people actually use for it all map onto the one phrase that works.
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
  police: "police",
  mall: "mall",
  airport: "aerodrome",
  church: "church",
  mosque: "mosque",
  park: "park",
  cinema: "cinema",
  stadium: "stadium",
  "bus station": "bus station",
  "bus terminal": "bus station",
  "motor park": "bus station",
  "bus park": "bus station",
};

/**
 * Nominatim's phrase for a category word, tolerating simple plurals — the
 * assistant says "restaurants" as often as "restaurant", and a miss here
 * silently sends the query to the far slower Overpass path.
 */
export function nominatimPhrase(keyword?: string | null): string | null {
  if (!keyword) return null;
  const key = keyword.trim().toLowerCase();
  if (!key) return null;

  return (
    NOMINATIM_CATEGORY[key] ??
    NOMINATIM_CATEGORY[key.replace(/ies$/, "y")] ??
    NOMINATIM_CATEGORY[key.replace(/es$/, "")] ??
    NOMINATIM_CATEGORY[key.replace(/s$/, "")] ??
    null
  );
}

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
  const phrase = nominatimPhrase(placeType);
  if (!phrase) return null;

  const where = [area, city].filter(Boolean).join(", ");
  if (!where) return null;

  return `${phrase} in ${where}`;
}

export interface NominatimPlace {
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
  /** [south, north, west, east] as strings. */
  boundingbox?: [string, string, string, string];
  addresstype?: string;
  address?: Record<string, string>;
  /** Present with `extratags=1`: wikidata, image, website, opening_hours… */
  extratags?: Record<string, string> | null;
  /** Present with `polygon_geojson=1`. */
  geojson?: { type: string; coordinates: unknown };
}

/**
 * A raw Nominatim search, throttled with every other call to the host.
 *
 * Exported for callers that need fields the provider interface does not carry
 * — a road's geometry, a district's bounding box — without opening a second,
 * unthrottled path to the same rate-limited service.
 */
export async function nominatimSearch(
  params: Record<string, string>,
): Promise<NominatimPlace[]> {
  const query = new URLSearchParams({
    format: "jsonv2",
    countrycodes: "ng",
    ...params,
  });

  return throttledFetchJson<NominatimPlace[]>(`${BASE}/search?${query.toString()}`, {
    minIntervalMs: MIN_INTERVAL_MS,
  }).catch(() => [] as NominatimPlace[]);
}

/** Extra tags worth showing about a place: photo links, contact, hours. */
export interface OsmExtras {
  wikidata?: string;
  wikipedia?: string;
  image?: string;
  commons?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
}

function toLookupId(placeId: string): string | null {
  const match = /^osm:(node|way|relation|n|w|r):(\d+)$/i.exec(placeId);
  if (!match) return null;
  return `${match[1]![0]!.toUpperCase()}${match[2]}`;
}

/**
 * Photo links and contact details for places already found, by OSM id.
 *
 * One request for up to twenty places. This is how a resolved hotel gets its
 * Wikidata photo: the id came back from the search, and the tags come from
 * here.
 */
export async function lookupOsmExtras(
  placeIds: string[],
): Promise<Map<string, OsmExtras>> {
  const ids = [...new Set(placeIds.map(toLookupId).filter((id): id is string => Boolean(id)))]
    .slice(0, 20);

  const extras = new Map<string, OsmExtras>();
  if (ids.length === 0) return extras;

  const params = new URLSearchParams({
    osm_ids: ids.join(","),
    format: "jsonv2",
    extratags: "1",
  });

  const places = await throttledFetchJson<NominatimPlace[]>(
    `${BASE}/lookup?${params.toString()}`,
    { minIntervalMs: MIN_INTERVAL_MS, ttlMs: 24 * 60 * 60 * 1000 },
  ).catch(() => [] as NominatimPlace[]);

  for (const place of places) {
    const tags = place.extratags ?? {};
    const key = `osm:${place.osm_type}:${place.osm_id}`;
    extras.set(key, {
      wikidata: tags.wikidata,
      wikipedia: tags.wikipedia,
      image: tags.image,
      commons: tags.wikimedia_commons,
      website: tags.website ?? tags["contact:website"],
      phone: tags.phone ?? tags["contact:phone"],
      openingHours: tags.opening_hours,
    });
  }

  return extras;
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

function toBbox(place: NominatimPlace): GeocodeResult["bbox"] {
  const box = place.boundingbox;
  if (!box || box.length !== 4) return undefined;

  const [south, north, west, east] = box.map((value) => Number.parseFloat(value));
  if (![south, north, west, east].every((value) => Number.isFinite(value))) return undefined;

  return { south: south!, north: north!, west: west!, east: east! };
}

/**
 * How precisely this result locates a point, 0..1.
 *
 * Two independent signals, and the lower wins:
 *
 * `place_rank` is OSM's own hierarchy, 0 (continent) to 30 (single building).
 * A rank-30 hit is a specific address; a rank-16 hit is a whole suburb whose
 * "coordinate" is just its centre.
 *
 * The bounding box is the physical reality check. A result can carry a high
 * rank while spanning kilometres, and a point returned for a 5km box is a
 * centroid however precise its rank claims to be.
 *
 * This was previously computed for geocoder results and then thrown away —
 * nothing in the scorer read it — so a district centroid competed on equal
 * footing with a rooftop match. That is the single most direct cause of an
 * imprecise pin.
 */
function toPrecision(place: NominatimPlace): number | undefined {
  const rank = place.place_rank;
  const byRank =
    typeof rank === "number"
      ? Math.min(1, Math.max(0, (rank - 12) / 18))
      : undefined;

  const box = toBbox(place);
  let byExtent: number | undefined;

  if (box) {
    // Rough metres across, using the larger dimension.
    const latSpan = Math.abs(box.north - box.south) * 111_320;
    const lngSpan =
      Math.abs(box.east - box.west) * 111_320 * Math.cos((box.south * Math.PI) / 180);
    const span = Math.max(latSpan, lngSpan);

    // ~50m across is a building; ~2km is a district.
    byExtent = span <= 50 ? 1 : span >= 2000 ? 0.1 : 1 - (span - 50) / 1950;
  }

  if (byRank === undefined) return byExtent;
  if (byExtent === undefined) return byRank;

  // Believe the more pessimistic of the two.
  return Math.min(byRank, byExtent);
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
      providerConfidence: toPrecision(place),
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
          name: place.name?.trim() || undefined,
          kind: place.addresstype ?? place.type,
          bbox: toBbox(place),
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
        name: place.name?.trim() || undefined,
        kind: place.addresstype ?? place.type,
        bbox: toBbox(place),
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

  /**
   * Radius search, on Nominatim when it can answer and Overpass otherwise.
   *
   * A `bounded=1` viewbox query is effectively a radius search, and measured
   * against the live services it returned six pharmacies around Maitama in
   * 2.3s while the Overpass path returned nothing at all — Overpass is
   * volunteer-run and its load varies enormously.
   *
   * So the reliable path runs first and Overpass becomes the fallback for
   * categories outside Nominatim's vocabulary, where it is genuinely the only
   * option. This is the same division of labour the resolution pipeline
   * settled on, applied here so Explore and the assistant both benefit.
   */
  async nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]> {
    const phrase = nominatimPhrase(input.keyword);

    if (!phrase) return this.nearby.nearbySearch(input);

    const { center, radiusM } = input;

    // Longitude degrees shrink with latitude, so the box would be too narrow
    // near the poles without the cosine term. Abuja is near the equator, but
    // getting this wrong silently is not worth saving a line.
    const latDelta = radiusM / 111_320;
    const lngDelta = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));

    const params = new URLSearchParams({
      q: phrase,
      format: "jsonv2",
      limit: String(input.maxResults ?? 15),
      addressdetails: "1",
      bounded: "1",
      viewbox: [
        center.lng - lngDelta,
        center.lat + latDelta,
        center.lng + lngDelta,
        center.lat - latDelta,
      ].join(","),
      countrycodes: this.countryCodes,
    });

    const results = await throttledFetchJson<NominatimPlace[]>(
      `${BASE}/search?${params.toString()}`,
      { minIntervalMs: MIN_INTERVAL_MS },
    ).catch(() => [] as NominatimPlace[]);

    /*
     * Only rows with a real `name` survive.
     *
     * This filters on the raw field rather than the derived one, and the
     * distinction is not pedantic. `toName` falls back to the first segment of
     * `display_name`, which for an unnamed POI is the *street* — so an
     * unnamed pharmacy came back as "Gana Street", and the assistant duly
     * announced "Nearest pharmacy: Gana Street, 170 m away".
     *
     * That is worse than returning nothing: it is a confident, specific,
     * wrong answer, which is the one failure this product cannot afford. An
     * unnamed node also cannot be said aloud to a driver or recognised in a
     * list, so it has no value here even when it is real.
     */
    const named = results
      .filter((place) => Boolean(place.name?.trim()))
      .flatMap(toPlaceResult);

    if (named.length === 0) return this.nearby.nearbySearch(input);

    return named;
  }
}
