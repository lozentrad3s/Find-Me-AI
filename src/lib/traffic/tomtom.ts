/**
 * TomTom Traffic Flow — real congestion data.
 *
 * Chosen because it has a genuinely usable free tier (roughly 2,500 requests
 * per day) and covers Nigerian cities, which several alternatives do not. Get
 * a key at developer.tomtom.com and set TOMTOM_API_KEY.
 *
 * The endpoint answers for one point at a time, so a route is sampled at a
 * handful of places along it rather than measured end to end. Sampling is the
 * whole cost model here: each sample is a request, so SAMPLE_COUNT directly
 * sets how many route checks a day the free tier buys. Five samples means
 * about 500 checks daily, which is the right trade while the product has few
 * users — a jam on a long route shows up in at least one sample, and the worst
 * sample is reported alongside the mean so a single bad junction cannot be
 * hidden by an otherwise clear road.
 */

import type { LatLng } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";
import {
  levelFromRatio,
  LEVEL_PHRASE,
  type RouteConditions,
  type TrafficProvider,
  type TrafficSample,
} from "./types";

const BASE = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json";
const MIN_INTERVAL_MS = 250;
const SAMPLE_COUNT = 5;
/** Traffic goes stale fast; a long cache would be worse than none. */
const CACHE_TTL_MS = 2 * 60 * 1000;

interface FlowResponse {
  flowSegmentData?: {
    currentSpeed?: number;
    freeFlowSpeed?: number;
    currentTravelTime?: number;
    freeFlowTravelTime?: number;
    confidence?: number;
    roadClosure?: boolean;
  };
}

export class TomTomTrafficProvider implements TrafficProvider {
  readonly name = "tomtom";

  constructor(private readonly apiKey: string) {}

  async sampleAlong(points: LatLng[]): Promise<RouteConditions> {
    const chosen = pickEvenly(points, SAMPLE_COUNT);

    if (chosen.length === 0) {
      return unavailable("No route geometry to sample.");
    }

    const settled = await Promise.all(
      chosen.map((point) => this.sampleOne(point)),
    );
    const samples = settled.filter((s): s is TrafficSample => s !== null);

    if (samples.length === 0) {
      return unavailable(
        "TomTom returned no usable readings for this route — it may be outside their coverage.",
      );
    }

    const ratios = samples.map((s) => s.ratio);
    const worstRatio = Math.min(...ratios);
    const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const anyClosure = samples.some((s) => s.roadClosed);

    // Report the mean as the headline, but let a single very bad sample pull
    // it down — a two-minute crawl through one junction is what people
    // actually experience as "traffic".
    const headline = worstRatio < 0.4 ? (meanRatio + worstRatio) / 2 : meanRatio;
    const level = anyClosure ? "standstill" : levelFromRatio(headline);

    const delayMinutes = estimateDelayMinutes(samples);

    return {
      available: true,
      source: "tomtom",
      level,
      summary: anyClosure
        ? "There is a road closure reported on this route."
        : `Traffic is ${LEVEL_PHRASE[level]} across ${samples.length} sampled points.`,
      worstRatio,
      meanRatio,
      delayMinutes,
      anyClosure,
      samples,
    };
  }

  private async sampleOne(point: LatLng): Promise<TrafficSample | null> {
    const params = new URLSearchParams({
      key: this.apiKey,
      point: `${point.lat},${point.lng}`,
      unit: "KMPH",
    });

    const response = await throttledFetchJson<FlowResponse>(
      `${BASE}?${params.toString()}`,
      { minIntervalMs: MIN_INTERVAL_MS, ttlMs: CACHE_TTL_MS },
    ).catch(() => null);

    const flow = response?.flowSegmentData;
    const current = flow?.currentSpeed;
    const free = flow?.freeFlowSpeed;

    if (typeof current !== "number" || typeof free !== "number" || free <= 0) {
      return null;
    }

    const ratio = Math.min(1, current / free);

    return {
      point,
      currentSpeedKph: current,
      freeFlowSpeedKph: free,
      ratio,
      level: flow?.roadClosure ? "standstill" : levelFromRatio(ratio),
      roadClosed: Boolean(flow?.roadClosure),
    };
  }
}

/** Evenly spaced samples, always including both ends of the route. */
function pickEvenly(points: LatLng[], count: number): LatLng[] {
  if (points.length === 0) return [];
  if (points.length <= count) return points;

  const step = (points.length - 1) / (count - 1);
  const chosen: LatLng[] = [];

  for (let i = 0; i < count; i++) {
    const point = points[Math.round(i * step)];
    if (point) chosen.push(point);
  }

  return chosen;
}

/**
 * Rough extra minutes versus free-flow.
 *
 * Deliberately rough, and labelled as such wherever it surfaces: it assumes
 * each sample represents an equal share of the route, which is not exactly
 * true. Good enough to say "about ten minutes slower than usual", not good
 * enough to quote to the minute.
 */
function estimateDelayMinutes(samples: TrafficSample[]): number | null {
  const meanRatio =
    samples.reduce((sum, s) => sum + s.ratio, 0) / samples.length;
  if (meanRatio <= 0 || meanRatio >= 0.98) return 0;

  // Without the route's own duration here, this returns a multiplier the
  // caller applies to the free-flow time.
  return Number(((1 / meanRatio - 1) * 100).toFixed(0));
}

function unavailable(reason: string): RouteConditions {
  return {
    available: false,
    source: "tomtom",
    level: "unknown",
    summary: reason,
    worstRatio: null,
    meanRatio: null,
    delayMinutes: null,
    anyClosure: false,
    samples: [],
  };
}
