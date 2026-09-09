/** Geodesic helpers. Small enough to keep dependency-free. */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = [
  "north", "north-east", "east", "south-east",
  "south", "south-west", "west", "north-west",
] as const;

export type Compass = (typeof COMPASS)[number];

/** Bearing to a spoken compass word — used when describing an approach. */
export function compassFromBearing(bearing: number): Compass {
  const index = Math.round(((bearing % 360) + 360) % 360 / 45) % 8;
  return COMPASS[index] ?? "north";
}

/**
 * Distance → a 0..1 score that decays smoothly.
 *
 * `halfLifeM` is the distance at which the score is 0.5, which makes the
 * weighting legible when tuning: "an anchor 150 m away scores 0.5".
 */
export function proximityScore(metres: number, halfLifeM: number): number {
  if (!Number.isFinite(metres) || metres < 0) return 0;
  return 1 / (1 + metres / halfLifeM);
}

/** Midpoint of a set of points. Used to cluster agreeing candidates. */
export function centroid(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = toRad(p.lat);
    const lng = toRad(p.lng);
    x += Math.cos(lat) * Math.cos(lng);
    y += Math.cos(lat) * Math.sin(lng);
    z += Math.sin(lat);
  }
  const n = points.length;
  x /= n;
  y /= n;
  z /= n;
  const lng = Math.atan2(y, x);
  const hyp = Math.sqrt(x * x + y * y);
  const lat = Math.atan2(z, hyp);
  return { lat: toDeg(lat), lng: toDeg(lng) };
}
