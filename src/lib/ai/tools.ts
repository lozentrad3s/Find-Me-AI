/**
 * The tool registry (master document, Part IV, 4.3).
 *
 * The model's entire job is to choose one of these and phrase the result. It
 * does not know any geography of its own, and the system prompt says so —
 * every coordinate, name, distance and ETA in a reply came out of one of these
 * functions.
 *
 * V0.1 ships the Read tier only. Write, Notify, Emergency and Financial tools
 * are defined in the master document and deliberately absent here: they change
 * something in the world, and none of them should exist before the read path
 * is trustworthy. `activate_sos` in particular must never become a tool the
 * model can reach — it is a button, wired straight to the SOS path.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { Providers } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { resolvePlace } from "@/lib/resolution/pipeline";
import {
  computeRoute,
  computeRoutes,
  formatDistance,
  formatDuration,
  labelRoute,
  type TravelMode,
} from "@/lib/routing/osrm";
import { decodePolyline } from "@/lib/geo/polyline";
import { NoTrafficProvider, type TrafficProvider } from "@/lib/traffic/types";
import { getWeather } from "@/lib/weather/open-meteo";
import { scanSurroundings } from "@/lib/resolution/surroundings";
import { getJourneyWeather } from "@/lib/weather/journey";

export type RiskTier = "read" | "write" | "notify" | "emergency" | "financial";

export interface ToolContext {
  providers: Providers;
  /** Where the user is, when they have granted permission. */
  currentLocation?: LatLng;
  city?: string;
  /** Absent means no traffic source, which the tools report honestly. */
  traffic?: TrafficProvider;
}

export interface AgentTool {
  name: string;
  tier: RiskTier;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPoint(
  input: Record<string, unknown>,
  context: ToolContext,
): LatLng | null {
  const lat = input.lat;
  const lng = input.lng;

  if (typeof lat === "number" && typeof lng === "number") {
    return { lat, lng };
  }
  return context.currentLocation ?? null;
}

const NO_LOCATION = {
  error:
    "No location available. The user has not shared their position, and no coordinates were supplied.",
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const resolvePlaceTool: AgentTool = {
  name: "resolve_place",
  tier: "read",
  description:
    "Turn a described place into coordinates. Use this whenever the user names or describes a destination in ordinary language, including vague or landmark-based descriptions like 'the guest house behind the mosque on Buhari Street' or 'that place beside the bank'. Returns a confidence band: 'high' means act on it, 'moderate' means ask the returned question before acting, 'low' means the description is too thin and you must ask for a landmark or a nearby business. Never present a moderate or low result as a settled answer.",
  input_schema: {
    type: "object",
    properties: {
      phrase: {
        type: "string",
        description:
          "The place description, as close to the user's own words as possible. Do not tidy it up — the landmarks and relative directions are the useful part.",
      },
      city: {
        type: "string",
        description: "City to search in, if known. e.g. 'Jos', 'Abuja'.",
      },
    },
    required: ["phrase"],
  },
  async execute(input, context) {
    const phrase = String(input.phrase ?? "").trim();
    if (!phrase) return { error: "phrase is required" };

    const result = await resolvePlace(phrase, context.providers, {
      context: {
        city: typeof input.city === "string" ? input.city : context.city,
        currentLocation: context.currentLocation,
      },
    });

    return {
      band: result.band.band,
      rationale: result.band.rationale,
      best: result.best
        ? {
            name: result.best.candidate.name,
            address: result.best.candidate.formattedAddress,
            lat: result.best.candidate.point.lat,
            lng: result.best.candidate.point.lng,
            confidence: Number(result.best.score.toFixed(2)),
            why: result.best.reasons,
          }
        : null,
      // Present only when the band is moderate. Ask it verbatim rather than
      // inventing a vaguer version.
      question: result.question?.question ?? null,
      options: result.question?.options.map((o) => ({
        label: o.label,
        detail: o.detail,
      })),
      alternatives: result.ranked.slice(1, 4).map((entry) => ({
        name: entry.candidate.name,
        address: entry.candidate.formattedAddress,
        lat: entry.candidate.point.lat,
        lng: entry.candidate.point.lng,
      })),
      driver_instruction: result.reverse?.driverInstruction ?? null,
    };
  },
};

const searchNearbyTool: AgentTool = {
  name: "search_nearby",
  tier: "read",
  description:
    "Find places of a given kind near a point — restaurants, filling stations, hospitals, banks, hotels, pharmacies, mechanics, markets. Defaults to the user's current location when no coordinates are given. Use this for 'what's around me', 'I'm hungry', 'I need fuel', and similar.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "What to look for, in plain words: 'filling station', 'hospital', 'restaurant', 'pharmacy', 'bank', 'hotel', 'mechanic'.",
      },
      lat: { type: "number", description: "Latitude to search around." },
      lng: { type: "number", description: "Longitude to search around." },
      radius_m: {
        type: "number",
        description: "Search radius in metres. Default 2000, maximum 10000.",
      },
    },
    required: ["category"],
  },
  async execute(input, context) {
    const centre = readPoint(input, context);
    if (!centre) return NO_LOCATION;

    const radiusM = Math.min(
      10_000,
      Math.max(100, typeof input.radius_m === "number" ? input.radius_m : 2000),
    );

    const results = await context.providers.places.nearbySearch({
      center: centre,
      radiusM,
      keyword: String(input.category ?? ""),
      maxResults: 12,
    });

    if (results.length === 0) {
      return {
        results: [],
        note: "Nothing of that kind is mapped nearby. OpenStreetMap coverage is uneven in much of Nigeria, so this may mean 'not in the map data' rather than 'not there'. Say so rather than claiming there is nothing around.",
      };
    }

    return {
      results: results.map((place) => ({
        name: place.name,
        address: place.formattedAddress || null,
        lat: place.point.lat,
        lng: place.point.lng,
        distance_m: Math.round(distanceMetres(centre, place.point)),
        types: place.types,
      })),
    };
  },
};

