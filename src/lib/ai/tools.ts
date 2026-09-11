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
 *
 * A tool's full result goes to the app (it draws routes, pins and photo
 * galleries from it). `forModel` trims what the model sees: geometry, step
 * lists and image URLs are for the screen, and handing them to the model only
 * invites it to read coordinates aloud.
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
  travelTimesFrom,
  type TravelMode,
} from "@/lib/routing/osrm";
import { decodePolyline } from "@/lib/geo/polyline";
import { NoTrafficProvider, type TrafficProvider } from "@/lib/traffic/types";
import { getWeather } from "@/lib/weather/open-meteo";
import { scanSurroundings } from "@/lib/resolution/surroundings";
import { getJourneyWeather } from "@/lib/weather/journey";
import { planTrip, tripForModel, type TripPlan } from "@/lib/trip/plan";
import { checkRoadTraffic, type RoadTrafficReport } from "@/lib/traffic/roads";
import { exploreArea, type AreaReport } from "@/lib/area/explore";
import { lookupPlaceOnWeb, type WebLookup } from "@/lib/web/wikimedia";
import {
  searchPlaceOnWeb,
  searchStringFor,
  webPlaceSearchAvailable,
  type WebPlaceHit,
} from "@/lib/web/place-search";
import { applyCorrections, findPlaceNames } from "@/lib/geo/gazetteer";
import { ABUJA, localCentre } from "@/lib/geo/cities";

export type RiskTier = "read" | "write" | "notify" | "emergency" | "financial";

export interface ToolContext {
  providers: Providers;
  /** Where the user is, when they have granted permission. */
  currentLocation?: LatLng;
  city?: string;
  /** Absent means no traffic source, which the tools report honestly. */
  traffic?: TrafficProvider;
  /**
   * How the user is currently moving — inferred from GPS speed, or set by the
   * user with the mode buttons on the map.
   *
   * Lets routing default to reality instead of assuming a car, and lets the
   * assistant skip asking a question it can already answer.
   */
  travelMode?: "foot" | "bike" | "car" | "still";
  /** Fix accuracy in metres, so the assistant can hedge when it is poor. */
  accuracyM?: number | null;
}

export interface AgentTool {
  name: string;
  tier: RiskTier;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  /** What the model sees of the result. Defaults to all of it. */
  forModel?(result: unknown): unknown;
}

