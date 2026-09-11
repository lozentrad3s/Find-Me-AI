/**
 * "Is there traffic on Sani Abacha Way?" — traffic on a road, by name.
 *
 * Route traffic answers "how is my drive"; this answers the question people
 * actually ask before leaving, about one road they already know. It finds the
 * road in OpenStreetMap by name, samples live speeds at points spread along
 * its length, and returns both a verdict and the road's shape so the map can
 * colour it.
 *
 * Nominatim, not Overpass, finds the road. Measured: an Overpass name search
 * across Abuja timed out (504) on the main mirror, while Nominatim returned
 * every segment of Sani Abacha Way with its geometry in about a second.
 *
 * Two honest outcomes that are easy to get wrong:
 *
 * - A road that exists only as a plan. "Murtala Mohammed Expressway" is in the
 *   Abuja data as `highway=proposed`. Reporting traffic on it would mean
 *   sampling a road nobody can drive on, so it is reported as not built.
 * - No traffic source. Without a TomTom key the road is still found and drawn,
 *   and the report says traffic is unknown rather than guessing from nothing.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { encodePolyline } from "@/lib/geo/polyline";
import { correctPlaceName } from "@/lib/geo/gazetteer";
import { nominatimSearch, type NominatimPlace } from "@/lib/providers/osm/nominatim";
import { tokenSimilarity } from "@/lib/text/similarity";
import {
  levelFromRatio,
  LEVEL_PHRASE,
  type CongestionLevel,
  type TrafficProvider,
} from "./types";

/** Abuja and the satellite towns people commute from: west,north,east,south. */
const ABUJA_VIEWBOX = "7.20,9.25,7.65,8.85";
/** Road states that cannot carry traffic. */
const NOT_BUILT = new Set(["proposed", "construction", "abandoned", "disused", "planned", "razed"]);
/** Each sample is one request against the traffic provider's daily quota. */
const SAMPLES_PER_ROAD = 5;
/** Segments drawn on the map; a long road can have dozens. */
const MAX_LINES = 40;

const STREET_WORDS = /\b(road|rd|way|street|st|avenue|ave|crescent|close|drive|lane|expressway|express|highway|boulevard)\b/gi;

export interface RoadReading {
  point: LatLng;
  level: CongestionLevel;
  currentSpeedKph: number;
  freeFlowSpeedKph: number;
  roadClosed: boolean;
}

export interface RoadTrafficReport {
  /** The road as the user said it. */
  query: string;
  /** Official name from the map data. */
  road: string | null;
  /** Set when the name was spelling-corrected before searching. */
  corrected_from: string | null;
  status: "open" | "not_built" | "not_found";
  /** OSM road class of the main segment: motorway, trunk, primary… */
  road_class: string | null;
  traffic: {
    available: boolean;
    level: CongestionLevel;
    /** Safe to read aloud. */
    summary: string;
    worst_level: CongestionLevel | null;
    closure: boolean;
    readings: RoadReading[];
  };
  /** Encoded polylines, one per mapped segment, for drawing. */
  geometry: string[];
  centre: LatLng | null;
  note: string | null;
}

function toLines(place: NominatimPlace): LatLng[][] {
  const geo = place.geojson;
  if (!geo) return [];

  const asLine = (coords: unknown): LatLng[] =>
    Array.isArray(coords)
      ? coords
          .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2)
          .map(([lng, lat]) => ({ lat, lng }))
      : [];

  if (geo.type === "LineString") return [asLine(geo.coordinates)];
  if (geo.type === "MultiLineString" && Array.isArray(geo.coordinates)) {
    return (geo.coordinates as unknown[]).map(asLine);
  }
  return [];
}

/**
 * Points spread along the road's full length.
 *
 * Segments come back from the geocoder in no particular order, so "evenly
 * spaced along the list" could put every sample at one end. Sorting along the
 * road's dominant axis makes the spread follow the road instead.
 */
function spreadPoints(lines: LatLng[][], count: number): LatLng[] {
  const points = lines.flat();
  if (points.length <= count) return points;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const latSpan = Math.max(...lats) - Math.min(...lats);
  const lngSpan = Math.max(...lngs) - Math.min(...lngs);

  const sorted = [...points].sort((a, b) =>
    latSpan >= lngSpan ? a.lat - b.lat : a.lng - b.lng,
  );

  const step = (sorted.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => sorted[Math.round(i * step)]!);
}

function centreOf(lines: LatLng[][]): LatLng | null {
  const points = lines.flat();
  if (points.length === 0) return null;
  return points[Math.floor(points.length / 2)] ?? null;
}

function coreName(name: string): string {
  return name.replace(STREET_WORDS, " ").replace(/\s+/g, " ").trim() || name;
}

function emptyTraffic(summary: string): RoadTrafficReport["traffic"] {
  return {
    available: false,
    level: "unknown",
    summary,
    worst_level: null,
    closure: false,
    readings: [],
  };
}

