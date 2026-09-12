/**
 * GET /api/pois?south=&west=&north=&east= — the named places in view.
 *
 * Google's map is covered in pharmacies, schools and lounges because Google
 * has business listings. OpenStreetMap has far fewer in Abuja — measured, five
 * named places in a 2 km box around Dutse — but five labelled places beat an
 * empty beige map, and they are the places a person navigates by.
 *
 * Server-side so the Overpass call is throttled and cached in one place rather
 * than once per phone, and so a slow mirror degrades to "no extra labels"
 * instead of a spinner on the map.
 */

import { overpassQuery, type OverpassElement } from "@/lib/providers/osm/overpass";

export const runtime = "nodejs";

/** Above this the query is too big to be either fast or useful. */
const MAX_SPAN_DEG = 0.08; // roughly 9 km
const MAX_RESULTS = 120;
/**
 * Budgets, set from measurement rather than taste.
 *
 * From a laptop the main Overpass mirror answers this query in about a
 * second. From Vercel's Frankfurt region it is far less predictable: boxes
 * over Wuse 2 and Dutse answered in 1.7-2.7s, while a box over the Central
 * Business District — denser, so a heavier query — burned the whole 12s
 * budget across every mirror and returned nothing.
 *
 * Thirteen seconds of blank map is worse than a quick blank map, so the
 * budget is back down to something a person would not notice waiting for.
 * The real fix for density is the cache below: one slow miss populates the
 * edge for half an hour, and the misses stop.
 */
const TOTAL_BUDGET_MS = 6_000;
const ATTEMPT_BUDGET_MS = 5_000;

/** Which pin to draw. Keep in step with the icons in MapView. */
const CATEGORY: Array<{ test: (tags: Record<string, string>) => boolean; kind: string }> = [
  { test: (t) => /^(restaurant|fast_food|cafe|bar|pub|nightclub)$/.test(t.amenity ?? ""), kind: "food" },
  { test: (t) => t.amenity === "fuel", kind: "fuel" },
  { test: (t) => t.amenity === "pharmacy", kind: "pharmacy" },
  { test: (t) => /^(hospital|clinic|doctors)$/.test(t.amenity ?? ""), kind: "health" },
  { test: (t) => /^(school|college|university|kindergarten)$/.test(t.amenity ?? ""), kind: "school" },
  { test: (t) => /^(bank|atm|bureau_de_change)$/.test(t.amenity ?? ""), kind: "bank" },
  { test: (t) => t.amenity === "place_of_worship", kind: "worship" },
  { test: (t) => t.amenity === "police" || t.amenity === "fire_station", kind: "police" },
  { test: (t) => t.amenity === "bus_station" || t.public_transport === "station", kind: "transport" },
  { test: (t) => t.amenity === "marketplace" || t.shop === "mall" || t.shop === "supermarket", kind: "shopping" },
  { test: (t) => /^(hotel|guest_house|motel|hostel)$/.test(t.tourism ?? ""), kind: "hotel" },
  { test: (t) => /^(park|stadium|fitness_centre|sports_centre)$/.test(t.leisure ?? ""), kind: "leisure" },
  { test: (t) => Boolean(t.shop), kind: "shop" },
  { test: (t) => Boolean(t.office) || Boolean(t.amenity) || Boolean(t.tourism), kind: "place" },
];

function query(south: number, west: number, north: number, east: number): string {
  const box = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:12];
(
  nwr["amenity"~"^(restaurant|fast_food|cafe|bar|pub|fuel|pharmacy|hospital|clinic|doctors|school|college|university|kindergarten|bank|atm|marketplace|place_of_worship|police|fire_station|bus_station|cinema|library|courthouse|townhall)$"]["name"]${box};
  nwr["shop"~"^(supermarket|mall|convenience|bakery|butcher|car_repair|hardware|mobile_phone|clothes|electronics|furniture)$"]["name"]${box};
  nwr["tourism"~"^(hotel|guest_house|motel|hostel|attraction|museum)$"]["name"]${box};
  nwr["leisure"~"^(park|stadium|fitness_centre|sports_centre)$"]["name"]${box};
  nwr["office"~"^(government|diplomatic)$"]["name"]${box};
);
out center ${MAX_RESULTS};`;
}

function pointOf(element: OverpassElement): { lat: number; lng: number } | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const south = Number.parseFloat(searchParams.get("south") ?? "");
  const west = Number.parseFloat(searchParams.get("west") ?? "");
  const north = Number.parseFloat(searchParams.get("north") ?? "");
  const east = Number.parseFloat(searchParams.get("east") ?? "");

  if (![south, west, north, east].every(Number.isFinite) || north <= south || east <= west) {
    return Response.json({ error: "south, west, north and east are required." }, { status: 400 });
  }

  if (north - south > MAX_SPAN_DEG || east - west > MAX_SPAN_DEG) {
    return Response.json(
      { places: [], note: "Zoom in to see places." },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  const startedAt = Date.now();
  const elements = await overpassQuery(
    query(south, west, north, east),
    TOTAL_BUDGET_MS,
    ATTEMPT_BUDGET_MS,
  ).catch(() => []);

  /*
   * Empty because nobody mapped it, or empty because nobody answered?
   *
   * Those are different facts and the map should not conflate them. A query
   * that comes back empty in a few hundred milliseconds really did find
   * nothing; one that comes back empty after the whole budget means every
   * mirror timed out — which is what production was doing while the same
   * query answered from a laptop in about a second.
   */
  const exhausted = Date.now() - startedAt > TOTAL_BUDGET_MS * 0.8;

  const seen = new Set<string>();
  const places = elements.flatMap((element) => {
    const tags = element.tags ?? {};
    const name = tags.name?.trim();
    const point = pointOf(element);
    if (!name || !point) return [];

    const key = name.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);

    return [
      {
        id: `${element.type}:${element.id}`,
        name,
        kind: CATEGORY.find((entry) => entry.test(tags))?.kind ?? "place",
        lat: point.lat,
        lng: point.lng,
      },
    ];
  });

  return Response.json(
    {
      places,
      count: places.length,
      /*
       * An outage and a blank neighbourhood look identical from the outside,
       * and saying "nothing is mapped here" when the truth is "nobody
       * answered" teaches people to distrust the map for no reason.
       */
      unavailable: places.length === 0 && exhausted,
      note:
        places.length > 0
          ? null
          : exhausted
            ? "The map data service did not answer in time, so labels are missing here. This is an outage, not an empty neighbourhood."
            : "No named places are mapped in this view. OpenStreetMap coverage is uneven in Nigeria.",
    },

    {
      headers: {
        // Places do not move, so a success is cached hard at the edge: one
        // slow miss over a dense area serves every later viewer instantly,
        // which is the only thing that makes the volunteer service viable
        // here. A failure must NOT be cached for half an hour, or one bad
        // moment blanks that neighbourhood for everyone until it expires.
        "Cache-Control": exhausted
          ? "public, max-age=15, s-maxage=30"
          : "public, max-age=600, s-maxage=1800, stale-while-revalidate=86400",
      },
    },
  );
}