/** The result as the model should see it. */
export function resultForModel(tool: AgentTool | undefined, result: unknown): unknown {
  if (!tool?.forModel || typeof result !== "object" || result === null || "error" in result) {
    return result;
  }
  return tool.forModel(result);
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

/** How the user is moving, as a routing mode. */
export function routingMode(travelMode: ToolContext["travelMode"]): TravelMode {
  return travelMode === "foot" ? "walking" : travelMode === "bike" ? "cycling" : "driving";
}

/**
 * Centre of a named district or landmark, without trusting the model's idea
 * of where it is: the local district table first (no network), then the
 * geocoder bounded to Abuja.
 */
export async function areaCentre(area: string, context: ToolContext): Promise<{ name: string; point: LatLng } | null> {
  const match = findPlaceNames(area, ["district", "landmark"])[0];
  const name = match?.name ?? area.trim();

  const local = localCentre(name.toLowerCase(), "abuja");
  if (local?.precision === "district") return { name, point: local.point };

  const results = await context.providers.geocoding
    .forward(`${name}, Abuja`, ABUJA.centre)
    .catch(() => []);
  const hit = results.find((result) => distanceMetres(result.point, ABUJA.centre) < 45_000);
  return hit ? { name: hit.name ?? name, point: hit.point } : null;
}

/**
 * Categories that are thin on the ground. Searching 1.5 km for a bus
 * terminal wastes two round trips before reaching a radius that can find one.
 */
const SPARSE_CATEGORY =
  /bus station|bus terminal|motor park|airport|embassy|stadium|mall|cinema|fire station|university|police/;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const resolvePlaceTool: AgentTool = {
  name: "resolve_place",
  tier: "read",
  description:
    "Turn a described place into coordinates. Use this whenever the user names or describes a destination in ordinary language, including vague or landmark-based descriptions like 'the guest house behind the mosque on Buhari Street' or 'that place beside the bank'. Returns a confidence band: 'high' means act on it, 'moderate' means ask the returned question before acting, 'low' means the description is too thin and you must ask for a landmark or a nearby business. Never present a moderate or low result as a settled answer. If `corrected_from` is set, the spelling was corrected — say 'did you mean …' once.",
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
    const said = String(input.phrase ?? "").trim();
    if (!said) return { error: "phrase is required" };

    // Correct district and road names before searching: the geocoder has no
    // idea that "Maintama" is Maitama, and returns nothing for it.
    const corrections = findPlaceNames(said).filter((match) => !match.exact);
    const phrase = applyCorrections(said, corrections);

    const resolutionContext = {
      city: typeof input.city === "string" ? input.city : context.city,
      currentLocation: context.currentLocation,
    };

    let result = await resolvePlace(phrase, context.providers, { context: resolutionContext });
    let viaWeb: WebPlaceHit | null = null;
    let webQuery: string | null = null;

    /*
     * The map does not have everything.
     *
     * Measured: OpenStreetMap has nothing called "Clover" anywhere in Abuja,
     * so a real hospital people navigate to every day simply could not be
     * found — and "I could not find it" is the least useful true answer there
     * is. The web does know these places, so when the map cannot identify one
     * confidently we search the web for its official name and address and
     * resolve THAT.
     *
     * The coordinates still come from the geocoder. The search only ever
     * supplies better words.
     */
    if ((result.band.band === "low" || !result.best) && webPlaceSearchAvailable()) {
      viaWeb = await searchPlaceOnWeb(phrase, {
        near: resolutionContext.city ? `${resolutionContext.city}, Nigeria` : "Abuja, Nigeria",
      }).catch(() => null);

      webQuery = viaWeb ? searchStringFor(viaWeb, resolutionContext.city ?? "Abuja") : null;

      if (webQuery) {
        const retry = await resolvePlace(webQuery, context.providers, {
          context: resolutionContext,
        }).catch(() => null);

        if (retry?.best) result = retry;
        else webQuery = null;
      }
    }

    return {
      band: result.band.band,
      rationale: result.band.rationale,
      corrected_from: corrections.length > 0 ? said : null,
      searched_for: webQuery ?? phrase,
      // Present when the web was used. Say "I found it listed as …" rather
      // than presenting a web result as though it came from the map.
      web_search: viaWeb
        ? {
            used: Boolean(webQuery),
            found_name: viaWeb.name,
            found_address: viaWeb.address,
            confidence: viaWeb.confidence,
            note: viaWeb.note,
            searches: viaWeb.searches,
          }
        : null,
      best: result.best
        ? {
            name: result.best.candidate.name,
            address: result.best.candidate.formattedAddress,
            lat: result.best.candidate.point.lat,
            lng: result.best.candidate.point.lng,
            place_id: result.best.candidate.placeId ?? null,
            distance_m: context.currentLocation
              ? Math.round(distanceMetres(context.currentLocation, result.best.candidate.point))
              : null,
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
    "Find places of a given kind near the user, or in a named area — restaurants, filling stations, hospitals, pharmacies, banks, ATMs, hotels, bus terminals and motor parks, markets, police stations, mechanics. Results come back nearest first, with road distance and travel time for the closest ones, and are pinned on the map. Use this for 'closest restaurant', 'I'm hungry', 'I need fuel', 'restaurants in Maitama'. After answering, offer directions to the nearest one. The search widens automatically when nothing is close.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "What to look for, in plain words: 'filling station', 'hospital', 'restaurant', 'pharmacy', 'bank', 'atm', 'hotel', 'bus station', 'police station', 'mechanic'.",
      },
      area: {
        type: "string",
        description: "Search in this district or landmark instead of around the user, e.g. 'Maitama'.",
      },
      lat: { type: "number", description: "Latitude to search around." },
      lng: { type: "number", description: "Longitude to search around." },
      radius_m: {
        type: "number",
        description: "Search radius in metres. Leave unset to widen automatically.",
      },
    },
    required: ["category"],
  },
  async execute(input, context) {
    const category = String(input.category ?? "").trim();

    let centre: LatLng | null = null;
    let areaName: string | null = null;

    if (typeof input.area === "string" && input.area.trim()) {
      const area = await areaCentre(input.area, context);
      if (!area) return { error: `The area "${input.area}" was not found in Abuja.` };
      centre = area.point;
      areaName = area.name;
    } else {
      centre = readPoint(input, context);
    }
    if (!centre) return NO_LOCATION;

    const requested =
      typeof input.radius_m === "number"
        ? Math.min(20_000, Math.max(200, input.radius_m))
        : null;

    // Widen until something turns up, instead of reporting "nothing nearby"
    // for a pharmacy 2.6 km away.
    const ladder = requested
      ? [requested]
      : SPARSE_CATEGORY.test(category.toLowerCase())
        ? [6_000, 15_000]
        : [1_500, 4_000, 10_000];

    let results: Awaited<ReturnType<Providers["places"]["nearbySearch"]>> = [];
    let searchedRadius = ladder[0]!;

    for (const [index, radiusM] of ladder.entries()) {
      searchedRadius = radiusM;
      results = await context.providers.places.nearbySearch({
        center: centre,
        radiusM,
        keyword: category,
        maxResults: 15,
      });
      const enough = index === ladder.length - 1 ? 1 : 2;
      if (results.length >= enough) break;
    }

    if (results.length === 0) {
      return {
        category,
        area: areaName,
        searched_radius_m: searchedRadius,
        results: [],
        note: "Nothing of that kind is mapped within the searched area. OpenStreetMap coverage is uneven in much of Nigeria, so this may mean 'not in the map data' rather than 'not there'. Say so rather than claiming there is nothing around.",
      };
    }

    const sorted = results
      .map((place) => ({ place, straight: distanceMetres(centre!, place.point) }))
      .sort((a, b) => a.straight - b.straight)
      .slice(0, 12);

    // "Closest" by road, for the few that matter. A place just across an
    // expressway can be the furthest drive in the list.
    const top = sorted.slice(0, 6);
    const times = await travelTimesFrom(
      centre,
      top.map((entry) => entry.place.point),
      routingMode(context.travelMode),
      2_500,
    );

    const enriched = sorted.map((entry, index) => {
      const time = index < times.length ? times[index] : null;
      return {
        id: entry.place.placeId,
        name: entry.place.name,
        address: entry.place.formattedAddress || null,
        lat: entry.place.point.lat,
        lng: entry.place.point.lng,
        distance_m: Math.round(entry.straight),
        road_distance_m: time?.distanceM ?? null,
        travel_time_s: time?.durationS ?? null,
        travel_time_text: time ? formatDuration(time.durationS) : null,
        types: entry.place.types,
      };
    });

    // Re-rank the timed ones by road distance; untimed stay in straight-line order after them.
    const timed = enriched.filter((place) => place.road_distance_m !== null);
    const untimed = enriched.filter((place) => place.road_distance_m === null);
    timed.sort((a, b) => a.road_distance_m! - b.road_distance_m!);
    const ordered = [...timed, ...untimed];

    return {
      category,
      area: areaName,
      searched_radius_m: searchedRadius,
      nearest: ordered[0]?.name ?? null,
      results: ordered,
    };
  },
  forModel(result) {
    const data = result as { results?: Array<Record<string, unknown>> } & Record<string, unknown>;
    return {
      ...data,
      results: (data.results ?? []).map(({ types: _types, id: _id, ...rest }) => rest),
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

const planTripTool: AgentTool = {
  name: "plan_trip",
  tier: "read",
  description:
    "Plan a trip from the user's current location to a destination AND start live navigation on the map. Returns the route (distance, time, arrival time, main roads), live traffic on the route, weather at both ends, community incident reports along the way, and safety notes. Use this whenever the user wants to go somewhere: 'take me there', 'directions to X', 'how do I get to X', 'how far is X', or 'yes' after you offered directions. It needs the destination's coordinates: use a place already listed under PLACES ON SCREEN, or call resolve_place / search_nearby first — never guess coordinates. Report it in two or three spoken sentences: time and arrival, the main road, traffic (only if a reading came back), weather if it matters, and any incident or safety note.",
  input_schema: {
    type: "object",
    properties: {
      to_lat: { type: "number", description: "Destination latitude." },
      to_lng: { type: "number", description: "Destination longitude." },
      to_name: { type: "string", description: "Destination name, for the map and the spoken summary." },
      mode: {
        type: "string",
        enum: ["driving", "walking", "cycling"],
        description: "Travel mode. Leave unset to use how the user is currently travelling.",
      },
    },
    required: ["to_lat", "to_lng"],
  },
  async execute(input, context) {
    const origin = context.currentLocation;
    if (!origin) return NO_LOCATION;

    const toLat = input.to_lat;
    const toLng = input.to_lng;
    if (typeof toLat !== "number" || typeof toLng !== "number") {
      return { error: "to_lat and to_lng are required numbers." };
    }

    const mode: TravelMode =
      input.mode === "walking" || input.mode === "cycling" || input.mode === "driving"
        ? (input.mode as TravelMode)
        : routingMode(context.travelMode);

    return planTrip({
      origin,
      destination: { lat: toLat, lng: toLng },
      destinationName: typeof input.to_name === "string" ? input.to_name : null,
      mode,
      traffic: context.traffic,
    });
  },
  forModel(result) {
    return tripForModel(result as TripPlan);
  },
};

const routeTool: AgentTool = {
  name: "calculate_route",
  tier: "read",
  description:
    "Distance and travel time between two arbitrary points, without starting navigation. Prefer plan_trip whenever the user wants to go somewhere; use this only to compare or answer 'how far is A from B' when neither end is the user.",
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
        description: "Travel mode. Default: how the user is travelling.",
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
      input.mode === "walking" || input.mode === "cycling" || input.mode === "driving"
        ? (input.mode as TravelMode)
        : routingMode(context.travelMode);

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
      // True when the time came from distance and an assumed speed rather
      // than from routing. Say "about" and do not quote it to the minute.
      duration_is_estimated: route.durationEstimated,
      ...(route.durationEstimated
        ? {
            routing_note:
              "Only car routing is available, so this walking/cycling time is estimated from the distance and the route may follow roads rather than footpaths.",
          }
        : {}),
      // The client draws this; the model should not try to describe it.
      geometry: route.geometry,
      steps: route.steps.slice(0, 12),
    };
  },
  forModel(result) {
    const { geometry: _geometry, steps, ...rest } = result as Record<string, unknown> & {
      steps?: Array<{ instruction: string; name: string }>;
    };
    return { ...rest, main_roads: [...new Set((steps ?? []).map((s) => s.name).filter(Boolean))].slice(0, 4) };
  },
};

const routeConditionsTool: AgentTool = {
  name: "check_route_conditions",
  tier: "read",
  description:
    "Compare traffic on alternative routes between two points without starting navigation. For a trip the user is about to take, use plan_trip (it already includes traffic). For traffic on a named road, use check_road_traffic. IMPORTANT: read `traffic.available` in the result. When it is false there is NO live traffic data and you must say so plainly — never describe conditions as light, moderate or heavy unless a reading actually came back.",
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
  forModel(result) {
    const data = result as { primary_route?: Record<string, unknown> } & Record<string, unknown>;
    if (!data.primary_route) return data;
    const { geometry: _geometry, ...primary } = data.primary_route;
    return { ...data, primary_route: primary };
  },
};

const roadTrafficTool: AgentTool = {
  name: "check_road_traffic",
  tier: "read",
  description:
    "Live traffic on one or more named roads or junctions — 'is there traffic on Sani Abacha Way', 'how is Murtala road', 'any go-slow at Berger'. Finds each road in the map by name (spelling-corrected), samples live speeds along it, and colours it on the map. Use this for a question about a road, not about a journey. Read each report: status 'not_built' means the road only exists as a plan; 'not_found' means ask for the full name or a landmark on it; traffic.available false means there is no live traffic data — say so, never guess.",
  input_schema: {
    type: "object",
    properties: {
      roads: {
        type: "array",
        items: { type: "string" },
        description: "Road or junction names as the user said them, up to three.",
      },
    },
    required: ["roads"],
  },
  async execute(input, context) {
    const roads = Array.isArray(input.roads)
      ? input.roads.filter((road): road is string => typeof road === "string" && road.trim() !== "")
      : typeof input.roads === "string"
        ? [input.roads]
        : [];

    if (roads.length === 0) return { error: "Name at least one road." };

    const traffic = context.traffic ?? new NoTrafficProvider();
    const reports = await Promise.all(
      roads.slice(0, 3).map((road) => checkRoadTraffic(road, traffic)),
    );

    return { roads: reports };
  },
  forModel(result) {
    const data = result as { roads: RoadTrafficReport[] };
    return {
      roads: data.roads.map((report) => ({
        asked: report.query,
        road: report.road,
        corrected_from: report.corrected_from,
        status: report.status,
        road_class: report.road_class,
        traffic_available: report.traffic.available,
        level: report.traffic.level,
        worst_stretch: report.traffic.worst_level,
        closure: report.traffic.closure,
        summary: report.traffic.summary,
        readings_taken: report.traffic.readings.length,
        note: report.note,
      })),
    };
  },
};

const exploreAreaTool: AgentTool = {
  name: "explore_area",
  tier: "read",
  description:
    "Describe a district or neighbourhood of Abuja — what it is, its best-known landmarks, named junctions and main roads — and show photos. Use this for 'where is Maitama', 'tell me about Wuse 2', 'what's in Garki', or a district name on its own. It corrects misspellings (Maintama → Maitama): when `corrected_from` is set, open with 'Did you mean <name>?' and carry on answering about <name>. Mention three or four landmarks and one or two main roads or junctions so the user can pinpoint the part they want, then ask which part they are heading to or offer directions.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The district or area, as the user said it." },
    },
    required: ["name"],
  },
  async execute(input, context) {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };
    return exploreArea(name, context.providers);
  },
  forModel(result) {
    const report = result as AreaReport;
    return {
      name: report.name,
      corrected_from: report.corrected_from,
      found: report.found,
      description: report.description,
      landmarks: report.landmarks.map((landmark) => `${landmark.name} (${landmark.category})`),
      junctions: report.junctions,
      main_roads: report.main_roads,
      photos_shown: report.images.length,
      note: report.note,
    };
  },
};

