/**
 * "Where is Maitama?" — a district, explained the way a local would.
 *
 * Someone asking where a district is rarely wants a coordinate. They want to
 * know what it is and what is in it, so they can pick the part they are going
 * to: "Maitama is a district in Abuja; it has Millennium Park, the Transcorp
 * Hilton, the embassies along Aguiyi Ironsi Street…". That is three lookups,
 * run in parallel:
 *
 *   - the geocoder, for where it is and how big it is
 *   - Wikipedia, for what it is, and for photos
 *   - OpenStreetMap, for the named landmarks, junctions and main roads inside
 *
 * Misspellings are corrected first against the gazetteer, and the correction
 * is reported so the assistant can say "did you mean Maitama?" rather than
 * silently answering a different question.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import type { GeocodeResult, Providers } from "@/lib/providers/types";
import { ABUJA, localCentre } from "@/lib/geo/cities";
import { correctPlaceName } from "@/lib/geo/gazetteer";
import { overpassQuery, type OverpassElement } from "@/lib/providers/osm/overpass";
import { lookupPlaceOnWeb, type WebImage } from "@/lib/web/wikimedia";
import { tokenSimilarity } from "@/lib/text/similarity";

/** Beyond this from the city centre, a match is a same-named place elsewhere. */
const CITY_RADIUS_M = 45_000;
/** A district box is clamped to this half-width so Overpass stays fast. */
const MAX_HALF_SPAN_M = 3_000;
const MIN_HALF_SPAN_M = 900;
/**
 * The landmark query is the heaviest Overpass call in the app. Measured on
 * the main mirror it takes about three seconds for a district, so it gets
 * room for one full attempt rather than the default quick-fail budget.
 */
const LANDMARK_ATTEMPT_MS = 5_500;
const LANDMARK_TOTAL_MS = 6_000;

/**
 * Geocoder result types that describe an area rather than a building.
 *
 * The first result for "Maitama, Abuja" is the German embassy — a building
 * whose address is in Maitama — and the district's own boundary comes second.
 * Taking the first hit named the whole district after an embassy.
 */
const AREA_KINDS = new Set([
  "suburb",
  "neighbourhood",
  "quarter",
  "city_district",
  "district",
  "residential",
  "borough",
  "village",
  "town",
  "hamlet",
  "city",
  "administrative",
  "municipality",
]);

export interface AreaLandmark {
  name: string;
  category: string;
  lat: number;
  lng: number;
}

export interface AreaReport {
  /** As the user said it. */
  query: string;
  /** Canonical name. */
  name: string;
  /** Set when the name was spelling-corrected — say "did you mean". */
  corrected_from: string | null;
  found: boolean;
  centre: LatLng | null;
  description: string | null;
  wikipedia_url: string | null;
  landmarks: AreaLandmark[];
  junctions: string[];
  main_roads: string[];
  images: WebImage[];
  note: string | null;
}

interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** What each kind of feature is called out loud, and how notable it is. */
const FEATURE_KINDS: Array<{ test: (t: Record<string, string>) => boolean; label: string; weight: number }> = [
  { test: (t) => /^(attraction|museum|gallery|viewpoint)$/.test(t.tourism ?? ""), label: "attraction", weight: 3 },
  { test: (t) => t.leisure === "park", label: "park", weight: 3 },
  { test: (t) => t.leisure === "golf_course", label: "golf course", weight: 2.5 },
  { test: (t) => t.leisure === "stadium", label: "stadium", weight: 2.5 },
  { test: (t) => t.shop === "mall", label: "shopping mall", weight: 2.5 },
  { test: (t) => t.amenity === "marketplace", label: "market", weight: 2.2 },
  { test: (t) => t.tourism === "hotel", label: "hotel", weight: 2 },
  { test: (t) => t.amenity === "hospital", label: "hospital", weight: 2 },
  { test: (t) => t.amenity === "university", label: "university", weight: 2 },
  { test: (t) => Boolean(t.historic), label: "historic site", weight: 2 },
  { test: (t) => t.amenity === "bus_station", label: "bus terminal", weight: 1.8 },
  { test: (t) => t.office === "diplomatic" || t.amenity === "embassy", label: "embassy", weight: 1.5 },
  { test: (t) => t.office === "government" || t.amenity === "townhall" || t.amenity === "courthouse", label: "government office", weight: 1.5 },
  { test: (t) => t.amenity === "place_of_worship", label: "place of worship", weight: 1.4 },
  { test: (t) => t.amenity === "police", label: "police station", weight: 1.2 },
];

