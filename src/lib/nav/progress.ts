/**
 * Where the user is along a route — the maths behind live navigation.
 *
 * Google Maps' "in 200 m, turn left" is three numbers: how far along the route
 * you are, how far off it you are, and where the next manoeuvre is. All three
 * come from projecting the GPS fix onto the route line, which is what this
 * does. It runs on the phone on every fix, so it has to be cheap: a local flat
 * projection (accurate to centimetres over a city) and a search window around
 * the last known segment instead of the whole route.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";

export interface NavStep {
  instruction: string;
  distanceM: number;
  name: string;
  /** Where the manoeuvre happens. Null for steps the router did not place. */
  location: LatLng | null;
  type?: string;
  modifier?: string;
}

export interface RouteIndex {
  points: LatLng[];
  /** Distance from the start to each point, metres. */
  cumulative: number[];
  totalM: number;
  /** Distance along the route of each step's manoeuvre; NaN when unplaced. */
  stepAlong: number[];
}

export interface NavProgress {
  /** Metres travelled along the route. */
  alongM: number;
  remainingM: number;
  /** How far the fix is from the route line. */
  offRouteM: number;
  /** The fix snapped onto the route. */
  snapped: LatLng;
  /** Segment the fix projected onto, to seed the next search. */
  segment: number;
  /** Index into steps of the next manoeuvre, or null past the last one. */
  nextStep: number | null;
  distanceToNextM: number | null;
  arrived: boolean;
  fractionDone: number;
}

interface Projection {
  alongM: number;
  offM: number;
  segment: number;
  point: LatLng;
}

/** Metres per degree, flattened around a reference latitude. */
function scale(lat: number): { x: number; y: number } {
  return { x: 111_320 * Math.cos((lat * Math.PI) / 180), y: 110_540 };
}

function projectOntoSegments(
  index: RouteIndex,
  point: LatLng,
  from: number,
  to: number,
): Projection {
  const { points, cumulative } = index;
  const k = scale(point.lat);

  let best: Projection = {
    alongM: 0,
    offM: Number.POSITIVE_INFINITY,
    segment: 0,
    point: points[0] ?? point,
  };

  const last = Math.min(to, points.length - 2);

  for (let i = Math.max(0, from); i <= last; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;

    const ax = (a.lng - point.lng) * k.x;
    const ay = (a.lat - point.lat) * k.y;
    const bx = (b.lng - point.lng) * k.x;
    const by = (b.lat - point.lat) * k.y;

    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    // Parameter of the closest point on the segment to the origin (the fix).
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const off = Math.hypot(cx, cy);

    if (off < best.offM) {
      const segmentLength = (cumulative[i + 1] ?? 0) - (cumulative[i] ?? 0);
      best = {
        alongM: (cumulative[i] ?? 0) + t * segmentLength,
        offM: off,
        segment: i,
        point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
      };
    }
  }

  return best;
}

export function indexRoute(points: LatLng[], steps: NavStep[]): RouteIndex {
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + distanceMetres(points[i - 1]!, points[i]!));
  }

  const partial: RouteIndex = {
    points,
    cumulative,
    totalM: cumulative[cumulative.length - 1] ?? 0,
    stepAlong: [],
  };

  // Steps are in route order, so each projection can start where the last
  // one landed — that keeps a route that doubles back from snapping a later
  // manoeuvre onto an earlier pass of the same road.
  let cursor = 0;
  const stepAlong = steps.map((step) => {
    if (!step.location || points.length < 2) return Number.NaN;
    const projected = projectOntoSegments(partial, step.location, cursor, points.length - 2);
    cursor = projected.segment;
    return projected.alongM;
  });

  return { ...partial, stepAlong };
}

/**
 * Progress for one fix.
 *
 * `lastSegment` narrows the search to where the user was a moment ago; if that
 * finds nothing close, the whole route is searched, which is what recovers a
 * user who took a shortcut.
 */
export function progressOnRoute(
  index: RouteIndex,
  point: LatLng,
  destination: LatLng,
  lastSegment = 0,
): NavProgress {
  const { points, totalM, stepAlong } = index;

  if (points.length < 2) {
    const remaining = distanceMetres(point, destination);
    return {
      alongM: 0,
      remainingM: remaining,
      offRouteM: 0,
      snapped: point,
      segment: 0,
      nextStep: null,
      distanceToNextM: null,
      arrived: remaining < 30,
      fractionDone: 0,
    };
  }

  let projection = projectOntoSegments(index, point, lastSegment - 15, lastSegment + 250);
  if (projection.offM > 60) {
    projection = projectOntoSegments(index, point, 0, points.length - 2);
  }

  const remainingM = Math.max(0, totalM - projection.alongM);

  let nextStep: number | null = null;
  for (let i = 1; i < stepAlong.length; i++) {
    const along = stepAlong[i]!;
    if (Number.isFinite(along) && along > projection.alongM + 8) {
      nextStep = i;
      break;
    }
  }

  const arrived = remainingM < 25 || distanceMetres(point, destination) < 30;

  return {
    alongM: projection.alongM,
    remainingM,
    offRouteM: projection.offM,
    snapped: projection.point,
    segment: projection.segment,
    nextStep,
    distanceToNextM: nextStep !== null ? Math.max(0, stepAlong[nextStep]! - projection.alongM) : null,
    arrived,
    fractionDone: totalM > 0 ? Math.min(1, projection.alongM / totalM) : 0,
  };
}

/** "200 m", "1.4 km" — rounded the way a voice prompt would say it. */
export function spokenDistance(metres: number): string {
  if (metres < 50) return `${Math.max(10, Math.round(metres / 10) * 10)} metres`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} metres`;
  return `${(metres / 1000).toFixed(1)} kilometres`;
}