const whereAmITool: AgentTool = {
  name: "where_am_i",
  tier: "read",
  description:
    "Get the user's current position and the address it corresponds to. Use this when the user asks where they are, says they are lost, or when you need their location to answer something else.",
  input_schema: { type: "object", properties: {} },
  async execute(_input, context) {
    if (!context.currentLocation) return NO_LOCATION;

    const results = await context.providers.geocoding.reverse(
      context.currentLocation,
    );
    const nearest = results[0];

    return {
      lat: context.currentLocation.lat,
      lng: context.currentLocation.lng,
      address: nearest?.formattedAddress ?? null,
      precision: nearest?.precision ?? null,
    };
  },
};

const routeTool: AgentTool = {
  name: "calculate_route",
  tier: "read",
  description:
    "Work out the route, distance and travel time between two points. Origin defaults to the user's current location. Call resolve_place first to turn a described destination into coordinates — never guess them.",
  input_schema: {
    type: "object",
    properties: {
      to_lat: { type: "number", description: "Destination latitude." },
      to_lng: { type: "number", description: "Destination longitude." },
      from_lat: { type: "number", description: "Origin latitude. Defaults to the user." },
      from_lng: { type: "number", description: "Origin longitude. Defaults to the user." },
      mode: {
        type: "string",
        enum: ["driving", "walking", "cycling"],
        description: "Travel mode. Default driving.",
      },
    },
    required: ["to_lat", "to_lng"],
  },
  async execute(input, context) {
    const origin =
      typeof input.from_lat === "number" && typeof input.from_lng === "number"
        ? { lat: input.from_lat, lng: input.from_lng }
        : context.currentLocation;

    if (!origin) return NO_LOCATION;

    const toLat = input.to_lat;
    const toLng = input.to_lng;
    if (typeof toLat !== "number" || typeof toLng !== "number") {
      return { error: "to_lat and to_lng are required numbers." };
    }

    const mode: TravelMode =
      input.mode === "walking" || input.mode === "cycling"
        ? input.mode
        : "driving";

    const route = await computeRoute(origin, { lat: toLat, lng: toLng }, mode);

    if (!route) {
      return {
        error:
          "No route could be calculated between those points. The road network may not be mapped, or the points may be unreachable by that mode.",
      };
    }

    return {
      distance_m: route.distanceM,
      distance_text: formatDistance(route.distanceM),
      duration_s: route.durationS,
      duration_text: formatDuration(route.durationS),
      mode: route.mode,
      // The client draws this; the model should not try to describe it.
      geometry: route.geometry,
      steps: route.steps.slice(0, 12),
    };
  },
};

