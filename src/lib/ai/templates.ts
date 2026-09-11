/**
 * Answers without a model.
 *
 * When the request was recognised and the right tool already ran, the answer
 * is sitting in the tool result; a model only has to phrase it. These
 * templates phrase it when no model can: offline mode, and — more importantly
 * — when Gemini's free-tier quota runs out halfway through an afternoon. In
 * that moment the choice is between a plain sentence built from real data and
 * an error message, and the plain sentence is always better.
 *
 * Written for the ear: short, no symbols, no coordinates.
 */

import type { TripPlan } from "@/lib/trip/plan";
import type { RoadTrafficReport } from "@/lib/traffic/roads";
import type { AreaReport } from "@/lib/area/explore";
import type { WebLookup } from "@/lib/web/wikimedia";
import { LEVEL_PHRASE } from "@/lib/traffic/types";

function metres(value: number): string {
  if (value < 1000) return `${Math.round(value / 10) * 10} metres`;
  return `${(value / 1000).toFixed(1)} kilometres`;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

interface NearbyResult {
  area?: string | null;
  results?: Array<{
    name: string;
    distance_m: number;
    road_distance_m?: number | null;
    travel_time_text?: string | null;
  }>;
}

export function phraseNearby(result: unknown, label: string): string {
  const data = result as NearbyResult;
  const found = data.results ?? [];
  const where = data.area ? ` in ${data.area}` : " near you";

  if (found.length === 0) {
    return `I couldn't find a ${label}${where} in the map data. The map is patchy here, so it may be unmapped rather than missing. Want me to search a wider area?`;
  }

  const nearest = found[0]!;
  const distance = nearest.road_distance_m ?? nearest.distance_m;
  const time = nearest.travel_time_text ? `, about ${nearest.travel_time_text} away` : "";
  const others = found.length - 1;

  return (
    `The closest ${label}${where} is ${nearest.name}, ${metres(distance)}${time}.` +
    (others > 0 ? ` I've pinned ${others} more on the map.` : "") +
    " Want directions?"
  );
}

interface WeatherResult {
  place?: string;
  current?: { temperature_c?: number; conditions?: string };
  forecast?: Array<{ day: string; conditions: string; rain_chance_pct: number }>;
  travel_advisory?: string | null;
}

export function phraseWeather(result: unknown): string {
  const data = result as WeatherResult;
  if (!data.current) return "Weather is unavailable right now.";

  const place = data.place && data.place !== "your location" ? ` in ${data.place}` : "";
  const parts = [
    `It's ${data.current.temperature_c}°${place} and ${(data.current.conditions ?? "").toLowerCase()}.`,
  ];

  const tomorrow = data.forecast?.[1];
  if (tomorrow) {
    parts.push(
      `${tomorrow.day}: ${tomorrow.conditions.toLowerCase()}, ${tomorrow.rain_chance_pct}% chance of rain.`,
    );
  }

  if (data.travel_advisory) parts.push(data.travel_advisory);
  return parts.join(" ");
}

export function phraseRoadTraffic(result: unknown): string {
  const reports = (result as { roads?: RoadTrafficReport[] }).roads ?? [];
  if (reports.length === 0) return "Tell me which road, and I'll check it.";

  return reports
    .map((report) => {
      const heard = report.corrected_from ? `I took "${report.corrected_from}" to mean ${report.road}. ` : "";
      if (report.status === "not_found") {
        return `I couldn't find "${report.query}" in the Abuja map. What's its full name, or a landmark on it?`;
      }
      if (report.status === "not_built") {
        return `${heard}${report.road} is only mapped as a planned road, so there's no traffic on it to check.`;
      }
      if (!report.traffic.available) {
        return `${heard}I found ${report.road} and marked it on the map, but I don't have live traffic data right now.`;
      }
      if (report.traffic.closure) return `${heard}There's a closure reported on ${report.road}.`;

      const worst =
        report.traffic.worst_level && report.traffic.worst_level !== report.traffic.level
          ? `, with one stretch ${LEVEL_PHRASE[report.traffic.worst_level]}`
          : "";
      return `${heard}${report.road} is ${LEVEL_PHRASE[report.traffic.level]}${worst}.`;
    })
    .join(" ");
}

export function phraseArea(result: unknown): string {
  const report = result as AreaReport;
  const didYouMean = report.corrected_from ? `Did you mean ${report.name}? ` : "";

  if (!report.found) {
    return `${didYouMean}I couldn't find ${report.name} in the Abuja map. Which area is it near?`;
  }

  const description = report.description
    ? report.description.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ")
    : `${report.name} is an area of Abuja.`;

  const landmarks = report.landmarks.slice(0, 4).map((landmark) => landmark.name);
  const roads = [...report.main_roads.slice(0, 2), ...report.junctions.slice(0, 1)];

  return [
    `${didYouMean}${description}`,
    landmarks.length > 0 ? `Well-known spots there include ${listOf(landmarks)}.` : "",
    roads.length > 0 ? `Main roads and junctions: ${listOf(roads)}.` : "",
    "Which part are you heading to?",
  ]
    .filter(Boolean)
    .join(" ");
}

interface ResolveResult {
  band?: string;
  corrected_from?: string | null;
  best?: { name?: string; address?: string; distance_m?: number | null } | null;
  question?: string | null;
  driver_instruction?: string | null;
  /** Set when the map could not identify the place and the web was searched. */
  web_search?: {
    used?: boolean;
    found_name?: string | null;
    found_address?: string | null;
    note?: string | null;
  } | null;
}

export function phrasePlace(resolve: unknown, web?: WebLookup | null): string {
  const data = resolve as ResolveResult;
  const didYouMean = data.corrected_from ? "I corrected the spelling. " : "";

  /*
   * Where the answer came from is part of the answer.
   *
   * A place the map has never heard of, located from a web listing, is a
   * weaker claim than a mapped one — the user should know which they are
   * looking at before they drive there.
   */
  const viaWeb =
    data.web_search?.used && data.web_search.found_name
      ? `I couldn't find that on the map, but it's listed online as ${data.web_search.found_name}${
          data.web_search.found_address ? `, ${data.web_search.found_address}` : ""
        }. `
      : "";

  if (data.band === "low" || !data.best) {
    const searched = data.web_search
      ? "I checked the map and the web and still couldn't pin that down."
      : "I couldn't pin that down.";
    return `${didYouMean}${searched} Add a landmark or the area — for example "near the filling station in Wuse".`;
  }
  if (data.band === "moderate" && data.question) return `${didYouMean}${data.question}`;

  const distance =
    typeof data.best.distance_m === "number" ? `, ${metres(data.best.distance_m)} from you` : "";
  const about = web?.summary?.extract?.split(/(?<=[.!?])\s+/)[0];
  const photos = web && web.images.length > 0 ? " I found some photos of it." : "";

  if (viaWeb) {
    return `${didYouMean}${viaWeb}I've put it on the map${distance}.${photos} Want me to take you there?`;
  }

  return `${didYouMean}Found it: ${data.best.name}${distance}.${about ? ` ${about}` : ""}${photos} Want me to take you there?`;
}

export function phraseTrip(plan: TripPlan | { error: string }): string {
  if ("error" in plan) return plan.error;

  const time = plan.route.trafficDurationText ?? plan.route.durationText;
  const estimate = plan.route.durationEstimated ? "about " : "";
  const via = plan.route.label.startsWith("via ") ? ` ${plan.route.label}` : "";

  const parts = [
    `${estimate}${time} to ${plan.destination.name}${via}, ${plan.route.distanceText}. You should arrive around ${plan.arrivalTime}.`,
  ];

  if (plan.mode !== "walking") {
    parts.push(
      plan.traffic.available
        ? `Traffic is ${LEVEL_PHRASE[plan.traffic.level]}.`
        : "I don't have live traffic for this route.",
    );
  }

  const weather = plan.weather.there ?? plan.weather.here;
  if (weather) parts.push(`It's ${weather.temperatureC}° and ${weather.conditions.toLowerCase()}.`);
  if (plan.weather.advisory) parts.push(plan.weather.advisory);

  if (plan.incidents.length === 0 && plan.activeAlertsNearRoute === 0) {
    parts.push("No incidents reported along the way.");
  }
  parts.push(...plan.safety.slice(0, 2));
  parts.push("Navigation has started.");

  return parts.join(" ");
}

export function phraseWhereAmI(result: unknown): string {
  const data = result as { spoken_description?: string; address?: string | null };
  return (
    data.spoken_description ??
    (data.address ? `You're at ${data.address}.` : "I couldn't work out where you are.")
  );
}

export const SMALLTALK_REPLY =
  "Hi, I'm Find Me. Ask me where something is, what's near you, how the traffic is on a road, or to take you somewhere.";