const webLookupTool: AgentTool = {
  name: "web_lookup",
  tier: "read",
  description:
    "Look a named place up on the web (Wikipedia and Wikimedia) for a short description and photos, which the app shows as a gallery. Use it together with resolve_place when the user asks about a specific named place or types an address, and when they ask what somewhere looks like. Small businesses usually have no web entry: when `summary` is null, say you found no description online. Never describe a place's appearance yourself — the photos speak for it.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the place." },
      area: { type: "string", description: "District or city it is in, if known." },
      lat: { type: "number", description: "Where the place is, if already resolved." },
      lng: { type: "number", description: "Where the place is, if already resolved." },
    },
    required: ["name"],
  },
  async execute(input) {
    const name = String(input.name ?? "").trim();
    if (!name) return { error: "name is required" };

    const near =
      typeof input.lat === "number" && typeof input.lng === "number"
        ? { lat: input.lat, lng: input.lng }
        : ABUJA.centre;

    const lookup = await lookupPlaceOnWeb({
      name,
      area: typeof input.area === "string" ? input.area : "Abuja",
      near,
    });

    return { name, ...lookup };
  },
  forModel(result) {
    const data = result as WebLookup & { name: string };
    return {
      name: data.name,
      summary: data.summary?.extract ?? null,
      source: data.summary?.url ?? null,
      photos_shown: data.images.length,
      note: data.note,
    };
  },
};

