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
  // kumi.systems was retired — its hostname stopped resolving (measured
  // 2026-09-11). The VK-run mirror answered the same probe in about 5s.
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
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
 *
 * Plurals are matched too. The assistant asks for "restaurants" as often as
 * "restaurant", and a pattern that only matched the singular sent those
 * searches to the name-substring fallback, which finds almost nothing.
 *
 * `exclude` stops a rule firing inside a longer phrase that means something
 * else: a "bus park" is where buses leave from, not a garden.
 */
const KEYWORD_TAGS: Array<{ match: RegExp; exclude?: RegExp; filters: string[] }> = [
  {
    match: /\b(mosques?|masjid|jumat|juma'?at)\b/,
    filters: ['["amenity"="place_of_worship"]["religion"="muslim"]', '["building"="mosque"]'],
  },
  {
    match: /\b(church(es)?|cathedral|chapel|parish)\b/,
    filters: [
      '["amenity"="place_of_worship"]["religion"="christian"]',
      '["building"="church"]',
    ],
  },
  { match: /\b(place of worship|worship)\b/, filters: ['["amenity"="place_of_worship"]'] },
  {
    match: /\b(filling stations?|petrol stations?|fuel stations?|fuel|petrol|gas stations?|diesel)\b/,
    filters: ['["amenity"="fuel"]'],
  },
  { match: /\bbanks?\b/, filters: ['["amenity"="bank"]'] },
  { match: /\b(atms?|cash machines?)\b/, filters: ['["amenity"="atm"]', '["amenity"="bank"]'] },
  {
    match: /\b(guest ?houses?|lodges?|lodging|hotels?|motels?|inns?)\b/,
    filters: [
      '["tourism"="hotel"]',
      '["tourism"="guest_house"]',
      '["tourism"="motel"]',
      '["tourism"="hostel"]',
    ],
  },
  {
    match: /\b(restaurants?|eatery|eateries|bukka|buka|canteen|food|fast ?food|cafes?|coffee|suya)\b/,
    filters: [
      '["amenity"="restaurant"]',
      '["amenity"="fast_food"]',
      '["amenity"="cafe"]',
    ],
  },
  {
    match: /\b(hospitals?|clinics?|health ?cent(re|er)s?|dispensary)\b/,
    filters: ['["amenity"="hospital"]', '["amenity"="clinic"]', '["amenity"="doctors"]'],
  },
  {
    match: /\b(pharmac(y|ies)|chemists?|drug ?stores?)\b/,
    filters: ['["amenity"="pharmacy"]'],
  },
  {
    match: /\b(markets?|marketplace)\b/,
    exclude: /\bsuper ?markets?\b/,
    filters: ['["amenity"="marketplace"]', '["shop"="mall"]'],
  },
  {
    match: /\b(supermarkets?|stores?|shops?|provisions|groceries|grocery)\b/,
    filters: ['["shop"="supermarket"]', '["shop"="convenience"]', '["shop"="general"]'],
  },
  { match: /\b(malls?|plaza|shopping)\b/, filters: ['["shop"="mall"]'] },
  {
    match: /\b(schools?|universit(y|ies)|colleges?|polytechnic|campus)\b/,
    filters: ['["amenity"="school"]', '["amenity"="university"]', '["amenity"="college"]'],
  },
  { match: /\b(police|police stations?)\b/, filters: ['["amenity"="police"]'] },
  {
    // Where intercity buses leave from. Measured against live OSM, Abuja's
    // terminals are tagged amenity=bus_station, some also as a bus
    // public_transport station — so both are asked for.
    match: /\b(motor ?parks?|bus ?stations?|bus ?terminals?|bus ?parks?|terminals?|luxury bus|park and ride)\b/,
    filters: ['["amenity"="bus_station"]', '["public_transport"="station"]["bus"="yes"]'],
  },
  { match: /\bbus ?stops?\b/, filters: ['["highway"="bus_stop"]'] },
  { match: /\b(taxi ranks?|taxi)\b/, filters: ['["amenity"="taxi"]'] },
  { match: /\b(train stations?|railway stations?|rail)\b/, filters: ['["railway"="station"]'] },
  { match: /\b(airports?|airstrip)\b/, filters: ['["aeroway"="aerodrome"]'] },
  { match: /\b(stadiums?|sports)\b/, filters: ['["leisure"="stadium"]'] },
  {
    match: /\b(parks?|gardens?|recreation)\b/,
    exclude: /\b(bus|motor|car) ?parks?\b/,
    filters: ['["leisure"="park"]'],
  },
  { match: /\b(car ?parks?|parking)\b/, filters: ['["amenity"="parking"]'] },
  {
    match: /\b(junctions?|roundabouts?|intersections?)\b/,
    filters: ['["junction"]', '["highway"="motorway_junction"]'],
  },
  {
    match: /\b(mechanics?|workshops?|vulcani[sz]\w*|repair)\b/,
    filters: ['["shop"="car_repair"]', '["shop"="tyres"]'],
  },
  { match: /\bcar ?wash\b/, filters: ['["amenity"="car_wash"]'] },
  { match: /\b(cinemas?|movies?|film house)\b/, filters: ['["amenity"="cinema"]'] },
  {
    match: /\b(gyms?|fitness)\b/,
    filters: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]'],
  },
  {
    match: /\b(embass(y|ies)|high commission|consulate)\b/,
    filters: ['["office"="diplomatic"]', '["amenity"="embassy"]'],
  },
  { match: /\b(fire stations?|fire service)\b/, filters: ['["amenity"="fire_station"]'] },
  {
    match: /\b(bars?|pubs?|lounges?|nightclubs?)\b/,
    filters: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="nightclub"]'],
  },
  { match: /\b(bakery|bakeries)\b/, filters: ['["shop"="bakery"]'] },
  {
    match: /\b(event cent(re|er)s?|event halls?)\b/,
    filters: ['["amenity"="events_venue"]', '["amenity"="community_centre"]'],
  },
];