const routeConditionsTool: AgentTool = {
  name: "check_route_conditions",
  tier: "read",
  description:
    "Check traffic and compare alternative routes between two points. Use this for any question about traffic, congestion, delays, or whether a route is clear — for example 'is there traffic on the Maitama route from Dutse'. Origin defaults to the user's current location. Resolve place descriptions with resolve_place first. IMPORTANT: read `traffic.available` in the result. When it is false there is NO live traffic data and you must say so plainly — never describe conditions as light, moderate or heavy unless a reading actually came back.",
  input_schema: {
    type: "object",
    properties: {
      to_lat: { type: "number", description: "Destination latitude." },
      to_lng: { type: "number", description: "Destination longitude." },
      from_lat: { type: "number", description: "Origin latitude. Defaults to the user." },
      from_lng: { type: "number", description: "Origin longitude. Defaults to the user." },
    },
    required: ["to_lat", "to_lng"],
  },
  async execute(input, context) {
    const origin =
      typeof input.from_lat === "number" && typeof input.from_lng === "number"
        ? { lat: input.from_lat, lng: input.from_lng }
        : context.currentLocation;

    if (!origin) return NO_LOCATION;

    const toLat = input.to_lat;
    const toLng = input.to_lng;
    if (typeof toLat !== "number" || typeof toLng !== "number") {
      return { error: "to_lat and to_lng are required numbers." };
    }

    const routes = await computeRoutes(origin, { lat: toLat, lng: toLng }, "driving");

    if (routes.length === 0) {
      return { error: "No route could be calculated between those points." };
    }

    const traffic = context.traffic ?? new NoTrafficProvider();

    // Only the primary route is sampled. Every extra route multiplies the
    // traffic API calls, and the free tier is small enough that the difference
    // matters; the alternatives are offered as options, not pre-judged.
    const primary = routes[0]!;
    const conditions = primary.geometry
      ? await traffic.sampleAlong(decodePolyline(primary.geometry))
      : await new NoTrafficProvider().sampleAlong([]);

    const adjustedDurationText =
      conditions.available && conditions.meanRatio && conditions.meanRatio > 0
        ? formatDuration(primary.durationS / conditions.meanRatio)
        : null;

    return {
      traffic: {
        available: conditions.available,
        source: conditions.source,
        level: conditions.level,
        summary: conditions.summary,
        readings_taken: conditions.samples.length,
        road_closure: conditions.anyClosure,
      },
      primary_route: {
        label: labelRoute(primary, 0),
        distance_text: formatDistance(primary.distanceM),
        // Free-flow unless traffic data came back. Named so the model cannot
        // quietly present a speed-limit estimate as a live prediction.
        free_flow_duration_text: formatDuration(primary.durationS),
        traffic_adjusted_duration_text: adjustedDurationText,
        geometry: primary.geometry,
      },
      alternatives: routes.slice(1, 3).map((route, index) => ({
        label: labelRoute(route, index + 1),
        distance_text: formatDistance(route.distanceM),
        free_flow_duration_text: formatDuration(route.durationS),
        // Stated explicitly so the model does not imply otherwise.
        traffic_checked: false,
      })),
      note: conditions.available
        ? "Alternatives are ranked by free-flow time only; traffic was measured on the primary route. Offer to check an alternative rather than claiming it is clearer."
        : "No live traffic data. Report the free-flow estimate as an estimate, say traffic is unknown, and do not characterise congestion.",
    };
  },
};

const scanSurroundingsTool: AgentTool = {
  name: "scan_surroundings",
  tier: "read",
  description:
    "Full scan of what is around a point: the street, the district, the most recognisable nearby landmark, and everything named within 400m with distances and compass directions. Defaults to the user's location. Use this when the user asks where they are, says they are lost, needs to describe their position to someone else, or when a resolved place needs to be explained by its surroundings. IMPORTANT: read `data_gaps` and obey it. Building colours are NOT in the map data anywhere in Nigeria — never describe the colour of a building, and never invent a detail the scan did not return.",
  input_schema: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitude. Defaults to the user." },
      lng: { type: "number", description: "Longitude. Defaults to the user." },
    },
  },
  async execute(input, context) {
    const point = readPoint(input, context);
    if (!point) return NO_LOCATION;

    const report = await scanSurroundings(point, {
      places: context.providers.places,
      geocoding: context.providers.geocoding,
    });

    return {
      address: report.address,
      street: report.street,
      area: report.area,
      spoken_description: report.spokenDescription,
      primary_landmark: report.primaryLandmark,
      nearby: report.features.map((feature) => ({
        name: feature.name,
        category: feature.category,
        distance_m: feature.distanceM,
        direction: feature.direction,
        // Present only when OSM actually carries the tag.
        ...(feature.colour ? { colour: feature.colour } : {}),
      })),
      summary: report.summary,
      data_gaps: report.dataGaps,
    };
  },
};