const scanSurroundingsTool: AgentTool = {
  name: "scan_surroundings",
  tier: "read",
  description:
    "Full scan of what is around a point: the street, the district, the most recognisable nearby landmark, and everything named within 800m with distances and compass directions. Defaults to the user's location. Use this when the user asks where they are, says they are lost, needs to describe their position to someone else, or when a resolved place needs to be explained by its surroundings. IMPORTANT: read `data_gaps` and obey it. Building colours are NOT in the map data anywhere in Nigeria — never describe the colour of a building, and never invent a detail the scan did not return.",
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
    "Current conditions and a five-day forecast, at the user's location or at a named place ('weather in Maitama'). Use this for any question about weather, rain, heat or whether to set off now — and only for those: 'where is Maitama' is a place question, not a weather one. Also worth calling unprompted when the user is planning a journey and `travel_advisory` would change their decision — in Abuja's rainy season a downpour is a real routing factor, not small talk.",
  input_schema: {
    type: "object",
    properties: {
      place: { type: "string", description: "A named place to get weather for, e.g. 'Maitama'. Omit for the user's location." },
      lat: { type: "number", description: "Latitude. Defaults to the user." },
      lng: { type: "number", description: "Longitude. Defaults to the user." },
    },
  },
  async execute(input, context) {
    let point = readPoint(input, context);
    let placeName: string | null = null;

    if (typeof input.place === "string" && input.place.trim()) {
      const area = await areaCentre(input.place, context);
      if (!area) return { error: `"${input.place}" was not found in Abuja, so there is no weather to report for it.` };
      point = area.point;
      placeName = area.name;
    }

    if (!point) return NO_LOCATION;

    const report = await getWeather(point);
    if (!report) return { error: "Weather data is unavailable right now." };

    return {
      place: placeName ?? "your location",
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

const webPlaceSearchTool: AgentTool = {
  name: "web_place_search",
  tier: "read",
  description:
    "Search the web (Google) for a place the map does not know, then put it on the map. Use this when resolve_place came back with a low band or nothing, or when the user insists a place exists that the map could not find — for example a new clinic, a school, a plaza or a business. It returns the official name and address found online, and the coordinates the geocoder produced for that address. Say plainly that you found it listed online, and offer directions. If `best` is null, the place could not be located even with the web: ask for a nearby landmark instead of offering something else.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The place as the user described it." },
      area: { type: "string", description: "District or city to search near, if known." },
    },
    required: ["query"],
  },
  async execute(input, context) {
    const query = String(input.query ?? "").trim();
    if (!query) return { error: "query is required" };

    if (!webPlaceSearchAvailable()) {
      return {
        query,
        web: null,
        best: null,
        note: "Web search is not configured, so only the map data is available.",
      };
    }

    const area = typeof input.area === "string" && input.area.trim() ? input.area.trim() : null;
    const city = context.city ?? "Abuja";

    const hit = await searchPlaceOnWeb(query, { near: area ? `${area}, ${city}` : `${city}, Nigeria` });
    const searchString = hit ? searchStringFor(hit, city) : null;

    if (!hit || !searchString) {
      return {
        query,
        web: hit,
        best: null,
        note: hit?.note ?? "The web search found nothing for that place near here.",
      };
    }

    // The web supplied the words; the geocoder supplies the point. Nothing
    // else in this system is allowed to turn text into coordinates.
    const resolved = await resolvePlace(searchString, context.providers, {
      context: { city: context.city, currentLocation: context.currentLocation },
    }).catch(() => null);

    const best = resolved?.best?.candidate ?? null;

    return {
      query,
      searched_for: searchString,
      web: {
        found_name: hit.name,
        found_address: hit.address,
        area: hit.area,
        confidence: hit.confidence,
        note: hit.note,
        searches: hit.searches,
        source: hit.source,
      },
      band: resolved?.band.band ?? "low",
      best: best
        ? {
            name: hit.name ?? best.name,
            address: best.formattedAddress,
            lat: best.point.lat,
            lng: best.point.lng,
            place_id: best.placeId ?? null,
            distance_m: context.currentLocation
              ? Math.round(distanceMetres(context.currentLocation, best.point))
              : null,
          }
        : null,
      note: best
        ? "Name and address came from a web listing; the coordinates came from the map. Say that you found it listed online."
        : "The web named the place but the geocoder could not place the address. Ask for a nearby landmark.",
    };
  },
  forModel(result) {
    const data = result as Record<string, unknown> & { web?: { searches?: string[] } | null };
    if (!data.web) return data;
    const { searches: _searches, ...web } = data.web as Record<string, unknown>;
    return { ...data, web };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  resolvePlaceTool,
  searchNearbyTool,
  webPlaceSearchTool,
  planTripTool,
  exploreAreaTool,
  webLookupTool,
  roadTrafficTool,
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