const ROAD_RANK: Record<string, number> = { motorway: 4, trunk: 3, primary: 2, secondary: 1 };

function boxAround(centre: LatLng, halfSpanM: number): Box {
  const dLat = halfSpanM / 111_320;
  const dLng = halfSpanM / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  return {
    south: centre.lat - dLat,
    north: centre.lat + dLat,
    west: centre.lng - dLng,
    east: centre.lng + dLng,
  };
}

/** The geocoder's box, clamped so a sprawling match cannot stall Overpass. */
function clampBox(centre: LatLng, box?: Box): Box {
  if (!box) return boxAround(centre, 1_500);

  const halfLat = ((box.north - box.south) / 2) * 111_320;
  const halfLng = ((box.east - box.west) / 2) * 111_320 * Math.cos((centre.lat * Math.PI) / 180);
  const half = Math.min(MAX_HALF_SPAN_M, Math.max(MIN_HALF_SPAN_M, Math.max(halfLat, halfLng)));
  return boxAround(centre, half);
}

function notableQuery(box: Box): string {
  const b = `(${box.south},${box.west},${box.north},${box.east})`;
  return `[out:json][timeout:10];
(
  nwr["tourism"~"^(hotel|attraction|museum|gallery|viewpoint)$"]["name"]${b};
  nwr["leisure"~"^(park|golf_course|stadium)$"]["name"]${b};
  nwr["amenity"~"^(hospital|university|marketplace|embassy|townhall|courthouse|police|bus_station|place_of_worship)$"]["name"]${b};
  nwr["office"~"^(diplomatic|government)$"]["name"]${b};
  nwr["shop"="mall"]["name"]${b};
  nwr["historic"]["name"]${b};
  node["junction"]["name"]${b};
  way["junction"="roundabout"]["name"]${b};
  way["highway"~"^(motorway|trunk|primary|secondary)$"]["name"]${b};
);
out tags center 200;`;
}

function pointOf(element: OverpassElement): LatLng | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

function summariseFeatures(elements: OverpassElement[]): {
  landmarks: AreaLandmark[];
  junctions: string[];
  roads: string[];
} {
  const landmarks = new Map<string, AreaLandmark & { score: number }>();
  const junctions = new Set<string>();
  const roads = new Map<string, number>();

  for (const element of elements) {
    const tags = element.tags ?? {};
    const name = tags.name?.trim();
    if (!name) continue;

    if (tags.highway && ROAD_RANK[tags.highway] !== undefined && element.type === "way" && !tags.junction) {
      roads.set(name, Math.max(roads.get(name) ?? 0, ROAD_RANK[tags.highway]!));
      continue;
    }

    if (tags.junction || tags.highway === "motorway_junction") {
      junctions.add(name);
      continue;
    }

    const kind = FEATURE_KINDS.find((entry) => entry.test(tags));
    const point = pointOf(element);
    if (!kind || !point) continue;

    // A Wikidata link means somebody considered it notable enough to catalogue.
    const score = kind.weight + (tags.wikidata || tags.wikipedia ? 2 : 0) + (tags.stars && Number(tags.stars) >= 4 ? 1 : 0);
    const key = name.toLowerCase();
    const existing = landmarks.get(key);
    if (!existing || existing.score < score) {
      landmarks.set(key, { name, category: kind.label, lat: point.lat, lng: point.lng, score });
    }
  }

  return {
    landmarks: [...landmarks.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ score: _score, ...landmark }) => landmark),
    junctions: [...junctions].slice(0, 5),
    roads: [...roads.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 6),
  };
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The geocoder result that IS the area: an area-type feature whose name
 * matches, or failing that any feature actually named like it. A building
 * that merely has the area in its address is never chosen.
 */
