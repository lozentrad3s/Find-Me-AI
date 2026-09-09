/**
 * Overpass — radius and category search over raw OpenStreetMap data. Free.
 *
 * This is the piece that makes the anchor hop possible without Google. The
 * pipeline needs "find me every mosque within 2 km of here", and Nominatim's
 * free-text search answers that badly while Overpass answers it natively by
 * querying OSM tags directly.
 *
 * The whole file really turns on KEYWORD_TAGS below. A user says "filling
 * station"; OSM calls it `amenity=fuel`. Getting that mapping right is what
 * decides whether a landmark description resolves at all, and it is
 * unavoidably hand-built vocabulary work — which is also why it is a decent
 * place to encode local usage ("bukka", "chemist", "motor park") that a
 * generic gazetteer will not have.
 */

import type {
  NearbySearchInput,
  PlaceResult,
  PlacesProvider,
  TextSearchInput,
} from "@/lib/providers/types";
import { distanceMetres } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";
import { normalise } from "@/lib/text/similarity";

/**
 * Overpass mirrors, tried in order.
 *
 * These are volunteer-run and their load varies enormously — the same query
 * that answered in about two seconds one hour returned nothing at all from the
 * primary an hour later, while two mirrors served it in thirteen. A single
 * hardcoded endpoint therefore means the product intermittently loses category
 * search and landmark lookup for reasons entirely outside its control.
 *
 * Rotation plus a hard per-attempt budget turns a hang into a degraded answer,
 * which is the difference between "slow" and "broken".
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const MIN_INTERVAL_MS = 1200;

/**
 * How long one mirror gets before moving on.
 *
 * Deliberately shorter than Overpass's own query timeout. Waiting the full
 * server-side allowance on a mirror that is already struggling just serialises
 * the failure — better to spend that time asking a different one.
 */
const ATTEMPT_BUDGET_MS = 3_500;
/**
 * Total time the whole rotation may consume.
 *
 * Tight on purpose. Overpass is now a fallback, not the primary source —
 * Nominatim answers category queries in about 1.5s — so its job is to add
 * candidates when it happens to be fast, and get out of the way when it is
 * not. A generous budget here achieved the opposite: three mirrors at seven
 * seconds each turned a slow dependency into a 21-second stall in front of an
 * answer Nominatim had already found.
 */
const TOTAL_BUDGET_MS = 4_000;
/* Overpass honours this server-side. 25s meant a slow query could hold the
   whole response hostage; a landmark lookup that takes longer than 12s is not
   worth waiting for when the answer is decoration on an address. */
const QUERY_TIMEOUT_S = 12;

/**
 * How people say it -> how OSM tags it.
 *
 * Each entry is a list of tag filters; any match counts. Nigerian usage is
 * included deliberately: "chemist" for a pharmacy, "bukka" for a cheap
 * restaurant, "motor park" for a bus station.
 */
