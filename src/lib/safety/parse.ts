/**
 * Request-body narrowing for the safety routes.
 *
 * Lives here rather than in a route file so both `/api/sos` and
 * `/api/sos/[id]/ping` use the identical rules — a fix that is acceptable
 * when opening an alert and rejected when updating it would silently freeze
 * someone's position on the tracking map.
 */

import type { LatLng } from "@/lib/geo/distance";
import type { LocationFix } from "./types";

export function parseFix(value: unknown): LocationFix | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = value as Record<string, unknown>;
  const lat = raw.lat;
  const lng = raw.lng;

  if (typeof lat !== "number" || !Number.isFinite(lat)) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const num = (field: unknown): number | null =>
    typeof field === "number" && Number.isFinite(field) ? field : null;

  return {
    lat,
    lng,
    accuracyM: num(raw.accuracyM),
    heading: num(raw.heading),
    speedMps: num(raw.speedMps),
    /*
     * Server time, not the client's.
     *
     * Phone clocks are wrong often enough — and skewed in both directions —
     * that trusting one would put fixes out of order on the trail and draw a
     * responder a path that doubles back on itself. The few hundred
     * milliseconds of network delay cost far less than that.
     */
    at: Date.now(),
  };
}

export function parsePoint(value: unknown): LatLng | null {
  const fix = parseFix(value);
  return fix ? { lat: fix.lat, lng: fix.lng } : null;
}