function pickAreaHit(results: GeocodeResult[], name: string): GeocodeResult | null {
  const inCity = results.filter((result) => distanceMetres(result.point, ABUJA.centre) <= CITY_RADIUS_M);

  const area = inCity.find(
    (result) =>
      result.kind !== undefined &&
      AREA_KINDS.has(result.kind) &&
      (!result.name || tokenSimilarity(result.name, name) >= 0.6),
  );
  if (area) return area;

  return inCity.find((result) => result.name && tokenSimilarity(result.name, name) >= 0.75) ?? null;
}

/**
 * Landmarks from the geocoder, for when Overpass does not answer.
 *
 * Thinner than the Overpass list — a few category searches rather than every
 * notable feature — but Nominatim is reliable where Overpass is not, and a
 * short list is far better than none.
 */
async function landmarksFromGeocoder(
  name: string,
  centre: LatLng,
  providers: Providers,
): Promise<AreaLandmark[]> {
  const found: AreaLandmark[] = [];
  const seen = new Set<string>();

  for (const [category, label] of [
    ["hotel", "hotel"],
    ["park", "park"],
    ["mall", "shopping mall"],
  ] as const) {
    const results = await providers.places
      .textSearch({ query: `${category} in ${name}, Abuja`, maxResults: 5 })
      .catch(() => []);

    for (const place of results) {
      const key = place.name.toLowerCase();
      if (seen.has(key) || distanceMetres(place.point, centre) > 4_000) continue;
      seen.add(key);
      found.push({ name: place.name, category: label, lat: place.point.lat, lng: place.point.lng });
    }
  }

  return found.slice(0, 8);
}

export async function exploreArea(query: string, providers: Providers): Promise<AreaReport> {
  const asked = query.replace(/[?.!]+$/, "").trim();
  const match = correctPlaceName(asked);
  const name = match ? match.name : titleCase(asked);
  const correctedFrom = match && !match.exact ? asked : null;

  const [geocoded, web] = await Promise.all([
    providers.geocoding.forward(`${name}, Abuja`, ABUJA.centre).catch(() => []),
    lookupPlaceOnWeb({ name, area: "Abuja", near: ABUJA.centre }),
  ]);

  const hit = pickAreaHit(geocoded, name);

  const centre =
    hit?.point ??
    localCentre(name.toLowerCase(), "abuja")?.point ??
    web.summary?.coordinates ??
    null;

  if (!centre) {
    return {
      query: asked,
      name,
      corrected_from: correctedFrom,
      found: false,
      centre: null,
      description: web.summary?.extract ?? null,
      wikipedia_url: web.summary?.url ?? null,
      landmarks: [],
      junctions: [],
      main_roads: [],
      images: web.images,
      note: `"${name}" was not found in the Abuja map data. Ask which area it is near, rather than guessing.`,
    };
  }

  const box = clampBox(centre, hit?.bbox);

  /*
   * Overpass is volunteer-run and sometimes simply does not answer. The
   * geocoder is a thinner but reliable substitute, so it starts at the same
   * time rather than after Overpass has used up its budget — measured, doing
   * them one after the other made "where is Wuse 2" take sixteen seconds.
   */
  const fallback = landmarksFromGeocoder(name, centre, providers).catch(() => [] as AreaLandmark[]);
  let features = summariseFeatures(
    await overpassQuery(notableQuery(box), LANDMARK_TOTAL_MS, LANDMARK_ATTEMPT_MS),
  );

  if (features.landmarks.length === 0) {
    features = { ...features, landmarks: await fallback };
  }

  return {
    query: asked,
    // The canonical name, never a building's: see pickAreaHit.
    name,
    corrected_from: correctedFrom,
    found: true,
    centre,
    description: web.summary?.extract ?? null,
    wikipedia_url: web.summary?.url ?? null,
    landmarks: features.landmarks,
    junctions: features.junctions,
    main_roads: features.roads,
    images: web.images,
    note:
      features.landmarks.length === 0
        ? "No named landmarks came back from the map data for this area just now. Describe it from the description if there is one, and say the landmark list is unavailable."
        : null,
  };
}