const weatherTool: AgentTool = {
  name: "get_weather",
  tier: "read",
  description:
    "Current conditions and a five-day forecast for a point, defaulting to the user's location. Use this for any question about weather, rain, heat or whether to set off now. Also worth calling unprompted when the user is planning a journey and `travel_advisory` would change their decision — in Abuja's rainy season a downpour is a real routing factor, not small talk.",
  input_schema: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitude. Defaults to the user." },
      lng: { type: "number", description: "Longitude. Defaults to the user." },
    },
  },
  async execute(input, context) {
    const point = readPoint(input, context);
    if (!point) return NO_LOCATION;

    const report = await getWeather(point);
    if (!report) return { error: "Weather data is unavailable right now." };

    return {
      current: {
        temperature_c: Math.round(report.current.temperatureC),
        feels_like_c: Math.round(report.current.feelsLikeC),
        conditions: report.current.description,
        humidity_pct: report.current.humidityPct,
        wind_kph: Math.round(report.current.windKph),
      },
      forecast: report.daily.map((day) => ({
        day: day.label,
        conditions: day.description,
        high_c: Math.round(day.maxC),
        low_c: Math.round(day.minC),
        rain_chance_pct: day.rainChancePct,
      })),
      // Present only when it is worth mentioning; say it plainly when it is.
      travel_advisory: report.travelAdvisory,
    };
  },
};

const journeyWeatherTool: AgentTool = {
  name: "check_journey_weather",
  tier: "read",
  description:
    "Compare weather where the user is against weather where they are going. Call this whenever someone mentions travelling to another town or city — 'I'm going to Abuja tomorrow', 'heading to Jos'. It is dry in Jos and storming in Abuja often enough that this is the most useful thing you can volunteer. If `alert` is null, say nothing about weather; if it is set, say it in one sentence.",
  input_schema: {
    type: "object",
    properties: {
      to_lat: { type: "number", description: "Destination latitude." },
      to_lng: { type: "number", description: "Destination longitude." },
      to_name: { type: "string", description: 'Destination name, e.g. "Abuja".' },
      from_lat: { type: "number", description: "Origin latitude. Defaults to the user." },
      from_lng: { type: "number", description: "Origin longitude. Defaults to the user." },
      from_name: { type: "string", description: "Origin name." },
    },
    required: ["to_lat", "to_lng"],
  },
  async execute(input, context) {
    const origin =
      typeof input.from_lat === "number" && typeof input.from_lng === "number"
        ? { lat: input.from_lat, lng: input.from_lng }
        : context.currentLocation;

    if (!origin) return NO_LOCATION;

    const toLat = input.to_lat;
    const toLng = input.to_lng;
    if (typeof toLat !== "number" || typeof toLng !== "number") {
      return { error: "to_lat and to_lng are required numbers." };
    }

    const journey = await getJourneyWeather(
      origin,
      { lat: toLat, lng: toLng },
      {
        origin: typeof input.from_name === "string" ? input.from_name : undefined,
        destination: typeof input.to_name === "string" ? input.to_name : undefined,
      },
    );

    const summarise = (side: typeof journey.origin) =>
      side.report
        ? {
            place: side.label,
            temperature_c: Math.round(side.report.current.temperatureC),
            conditions: side.report.current.description,
            rain_chance_today_pct: side.report.daily[0]?.rainChancePct ?? null,
          }
        : null;

    return {
      here: summarise(journey.origin),
      there: summarise(journey.destination),
      destination_is_worse: journey.destinationWorse,
      // Null means conditions are unremarkable. Say nothing rather than
      // filling the silence with a weather report nobody asked for.
      alert: journey.alert,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  resolvePlaceTool,
  searchNearbyTool,
  whereAmITool,
  routeTool,
  routeConditionsTool,
  weatherTool,
  scanSurroundingsTool,
  journeyWeatherTool,
];

export const TOOLS_BY_NAME = new Map(
  AGENT_TOOLS.map((tool) => [tool.name, tool] as const),
);

/** Tool definitions in the shape the Messages API expects. */
export function toolDefinitions(): Anthropic.Tool[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}