export interface OverpassElement {
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
 * Run an arbitrary Overpass QL query through the same mirror rotation, budget
 * and cache as category search. Returns an empty list when every mirror is
 * down, never throws.
 */
export async function overpassQuery(
  query: string,
  totalBudgetMs = TOTAL_BUDGET_MS,
  attemptBudgetMs = ATTEMPT_BUDGET_MS,
): Promise<OverpassElement[]> {
  const response = await queryWithFailover(query, totalBudgetMs, attemptBudgetMs);
  return response.elements ?? [];
}

/**
 * Run a query against each mirror in turn until one answers.
 *
 * Returns an empty result rather than throwing when every mirror is
 * unavailable. That is a deliberate choice: losing category search degrades
 * the answer — fewer candidates, no landmark for the driver line — but it must
 * never take down a resolution that Nominatim could still have answered.
 *
 * `attemptBudgetMs` is per mirror. A heavier query (every landmark in a
 * district) needs more than the default: measured, the main mirror answered
 * one in about three seconds while both others timed out at twenty-five, so
 * cutting the main one off at 3.5s threw away the only answer coming.
 */
async function queryWithFailover(
  query: string,
  totalBudgetMs = TOTAL_BUDGET_MS,
  attemptBudgetMs = ATTEMPT_BUDGET_MS,
): Promise<OverpassResponse> {
  const startedAt = Date.now();
  const body = new URLSearchParams({ data: query }).toString();

  for (const endpoint of ENDPOINTS) {
    const remaining = totalBudgetMs - (Date.now() - startedAt);
    if (remaining <= 250) break;

    try {
      return await throttledFetchJson<OverpassResponse>(endpoint, {
        minIntervalMs: MIN_INTERVAL_MS,
        // Keyed on the query, not the URL, so a retry on a different mirror
        // still hits the cache from a previous success.
        cacheKey: `overpass:${query}`,
        timeoutMs: Math.min(attemptBudgetMs, remaining),
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
     * This was cut to a single `amenity` clause for speed, and that went too
     * far: a scan around Maitama returned nothing at all at 400m, while the
     * same point with `shop` and `office` included returned twelve real
     * landmarks — a filling station, three restaurants, a supermarket. In
     * Abuja a great deal of what people navigate by is tagged `shop`, not
     * `amenity`, so dropping it removed most of the useful answers.
     *
     * Three clauses cost a few hundred milliseconds against a budget that
     * already degrades gracefully. Being empty is worse. The name filter
     * stays: an unnamed node cannot be spoken aloud as a landmark.
     */
    return ['["amenity"]["name"]', '["shop"]["name"]', '["office"]["name"]'];
  }

  const lower = normalise(keyword);
  const matched = KEYWORD_TAGS.filter(
    (entry) => entry.match.test(lower) && !entry.exclude?.test(lower),
  );

  if (matched.length > 0) {
    return [...new Set(matched.flatMap((entry) => entry.filters))];
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
  void centre;
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return [];

  const tags = element.tags ?? {};
  const name = tags.name?.trim();

  const category =
    tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ?? tags.aeroway ?? tags.railway;

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