const KEYWORD_TAGS: Array<{ match: RegExp; filters: string[] }> = [
  {
    match: /\b(mosque|masjid|jumat|juma'?at)\b/,
    filters: ['["amenity"="place_of_worship"]["religion"="muslim"]', '["building"="mosque"]'],
  },
  {
    match: /\b(church|cathedral|chapel|parish)\b/,
    filters: [
      '["amenity"="place_of_worship"]["religion"="christian"]',
      '["building"="church"]',
    ],
  },
  { match: /\b(place of worship|worship)\b/, filters: ['["amenity"="place_of_worship"]'] },
  {
    match: /\b(filling station|petrol station|fuel station|fuel|petrol|gas station)\b/,
    filters: ['["amenity"="fuel"]'],
  },
  { match: /\b(bank|atm)\b/, filters: ['["amenity"="bank"]', '["amenity"="atm"]'] },
  {
    match: /\b(guest ?house|lodge|lodging|hotel|motel|inn)\b/,
    filters: [
      '["tourism"="hotel"]',
      '["tourism"="guest_house"]',
      '["tourism"="motel"]',
      '["tourism"="hostel"]',
    ],
  },
  {
    match: /\b(restaurant|eatery|bukka|canteen|food|fast ?food|cafe|coffee)\b/,
    filters: [
      '["amenity"="restaurant"]',
      '["amenity"="fast_food"]',
      '["amenity"="cafe"]',
    ],
  },
  {
    match: /\b(hospital|clinic|health ?centre|health ?center|dispensary)\b/,
    filters: ['["amenity"="hospital"]', '["amenity"="clinic"]', '["amenity"="doctors"]'],
  },
  {
    match: /\b(pharmacy|chemist|drug ?store)\b/,
    filters: ['["amenity"="pharmacy"]'],
  },
  { match: /\b(market|marketplace)\b/, filters: ['["amenity"="marketplace"]', '["shop"="mall"]'] },
  {
    match: /\b(supermarket|store|shop|provisions)\b/,
    filters: ['["shop"="supermarket"]', '["shop"="convenience"]', '["shop"="general"]'],
  },
  { match: /\b(mall|plaza|shopping)\b/, filters: ['["shop"="mall"]'] },
  {
    match: /\b(school|university|college|polytechnic|campus)\b/,
    filters: ['["amenity"="school"]', '["amenity"="university"]', '["amenity"="college"]'],
  },
  { match: /\b(police|police station)\b/, filters: ['["amenity"="police"]'] },
  {
    match: /\b(motor ?park|bus ?stop|bus ?station|garage|park and ride)\b/,
    filters: ['["amenity"="bus_station"]', '["highway"="bus_stop"]'],
  },
  { match: /\b(airport|airstrip)\b/, filters: ['["aeroway"="aerodrome"]'] },
  { match: /\b(stadium|sports)\b/, filters: ['["leisure"="stadium"]'] },
  { match: /\b(park|garden|recreation)\b/, filters: ['["leisure"="park"]'] },
  { match: /\b(junction|roundabout|intersection)\b/, filters: ['["junction"]', '["highway"="motorway_junction"]'] },
  { match: /\b(mechanic|workshop|vulcaniz|repair)\b/, filters: ['["shop"="car_repair"]'] },
  { match: /\b(hotel)\b/, filters: ['["tourism"="hotel"]'] },
];

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export class OverpassPlacesProvider implements PlacesProvider {
  readonly name = "overpass";

  /**
   * Overpass has no text search worth the name, so free-text queries are
   * delegated to whatever geocoder was supplied (Nominatim in practice).
   */
  constructor(private readonly textProvider?: PlacesProvider) {}

  async textSearch(input: TextSearchInput): Promise<PlaceResult[]> {
    if (!this.textProvider) return [];
    return this.textProvider.textSearch(input);
  }

  async nearbySearch(input: NearbySearchInput): Promise<PlaceResult[]> {
    const filters = filtersForKeyword(input.keyword);
    const radius = Math.round(input.radiusM);
    const { lat, lng } = input.center;

    // `out center` gives ways and relations a representative point, so a
    // building mapped as a polygon still yields usable coordinates.
    const clauses = filters
      .map((filter) => `nwr(around:${radius},${lat},${lng})${filter};`)
      .join("\n");

    const query = `[out:json][timeout:${QUERY_TIMEOUT_S}];\n(\n${clauses}\n);\nout center ${input.maxResults ?? 20};`;

    const response = await queryWithFailover(query);

    const results = (response.elements ?? []).flatMap((element) =>
      toPlaceResult(element, input.center),
    );

    // Overpass returns unnamed features freely. An unnamed node is useless as
    // a landmark you would say out loud, so named results come first.
    return results
      .sort((a, b) => {
        const named = Number(Boolean(b.name)) - Number(Boolean(a.name));
        if (named !== 0) return named;
        return (
          distanceMetres(input.center, a.point) -
          distanceMetres(input.center, b.point)
        );
      })
      .slice(0, input.maxResults ?? 20);
  }
}

/**
 * Run a query against each mirror in turn until one answers.
 *
 * Returns an empty result rather than throwing when every mirror is
 * unavailable. That is a deliberate choice: losing category search degrades
 * the answer — fewer candidates, no landmark for the driver line — but it must
 * never take down a resolution that Nominatim could still have answered.
 */
async function queryWithFailover(query: string): Promise<OverpassResponse> {
  const startedAt = Date.now();
  const body = new URLSearchParams({ data: query }).toString();

  for (const endpoint of ENDPOINTS) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;

    try {
      return await throttledFetchJson<OverpassResponse>(endpoint, {
        minIntervalMs: MIN_INTERVAL_MS,
        // Keyed on the query, not the URL, so a retry on a different mirror
        // still hits the cache from a previous success.
        cacheKey: `overpass:${query}`,
        timeoutMs: ATTEMPT_BUDGET_MS,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
      });
    } catch {
      // Try the next mirror. Overloaded instances fail in several ways —
      // connection refused, a timeout, or an HTML error page that is not JSON
      // — and all of them mean the same thing here.
      continue;
    }
  }

  return { elements: [] };
}

function filtersForKeyword(keyword?: string): string[] {
  if (!keyword?.trim()) {
    /*
     * No category given — "what is around this point".
     *
     * Three separate tag clauses made this the single slowest call in the
     * product, over ten seconds, because Overpass evaluates each independently
     * across the radius. One clause covers the landmarks people actually
     * navigate by, and anything unnamed is useless as a spoken landmark
     * anyway, so the name filter is doing real work rather than tidying.
     */
    return ['["amenity"]["name"]'];
  }

  const lower = normalise(keyword);
  const matched = KEYWORD_TAGS.filter((entry) => entry.match.test(lower));

  if (matched.length > 0) {
    return matched.flatMap((entry) => entry.filters);
  }

  // Unknown category — fall back to a name substring match across the usual
  // POI keys. Case-insensitive regex match in Overpass QL.
  const escaped = keyword.replace(/["\\]/g, "\\$&");
  return [
    `["name"~"${escaped}",i]["amenity"]`,
    `["name"~"${escaped}",i]["shop"]`,
    `["name"~"${escaped}",i]["tourism"]`,
  ];
}

function toPlaceResult(
  element: OverpassElement,
  centre: { lat: number; lng: number },
): PlaceResult[] {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return [];

  const tags = element.tags ?? {};
  const name = tags.name?.trim();

  const category =
    tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ?? tags.aeroway;

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
  ].filter(Boolean);

  return [
    {
      placeId: `osm:${element.type}:${element.id}`,
      name: name || (category ? titleCase(category.replace(/_/g, " ")) : "Unnamed place"),
      formattedAddress: addressParts.join(", "),
      point: { lat, lng: lon },
      types: [category, tags.religion].filter((t): t is string => Boolean(t)),
      // OSM carries no popularity measure. Naming is the only usable proxy:
      // somebody cared enough to label it, and an unnamed node cannot be
      // spoken aloud as a landmark.
      prominence: name ? 0.35 : 0.05,
    },
  ];
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
