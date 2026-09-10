/**
 * Routing via OSRM. Free, no key.
 *
 * Uses the public demo server by default. That server has no SLA, asks that you
 * not build production traffic on it, and can disappear without notice — fine
 * for localhost and the V0.1 gate, not fine for shipping. Point OSRM_BASE_URL
 * at your own instance (or a hosted OSRM) before this reaches real users.
 *
 * Scope note: this returns a route, a distance and a duration. It is not
 * turn-by-turn navigation, which needs continuous position matching and is a
 * V0.3+ concern.
 */

import type { LatLng } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";

const DEFAULT_BASE = "https://router.project-osrm.org";
const MIN_INTERVAL_MS = 600;

export type TravelMode = "driving" | "walking" | "cycling";

/** OSRM demo profile names differ from the words people use. */
const PROFILE: Record<TravelMode, string> = {
  driving: "driving",
  walking: "foot",
  cycling: "bike",
};

export interface RouteStep {
  instruction: string;
  distanceM: number;
  name: string;
}

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /**
   * True when the duration was derived from distance rather than routed.
   *
   * The public OSRM demo server only has the driving profile loaded and
   * silently serves car routing for `foot` and `bike` — measured directly:
   * all three profiles return an identical 10.8km / 12min for the same pair.
   * Left uncorrected the app tells a pedestrian that a ten-kilometre walk
   * takes twelve minutes, which is not a rounding error but a wrong answer
   * someone could act on.
   */
  durationEstimated: boolean;
  /** Encoded polyline (precision 5), ready for Leaflet to decode and draw. */
  geometry: string | null;
  steps: RouteStep[];
  mode: TravelMode;
}

interface OsrmResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry?: string;
    legs?: Array<{
      steps?: Array<{
        distance: number;
        name?: string;
        maneuver?: { type?: string; modifier?: string };
      }>;
    }>;
  }>;
}

export async function computeRoute(
  origin: LatLng,
  destination: LatLng,
  mode: TravelMode = "driving",
): Promise<RouteResult | null> {
  const routes = await computeRoutes(origin, destination, mode, false);
  return routes[0] ?? null;
}

/**
 * Route plus alternatives.
 *
 * Alternatives are free from OSRM and are what makes "suggest a route with
 * less traffic" answerable at all — without a second option there is nothing
 * to compare. Note that OSRM ranks them by *free-flow* duration, so this
 * ordering says nothing whatsoever about congestion. Treating the ordering as
 * a traffic judgement would produce a confident recommendation built on no
 * traffic data, which is precisely the failure the traffic seam exists to
 * prevent.
 */
export async function computeRoutes(
  origin: LatLng,
  destination: LatLng,
  mode: TravelMode = "driving",
  alternatives = true,
): Promise<RouteResult[]> {
  const base = process.env.OSRM_BASE_URL?.trim() || DEFAULT_BASE;
  const profile = PROFILE[mode];

  // OSRM takes lon,lat — the reverse of almost everything else here, and an
  // easy way to end up routing into the Gulf of Guinea.
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const params = new URLSearchParams({
    overview: "full",
    geometries: "polyline",
    steps: "true",
    alternatives: alternatives ? "true" : "false",
  });

  const url = `${base}/route/v1/${profile}/${coords}?${params.toString()}`;

  const response = await throttledFetchJson<OsrmResponse>(url, {
    minIntervalMs: MIN_INTERVAL_MS,
  }).catch(() => null);

  if (!response || response.code !== "Ok" || !response.routes?.length) return [];

  return response.routes.map((route) => {
    /*
     * Correct the duration for non-driving modes.
     *
     * This substitutes a speed-based estimate for a routed time, which is a
     * real loss of precision — and it is still far closer to the truth than
     * reporting a car's travel time as a walk. Flagged so the assistant says
     * "about", and so a self-hosted OSRM with real foot and bike profiles can
     * drop the correction entirely.
     */
    const routedSeconds = Math.round(route.duration);
    const modeSpeedMps = mode === "walking" ? 1.35 : mode === "cycling" ? 4.2 : null;

    const durationS =
      modeSpeedMps === null
        ? routedSeconds
        : Math.round(route.distance / modeSpeedMps);

    const steps: RouteStep[] = (route.legs?.[0]?.steps ?? [])
      .map((step) => ({
        instruction: describeManeuver(
          step.maneuver?.type,
          step.maneuver?.modifier,
          step.name,
        ),
        distanceM: Math.round(step.distance),
        name: step.name ?? "",
      }))
      .filter((step) => step.distanceM > 0 || step.instruction !== "");

    return {
      distanceM: Math.round(route.distance),
      durationS,
      durationEstimated: modeSpeedMps !== null,
      geometry: route.geometry ?? null,
      steps,
      mode,
    };
  });
}

/**
 * A short label naming what makes a route distinct.
 *
 * OSRM does not name its alternatives, and "Route 2" tells a driver nothing.
 * People describe a way home by its dominant road — "the Maitama road",
 * "through Nyanya" — so the longest named road the route actually uses becomes
 * the label.
 */
export function labelRoute(route: RouteResult, index: number): string {
  const byRoad = new Map<string, number>();

  for (const step of route.steps) {
    if (!step.name) continue;
    byRoad.set(step.name, (byRoad.get(step.name) ?? 0) + step.distanceM);
  }

  const dominant = [...byRoad.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] > route.distanceM * 0.2) {
    return `via ${dominant[0]}`;
  }

  return index === 0 ? "main route" : `alternative ${index}`;
}

function describeManeuver(
  type?: string,
  modifier?: string,
  road?: string,
): string {
  const where = road ? ` onto ${road}` : "";

  switch (type) {
    case "depart":
      return road ? `Head out on ${road}` : "Set off";
    case "arrive":
      return "Arrive at your destination";
    case "roundabout":
    case "rotary":
      return `Take the roundabout${where}`;
    case "merge":
      return `Merge${where}`;
    case "fork":
      return `Keep ${modifier ?? "ahead"}${where}`;
    case "end of road":
      return `At the end of the road, turn ${modifier ?? "ahead"}${where}`;
    case "continue":
      return `Continue${where}`;
    default:
      if (modifier && modifier !== "straight") {
        return `Turn ${modifier}${where}`;
      }
      return `Continue${where}`;
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