export async function checkRoadTraffic(
  query: string,
  traffic: TrafficProvider,
): Promise<RoadTrafficReport> {
  const asked = query
    .replace(/^\s*(the)\s+/i, "")
    .replace(/[?.!]+$/, "")
    .trim();

  const correction = correctPlaceName(asked, ["road"]);
  const searchName = correction ? correction.name : asked;

  // Search on the name without its street word: "Sani Abacha" finds the Way,
  // "sani abacha road" finds nothing, and people say "road" for everything.
  const places = await nominatimSearch({
    q: coreName(searchName),
    limit: "20",
    polygon_geojson: "1",
    viewbox: ABUJA_VIEWBOX,
    bounded: "1",
  });

  const roads = places.filter(
    (place) =>
      place.category === "highway" &&
      Boolean(place.name?.trim()) &&
      (place.geojson?.type === "LineString" || place.geojson?.type === "MultiLineString"),
  );

  const base = {
    query: asked,
    corrected_from: correction && !correction.exact ? asked : null,
  };

  if (roads.length === 0) {
    /*
     * Not a road — but possibly a named spot on one. People ask about
     * "Berger" or "AYA junction" as often as about a road, and those are
     * mapped as junctions or places rather than as a named highway. The
     * traffic API snaps a point to the road segment under it, so measuring at
     * that one point is a real answer, as long as it is labelled as a point.
     */
    const spot = places.find((place) => Boolean(place.name?.trim()));
    const spotPoint = spot
      ? { lat: Number.parseFloat(spot.lat), lng: Number.parseFloat(spot.lon) }
      : null;

    if (spot && spotPoint && Number.isFinite(spotPoint.lat) && Number.isFinite(spotPoint.lng)) {
      const conditions = await traffic.sampleAlong([spotPoint], 1);
      const reading = conditions.samples[0];

      return {
        ...base,
        road: spot.name!.trim(),
        status: "open",
        road_class: spot.type ?? null,
        traffic: {
          available: conditions.available,
          level: conditions.level,
          summary: conditions.available
            ? `Around ${spot.name!.trim()}: ${LEVEL_PHRASE[conditions.level]}.`
            : conditions.summary,
          worst_level: reading ? reading.level : null,
          closure: conditions.anyClosure,
          readings: reading
            ? [
                {
                  point: reading.point,
                  level: reading.level,
                  currentSpeedKph: Math.round(reading.currentSpeedKph),
                  freeFlowSpeedKph: Math.round(reading.freeFlowSpeedKph),
                  roadClosed: reading.roadClosed,
                },
              ]
            : [],
        },
        geometry: [],
        centre: spotPoint,
        note: conditions.available
          ? "Measured at one spot (the named place), not along a whole road. Say it that way."
          : "No live traffic source is configured, so traffic here is unknown. Say that plainly.",
      };
    }

    return {
      ...base,
      road: null,
      status: "not_found",
      road_class: null,
      traffic: emptyTraffic("That road was not found in the Abuja map data."),
      geometry: [],
      centre: null,
      note: `No road called "${asked}" is mapped in Abuja. Ask the user for the road's full name or a landmark on it, rather than guessing which road they meant.`,
    };
  }

  // Several roads can match ("Sani Abacha Way", "Sani Abacha Way South");
  // take the name closest to what was asked, then every segment of it.
  const byName = new Map<string, NominatimPlace[]>();
  for (const road of roads) {
    const name = road.name!.trim();
    byName.set(name, [...(byName.get(name) ?? []), road]);
  }

  const [bestName, segments] = [...byName.entries()]
    .map(([name, group]) => ({ name, group, score: tokenSimilarity(name, searchName) }))
    .sort((a, b) => b.score - a.score || b.group.length - a.group.length)
    .map((entry) => [entry.name, entry.group] as const)[0]!;

  const built = segments.filter((segment) => !NOT_BUILT.has(segment.type ?? ""));
  const shown = (built.length > 0 ? built : segments).flatMap(toLines).filter((l) => l.length > 1);
  const geometry = shown.slice(0, MAX_LINES).map((line) => encodePolyline(line));
  const roadClass = (built[0] ?? segments[0])?.type ?? null;

  if (built.length === 0) {
    return {
      ...base,
      road: bestName,
      status: "not_built",
      road_class: roadClass,
      traffic: emptyTraffic(`${bestName} is only mapped as a ${roadClass ?? "planned"} road, so there is no traffic on it to measure.`),
      geometry,
      centre: centreOf(shown),
      note: `${bestName} exists in the map data only as ${roadClass ?? "planned"} — it is not an open road. Say so plainly, and ask whether they meant a different road.`,
    };
  }

  const samplePoints = spreadPoints(shown, SAMPLES_PER_ROAD);
  const conditions = await traffic.sampleAlong(samplePoints, SAMPLES_PER_ROAD);

  const readings: RoadReading[] = conditions.samples.map((sample) => ({
    point: sample.point,
    level: sample.level,
    currentSpeedKph: Math.round(sample.currentSpeedKph),
    freeFlowSpeedKph: Math.round(sample.freeFlowSpeedKph),
    roadClosed: sample.roadClosed,
  }));

  const worst = conditions.worstRatio !== null ? levelFromRatio(conditions.worstRatio) : null;

  return {
    ...base,
    road: bestName,
    status: "open",
    road_class: roadClass,
    traffic: {
      available: conditions.available,
      level: conditions.level,
      summary: conditions.available
        ? conditions.anyClosure
          ? `A closure is reported on ${bestName}.`
          : `${bestName}: ${LEVEL_PHRASE[conditions.level]}${
              worst && worst !== conditions.level ? `, with one stretch ${LEVEL_PHRASE[worst]}` : ""
            }.`
        : conditions.summary,
      worst_level: worst,
      closure: conditions.anyClosure,
      readings,
    },
    geometry,
    centre: centreOf(shown),
    note: conditions.available
      ? null
      : "No live traffic source is configured, so this road's traffic is unknown. Say that plainly; do not describe it as clear or busy.",
  };
}

/** Straight-line distance from a point to the nearest vertex of any line. */
export function distanceToLines(point: LatLng, lines: LatLng[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (const vertex of line) {
      const d = distanceMetres(point, vertex);
      if (d < best) best = d;
    }
  }
  return best;
}
