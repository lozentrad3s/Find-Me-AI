/**
 * Tool results -> what the screen shows.
 *
 * The invariant the whole app protects: map state comes from tool results,
 * never from anything the model says. A pin appears because a search returned
 * coordinates; a route is drawn because the router returned geometry; a card
 * offers "Directions" to a place because that place came back from a tool
 * with a point. If the model hallucinated a restaurant, nothing on the screen
 * would change.
 *
 * One pure function, so the chat stream and anything else that receives a
 * tool result turn it into the same pins, cards and follow-up context.
 */

import type { MapMarker, RoadOverlay } from "@/components/MapView";
import type { CardPlace, ChatCard, TripCardData } from "@/components/chat/Cards";
import type { LatLng } from "@/lib/geo/distance";
import type { ContextPlace } from "@/lib/ai/intent";
import type { TripPlan } from "@/lib/trip/plan";
import type { RoadTrafficReport } from "@/lib/traffic/roads";
import type { AreaReport } from "@/lib/area/explore";
import type { WebLookup } from "@/lib/web/wikimedia";
import { decodePolyline } from "@/lib/geo/polyline";

export interface Interpretation {
  markers?: MapMarker[];
  /** Fit the view to these (a result set). */
  fit?: LatLng[];
  /** Fly to this (a single answer). */
  focus?: LatLng;
  /** Draw this route, or clear it with null. */
  route?: string | null;
  /** A planned trip — the page starts navigation. */
  trip?: TripPlan;
  roads?: RoadOverlay[];
  cards?: ChatCard[];
  /** What "take me there" and "the second one" will refer to next. */
  places?: ContextPlace[];
  band?: "high" | "moderate" | "low";
  /** Worth adding to recent places. */
  remember?: { name: string; address: string; point: LatLng };
  locationDescription?: string;
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function toContext(place: CardPlace): ContextPlace {
  return {
    id: place.id,
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    address: place.address ?? null,
  };
}

/** Every nth point of a set of lines — enough to fit a view to a road. */
function sample(lines: LatLng[][], every = 6): LatLng[] {
  return lines.flatMap((line) => line.filter((_, index) => index % every === 0 || index === line.length - 1));
}

export function tripCard(plan: TripPlan): ChatCard {
  const weather = plan.weather.there ?? plan.weather.here;
  const trip: TripCardData = {
    destination: plan.destination.name,
    mode: plan.mode,
    durationText: plan.route.trafficDurationText ?? plan.route.durationText,
    distanceText: plan.route.distanceText,
    arrivalTime: plan.arrivalTime,
    via: plan.route.label,
    trafficLevel: plan.traffic.level,
    trafficAvailable: plan.traffic.available,
    weather: weather ? `${weather.temperatureC}° · ${weather.conditions}` : null,
    advisory: plan.weather.advisory,
    incidents: plan.incidents.length,
    alerts: plan.activeAlertsNearRoute,
    safety: plan.safety,
  };
  return { type: "trip", trip };
}

// ---------------------------------------------------------------------------

interface ResolveShape {
  band?: "high" | "moderate" | "low";
  best?: {
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
    distance_m?: number | null;
    place_id?: string | null;
  } | null;
  alternatives?: Array<{ name?: string; address?: string; lat?: number; lng?: number }>;
}

function fromResolve(data: ResolveShape): Interpretation {
  const best = data.best;
  if (!best || typeof best.lat !== "number" || typeof best.lng !== "number") {
    return { band: data.band };
  }

  const point = { lat: best.lat, lng: best.lng };
  const place: CardPlace = {
    id: best.place_id ?? `resolve-${best.lat}-${best.lng}`,
    name: best.name ?? "Result",
    address: best.address ?? null,
    lat: best.lat,
    lng: best.lng,
    distanceM: best.distance_m ?? null,
  };

  const alternatives: CardPlace[] = (data.alternatives ?? [])
    .filter((alt): alt is { name?: string; address?: string; lat: number; lng: number } =>
      typeof alt.lat === "number" && typeof alt.lng === "number",
    )
    .map((alt, index) => ({
      id: `alt-${index}-${alt.lat}-${alt.lng}`,
      name: alt.name ?? "Place",
      address: alt.address ?? null,
      lat: alt.lat,
      lng: alt.lng,
    }));

  // A confident answer gets a card with Directions. A moderate one is a
  // question the model is about to ask, so the candidates are listed instead
  // of one of them being presented as the answer.
  const cards: ChatCard[] =
    data.band === "high"
      ? [{ type: "place", place }]
      : data.band === "moderate"
        ? [{ type: "places", title: "Did you mean one of these?", places: [place, ...alternatives].slice(0, 4) }]
        : [];

  return {
    band: data.band,
    markers: [
      { id: place.id, point, label: place.name, detail: best.address, kind: "route-end" },
      ...(data.band === "moderate"
        ? alternatives.slice(0, 3).map((alt) => ({
            id: alt.id,
            point: { lat: alt.lat, lng: alt.lng },
            label: alt.name,
            detail: alt.address ?? undefined,
            kind: "result" as const,
          }))
        : []),
    ],
    focus: point,
    cards,
    places: [place, ...alternatives].map(toContext),
    // Only remember confident answers; a guess in the history is offered back later.
    remember:
      data.band === "high" ? { name: place.name, address: best.address ?? "", point } : undefined,
  };
}

interface NearbyShape {
  category?: string;
  area?: string | null;
  results?: Array<{
    id?: string;
    name?: string;
    address?: string | null;
    lat?: number;
    lng?: number;
    distance_m?: number;
    road_distance_m?: number | null;
    travel_time_text?: string | null;
  }>;
}

function fromNearby(data: NearbyShape): Interpretation {
  const places: CardPlace[] = (data.results ?? [])
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number")
    .map((r, index) => ({
      id: r.id ?? `nearby-${index}-${r.lat}-${r.lng}`,
      name: r.name ?? "Place",
      address: r.address ?? null,
      lat: r.lat!,
      lng: r.lng!,
      distanceM: r.road_distance_m ?? r.distance_m ?? null,
      travelText: r.travel_time_text ?? null,
    }));

  if (places.length === 0) return {};

  const category = titleCase(data.category ?? "Places");

  return {
    markers: places.slice(0, 15).map((place) => ({
      id: place.id,
      point: { lat: place.lat, lng: place.lng },
      label: place.name,
      detail: [place.travelText, place.address].filter(Boolean).join(" · ") || undefined,
      kind: "result" as const,
    })),
    fit: places.slice(0, 6).map((place) => ({ lat: place.lat, lng: place.lng })),
    cards: [
      {
        type: "places",
        title: data.area ? `${category} in ${data.area}` : `${category} near you`,
        places,
      },
    ],
    places: places.map(toContext),
  };
}

function fromTrip(plan: TripPlan): Interpretation {
  return {
    trip: plan,
    route: plan.route.geometry,
    cards: [tripCard(plan)],
    places: [
      {
        id: "destination",
        name: plan.destination.name,
        lat: plan.destination.point.lat,
        lng: plan.destination.point.lng,
      },
    ],
  };
}

function fromArea(report: AreaReport): Interpretation {
  const centre: CardPlace | null = report.centre
    ? {
        id: `area-${report.name}`,
        name: report.name,
        lat: report.centre.lat,
        lng: report.centre.lng,
        category: "area",
      }
    : null;

  const landmarks: CardPlace[] = report.landmarks.map((landmark, index) => ({
    id: `landmark-${index}-${landmark.lat}-${landmark.lng}`,
    name: landmark.name,
    lat: landmark.lat,
    lng: landmark.lng,
    category: landmark.category,
  }));

  const cards: ChatCard[] = [
    {
      type: "area",
      name: report.name,
      correctedFrom: report.corrected_from,
      summary: report.description,
      sourceUrl: report.wikipedia_url,
      centre,
      landmarks,
      roads: report.main_roads,
      junctions: report.junctions,
    },
  ];

  if (report.images.length > 0) {
    cards.push({
      type: "web",
      title: `Photos of ${report.name}`,
      summary: null,
      sourceUrl: report.wikipedia_url,
      images: report.images.map(({ thumb, pageUrl, title }) => ({ thumb, pageUrl, title })),
    });
  }

  if (!centre) return { cards };

  return {
    markers: [
      { id: centre.id, point: { lat: centre.lat, lng: centre.lng }, label: centre.name, kind: "route-end" },
      ...landmarks.map((landmark) => ({
        id: landmark.id,
        point: { lat: landmark.lat, lng: landmark.lng },
        label: landmark.name,
        detail: landmark.category ?? undefined,
        kind: "landmark" as const,
      })),
    ],
    fit: [centre, ...landmarks].map((place) => ({ lat: place.lat, lng: place.lng })),
    cards,
    places: [centre, ...landmarks].map(toContext),
  };
}

interface WebPlaceShape {
  query?: string;
  searched_for?: string;
  web?: {
    found_name?: string | null;
    found_address?: string | null;
    confidence?: string;
    note?: string | null;
  } | null;
  band?: "high" | "moderate" | "low";
  best?: {
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
    place_id?: string | null;
    distance_m?: number | null;
  } | null;
  note?: string | null;
}

/**
 * A place the map did not know, found by searching the web and then geocoded.
 *
 * It lands on the screen exactly like a mapped result — pin, card, Directions
 * button — because by this point it *is* a mapped result: the coordinates came
 * from the geocoder. Only the name and address came from the web, which is
 * what the reply says out loud.
 */
function fromWebPlace(data: WebPlaceShape): Interpretation {
  const best = data.best;
  if (!best || typeof best.lat !== "number" || typeof best.lng !== "number") return {};

  const point = { lat: best.lat, lng: best.lng };
  const place: CardPlace = {
    id: best.place_id ?? `web-${best.lat}-${best.lng}`,
    name: best.name ?? data.web?.found_name ?? "Result",
    address: best.address ?? data.web?.found_address ?? null,
    lat: best.lat,
    lng: best.lng,
    distanceM: best.distance_m ?? null,
  };

  return {
    band: data.band,
    markers: [
      { id: place.id, point, label: place.name, detail: place.address ?? undefined, kind: "route-end" },
    ],
    focus: point,
    cards: [{ type: "place", place }],
    places: [toContext(place)],
  };
}

function fromWeb(data: WebLookup & { name?: string }): Interpretation {
  if (!data.summary && data.images.length === 0) return {};

  return {
    cards: [
      {
        type: "web",
        title: data.summary?.title ?? data.name ?? "About this place",
        summary: data.summary?.extract ?? null,
        sourceUrl: data.summary?.url ?? null,
        images: data.images.map(({ thumb, pageUrl, title }) => ({ thumb, pageUrl, title })),
      },
    ],
  };
}

function fromRoads(data: { roads?: RoadTrafficReport[] }): Interpretation {
  const reports = data.roads ?? [];
  if (reports.length === 0) return {};

  const overlays: RoadOverlay[] = reports
    .filter((report) => report.geometry.length > 0)
    .map((report, index) => ({
      id: `road-${index}-${report.road ?? report.query}`,
      lines: report.geometry.map((line) => decodePolyline(line)),
      readings: report.traffic.readings.map((reading) => ({
        lat: reading.point.lat,
        lng: reading.point.lng,
        level: reading.level,
      })),
      level: report.status === "open" && report.traffic.available ? report.traffic.level : "unknown",
    }));

  // A junction measured at one point has no line to draw — pin it instead.
  const spots = reports.filter((report) => report.geometry.length === 0 && report.centre);

  const fit = [
    ...sample(overlays.flatMap((overlay) => overlay.lines)),
    ...spots.map((report) => report.centre!),
  ];

  const places: ContextPlace[] = reports
    .filter((report) => report.centre && report.road)
    .map((report, index) => ({
      id: `road-${index}`,
      name: report.road!,
      lat: report.centre!.lat,
      lng: report.centre!.lng,
    }));

  return {
    roads: overlays,
    markers: spots.map((report, index) => ({
      id: `spot-${index}`,
      point: report.centre!,
      label: report.road ?? report.query,
      detail: report.traffic.summary,
      kind: "result" as const,
    })),
    fit: fit.length > 0 ? fit : undefined,
    cards: [
      {
        type: "roads",
        roads: reports.map((report) => ({
          name: report.road ?? report.query,
          asked: report.query,
          status: report.status,
          level: report.traffic.level,
          available: report.traffic.available,
          summary: report.traffic.summary,
        })),
      },
    ],
    places: places.length > 0 ? places : undefined,
  };
}

interface WeatherShape {
  place?: string;
  current?: { temperature_c?: number; conditions?: string };
  travel_advisory?: string | null;
}

function fromWeather(data: WeatherShape): Interpretation {
  if (!data.current || typeof data.current.temperature_c !== "number") return {};
  return {
    cards: [
      {
        type: "weather",
        place: !data.place || data.place === "your location" ? "Where you are" : data.place,
        temperatureC: data.current.temperature_c,
        conditions: data.current.conditions ?? "",
        advisory: data.travel_advisory ?? null,
      },
    ],
  };
}

export function interpretToolResult(name: string, result: unknown): Interpretation {
  if (typeof result !== "object" || result === null || isError(result)) return {};

  switch (name) {
    case "resolve_place":
      return fromResolve(result as ResolveShape);
    case "search_nearby":
      return fromNearby(result as NearbyShape);
    case "plan_trip":
      return fromTrip(result as TripPlan);
    case "explore_area":
      return fromArea(result as AreaReport);
    case "web_lookup":
      return fromWeb(result as WebLookup & { name?: string });
    case "web_place_search":
      return fromWebPlace(result as WebPlaceShape);
    case "check_road_traffic":
      return fromRoads(result as { roads?: RoadTrafficReport[] });
    case "get_weather":
      return fromWeather(result as WeatherShape);
    case "scan_surroundings": {
      const description = (result as { spoken_description?: unknown }).spoken_description;
      return typeof description === "string" ? { locationDescription: description } : {};
    }
    case "calculate_route": {
      const geometry = (result as { geometry?: unknown }).geometry;
      return typeof geometry === "string" ? { route: geometry } : {};
    }
    case "check_route_conditions": {
      const geometry = (result as { primary_route?: { geometry?: unknown } }).primary_route?.geometry;
      return typeof geometry === "string" ? { route: geometry } : {};
    }
    default:
      return {};
  }
}
