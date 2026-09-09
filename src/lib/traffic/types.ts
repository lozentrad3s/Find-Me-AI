/**
 * Traffic conditions.
 *
 * This exists as a seam because the honest default is "we do not know".
 * OpenStreetMap has no live traffic, and OSRM returns free-flow travel times
 * computed from speed limits — a route it calls 25 minutes is 25 minutes at
 * 3am with empty roads, and it will say the same thing at 5pm on a Friday.
 *
 * That matters more here than it would in most products. The master document's
 * hard rule is that the assistant never states anything a tool did not return,
 * and "there is moderate traffic" is exactly the kind of plausible sentence a
 * language model will generate unprompted if nothing stops it. So the default
 * provider returns an explicit `unknown`, and the tool that uses it is
 * required to say so.
 *
 * `TomTomTrafficProvider` turns this into a real answer; its free tier covers
 * roughly 2,500 requests a day.
 */

import type { LatLng } from "@/lib/geo/distance";

export type CongestionLevel =
  | "free"
  | "light"
  | "moderate"
  | "heavy"
  | "standstill"
  | "unknown";

export interface TrafficSample {
  point: LatLng;
  /** Observed speed, km/h. */
  currentSpeedKph: number;
  /** Speed with no traffic, km/h. */
  freeFlowSpeedKph: number;
  /** currentSpeed / freeFlowSpeed, 0..1. Lower is worse. */
  ratio: number;
  level: CongestionLevel;
  roadClosed: boolean;
}

export interface RouteConditions {
  /** False when no traffic source is configured — say so, do not guess. */
  available: boolean;
  /** Which provider answered, for display and for debugging. */
  source: string;
  level: CongestionLevel;
  /** Plain-language summary, safe to read aloud. */
  summary: string;
  /** Worst ratio seen along the route. */
  worstRatio: number | null;
  /** Mean ratio across all samples. */
  meanRatio: number | null;
  /** Extra minutes versus free-flow, when calculable. */
  delayMinutes: number | null;
  anyClosure: boolean;
  samples: TrafficSample[];
}

export interface TrafficProvider {
  readonly name: string;
  /** Sample conditions at points along a route. */
  sampleAlong(points: LatLng[]): Promise<RouteConditions>;
}

/**
 * Speed ratio to a word.
 *
 * Thresholds are the conventional ones used by traffic APIs: above 80% of
 * free-flow is effectively clear, below 25% is not moving.
 */
export function levelFromRatio(ratio: number): CongestionLevel {
  if (!Number.isFinite(ratio)) return "unknown";
  if (ratio >= 0.8) return "free";
  if (ratio >= 0.6) return "light";
  if (ratio >= 0.4) return "moderate";
  if (ratio >= 0.25) return "heavy";
  return "standstill";
}

/** How a level should be described out loud. */
export const LEVEL_PHRASE: Record<CongestionLevel, string> = {
  free: "moving freely",
  light: "light traffic, moving well",
  moderate: "moderate traffic but passable",
  heavy: "heavy traffic and slow",
  standstill: "barely moving",
  unknown: "unknown",
};

/**
 * The default. Reports that it does not know, every time.
 *
 * It would be easy to make this infer congestion from OSRM's duration versus
 * distance and produce something that sounds authoritative. That would be a
 * fabrication with a plausible voice, which is the worst failure mode this
 * product has.
 */
export class NoTrafficProvider implements TrafficProvider {
  readonly name = "none";

  // Takes the points and ignores them, so it is a drop-in for the real
  // provider at every call site.
  async sampleAlong(_points: LatLng[]): Promise<RouteConditions> {
    return {
      available: false,
      source: "none",
      level: "unknown",
      summary:
        "No live traffic source is configured, so traffic conditions are genuinely unknown. Travel times are free-flow estimates from speed limits and do not account for congestion.",
      worstRatio: null,
      meanRatio: null,
      delayMinutes: null,
      anyClosure: false,
      samples: [],
    };
  }
}
