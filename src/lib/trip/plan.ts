/**
 * A trip: the route, and everything worth knowing before setting off.
 *
 * When someone says "take me there", Google Maps answers with a line on the
 * map and a time. In Abuja that is not enough: a thunderstorm floods low
 * roads, a checkpoint appears on a route that was clear an hour ago, and after
 * dark some roads are a different proposition. So a trip is planned as one
 * bundle — route, live traffic, weather at both ends, community reports along
 * the way, and a few plain safety notes — fetched in parallel so it costs one
 * round trip of waiting, not five.
 *
 * Every field is measured or explicitly absent. Traffic without a TomTom key
 * is `available: false`; weather that did not load is null; an incident is
 * listed only if someone reported it within 500 m of the route line.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { decodePolyline } from "@/lib/geo/polyline";
import {
  computeRoutes,
  formatDistance,
  formatDuration,
  labelRoute,
  type RouteStep,
  type TravelMode,
} from "@/lib/routing/osrm";
import {
  NoTrafficProvider,
  type CongestionLevel,
  type RouteConditions,
  type TrafficProvider,
} from "@/lib/traffic/types";
import { getWeather, type WeatherReport } from "@/lib/weather/open-meteo";
import { safetyStore } from "@/lib/safety/store";
import { INCIDENT_MAX_AGE_MS } from "@/lib/safety/types";

/** A community report further than this from the route is not "on" it. */
const INCIDENT_CORRIDOR_M = 500;

export interface TripInput {
  origin: LatLng;
  destination: LatLng;
  destinationName?: string | null;
  mode: TravelMode;
  traffic?: TrafficProvider;
}

export interface WeatherBrief {
  temperatureC: number;
  conditions: string;
  rainChanceTodayPct: number | null;
  /** WMO code, so the client can pick an icon. */
  code: number;
}

export interface TripIncident {
  kind: string;
  note: string;
  area: string | null;
  confirmations: number;
  minutesAgo: number;
  distanceFromRouteM: number;
  point: LatLng;
}

export interface TripPlan {
  destination: { name: string; point: LatLng };
  origin: LatLng;
  mode: TravelMode;
  route: {
    label: string;
    distanceM: number;
    distanceText: string;
    durationS: number;
    durationText: string;
    /** True when a walking/cycling time was estimated from distance. */
    durationEstimated: boolean;
    /** Free-flow time adjusted by measured traffic, when there is a reading. */
    trafficDurationS: number | null;
    trafficDurationText: string | null;
    geometry: string;
    steps: RouteStep[];
  };
  alternatives: Array<{
    label: string;
    distanceText: string;
    durationText: string;
    geometry: string | null;
  }>;
  traffic: {
    available: boolean;
    level: CongestionLevel;
    summary: string;
    closure: boolean;
    readings: Array<{ lat: number; lng: number; level: CongestionLevel }>;
  };
  weather: {
    here: WeatherBrief | null;
    there: WeatherBrief | null;
    advisory: string | null;
  };
  incidents: TripIncident[];
  activeAlertsNearRoute: number;
  /** Plain sentences, each backed by a field above or by the clock. */
  safety: string[];
  /** Local clock time of arrival, "14:32". */
  arrivalTime: string;
}

function brief(report: WeatherReport | null): WeatherBrief | null {
  if (!report) return null;
  return {
    temperatureC: Math.round(report.current.temperatureC),
    conditions: report.current.description,
    rainChanceTodayPct: report.daily[0]?.rainChancePct ?? null,
    code: report.current.code,
  };
}

function unavailableTraffic(summary: string): RouteConditions {
  return {
    available: false,
    source: "none",
    level: "unknown",
    summary,
    worstRatio: null,
    meanRatio: null,
    delayMinutes: null,
    anyClosure: false,
    samples: [],
  };
}

/** Nearest route vertex, in metres. OSRM geometry is dense enough for this. */
function distanceToRoute(point: LatLng, route: LatLng[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const vertex of route) {
    const d = distanceMetres(point, vertex);
    if (d < best) best = d;
  }
  return best;
}

function boundsOf(points: LatLng[]): { centre: LatLng; radiusM: number } {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const centre = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
  const corner = { lat: Math.max(...lats), lng: Math.max(...lngs) };
  return { centre, radiusM: distanceMetres(centre, corner) + INCIDENT_CORRIDOR_M };
}

/**
 * Community reports and live SOS alerts near the route.
 *
 * One query for the route's whole bounding circle, then an exact corridor
 * test here — rather than a query per kilometre of route against a store that
 * is, on a bad day, a free-tier database.
 */
async function safetyAlongRoute(
  route: LatLng[],
): Promise<{ incidents: TripIncident[]; alerts: number }> {
  if (route.length === 0) return { incidents: [], alerts: 0 };

  const store = safetyStore();
  const { centre, radiusM } = boundsOf(route);
  const since = Date.now() - INCIDENT_MAX_AGE_MS;

  const [incidents, alerts] = await Promise.all([
    store.incidentsNear(centre, radiusM, since).catch(() => []),
    store.activeAlertsNear(centre, radiusM).catch(() => []),
  ]);

  const onRoute = incidents
    .map((incident) => ({
      incident,
      distance: distanceToRoute(incident.point, route),
    }))
    .filter(({ distance }) => distance <= INCIDENT_CORRIDOR_M)
    .sort((a, b) => b.incident.confirmations - a.incident.confirmations || a.distance - b.distance)
    .slice(0, 5)
    .map(({ incident, distance }) => ({
      kind: incident.kind,
      note: incident.note,
      area: incident.area,
      confirmations: incident.confirmations,
      minutesAgo: Math.max(0, Math.round((Date.now() - incident.at) / 60_000)),
      distanceFromRouteM: Math.round(distance),
      point: incident.point,
    }));

  const alertsOnRoute = alerts.filter(
    (alert) => alert.lastFix && distanceToRoute(alert.lastFix, route) <= INCIDENT_CORRIDOR_M,
  ).length;

  return { incidents: onRoute, alerts: alertsOnRoute };
}

function lagosHour(): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: "Africa/Lagos",
  }).format(new Date());
  return Number.parseInt(hour, 10);
}

function clockAfter(seconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Africa/Lagos",
  }).format(new Date(Date.now() + seconds * 1000));
}

function safetyNotes(
  plan: Pick<TripPlan, "mode" | "incidents" | "activeAlertsNearRoute" | "traffic" | "route" | "weather">,
): string[] {
  const notes: string[] = [];

  if (plan.traffic.closure) notes.push("A road closure is reported on this route.");

  for (const incident of plan.incidents.slice(0, 2)) {
    const where = incident.area ? ` near ${incident.area}` : "";
    const trust =
      incident.confirmations > 0
        ? `${incident.confirmations} ${incident.confirmations === 1 ? "person" : "people"} confirmed it`
        : "unconfirmed";
    notes.push(
      `A ${incident.kind} was reported${where} about ${Math.max(1, Math.round(incident.minutesAgo / 60))} hour(s) ago, within ${incident.distanceFromRouteM} m of the route (${trust}).`,
    );
  }

  if (plan.activeAlertsNearRoute > 0) {
    notes.push("Someone near this route has an active SOS alert. If you can help safely, call 112.");
  }

  const hour = lagosHour();
  const dark = hour >= 19 || hour < 6;
  if (dark && plan.mode === "walking") {
    notes.push("It is dark. Keep to busy, lit roads and share your trip with someone you trust.");
  } else if (dark) {
    notes.push("Night driving: keep doors locked and stay on main roads where you can.");
  }

  const code = plan.weather.here?.code ?? plan.weather.there?.code ?? 0;
  if (code >= 61 && plan.mode !== "walking") {
    notes.push("Rain makes low roads flood quickly here. Slow down and avoid driving through standing water.");
  }

  if (plan.mode === "walking" && plan.route.distanceM > 3000) {
    notes.push(`That is a long walk (${plan.route.distanceText}). A car or bike would be much faster.`);
  }

  return notes.slice(0, 4);
}

export async function planTrip(input: TripInput): Promise<TripPlan | { error: string }> {
  const routes = await computeRoutes(
    input.origin,
    input.destination,
    input.mode,
    input.mode === "driving",
  );

  const primary = routes[0];
  if (!primary || !primary.geometry) {
    return {
      error:
        "No route could be calculated between those points. The road network there may not be mapped, or the routing service is not answering.",
    };
  }

  const points = decodePolyline(primary.geometry);
  const traffic = input.traffic ?? new NoTrafficProvider();
  const far = distanceMetres(input.origin, input.destination) > 3_000;

  const [conditions, hereWeather, thereWeather, safety] = await Promise.all([
    // A pedestrian is not held up by a jam, and each sample spends quota.
    input.mode === "walking"
      ? Promise.resolve(unavailableTraffic("Traffic is not checked for walking routes."))
      : traffic
          .sampleAlong(points)
          .catch(() => unavailableTraffic("The traffic service did not answer.")),
    getWeather(input.origin).catch(() => null),
    far ? getWeather(input.destination).catch(() => null) : Promise.resolve(null),
    safetyAlongRoute(points).catch(() => ({ incidents: [] as TripIncident[], alerts: 0 })),
  ]);

  const ratio = conditions.available && conditions.meanRatio ? Math.max(0.2, conditions.meanRatio) : null;
  const trafficDurationS = ratio ? Math.round(primary.durationS / ratio) : null;

  const here = brief(hereWeather);
  const there = far ? brief(thereWeather) : here;

  const partial = {
    mode: input.mode,
    route: {
      label: labelRoute(primary, 0),
      distanceM: primary.distanceM,
      distanceText: formatDistance(primary.distanceM),
      durationS: primary.durationS,
      durationText: formatDuration(primary.durationS),
      durationEstimated: primary.durationEstimated,
      trafficDurationS,
      trafficDurationText: trafficDurationS !== null ? formatDuration(trafficDurationS) : null,
      geometry: primary.geometry,
      steps: primary.steps,
    },
    traffic: {
      available: conditions.available,
      level: conditions.level,
      summary: conditions.summary,
      closure: conditions.anyClosure,
      readings: conditions.samples.map((sample) => ({
        lat: sample.point.lat,
        lng: sample.point.lng,
        level: sample.level,
      })),
    },
    weather: {
      here,
      there,
      advisory: thereWeather?.travelAdvisory ?? hereWeather?.travelAdvisory ?? null,
    },
    incidents: safety.incidents,
    activeAlertsNearRoute: safety.alerts,
  };

  return {
    ...partial,
    destination: {
      name: input.destinationName?.trim() || "your destination",
      point: input.destination,
    },
    origin: input.origin,
    alternatives: routes.slice(1, 3).map((route, index) => ({
      label: labelRoute(route, index + 1),
      distanceText: formatDistance(route.distanceM),
      durationText: formatDuration(route.durationS),
      geometry: route.geometry,
    })),
    safety: safetyNotes(partial),
    arrivalTime: clockAfter(trafficDurationS ?? primary.durationS),
  };
}

/**
 * The trip as the model should see it: everything it may say, nothing it
 * should read out. Geometry and the full step list are for the map and the
 * navigation banner; handing them to the model only invites it to narrate
 * coordinates.
 */
export function tripForModel(plan: TripPlan): Record<string, unknown> {
  return {
    destination: plan.destination.name,
    mode: plan.mode,
    route: plan.route.label,
    distance: plan.route.distanceText,
    duration_free_flow: plan.route.durationText,
    duration_with_traffic: plan.route.trafficDurationText,
    duration_is_estimate: plan.route.durationEstimated,
    arrival_time: plan.arrivalTime,
    main_roads: [...new Set(plan.route.steps.map((s) => s.name).filter(Boolean))].slice(0, 4),
    traffic: {
      available: plan.traffic.available,
      level: plan.traffic.level,
      summary: plan.traffic.summary,
      closure: plan.traffic.closure,
    },
    weather_here: plan.weather.here,
    weather_there: plan.weather.there,
    weather_advisory: plan.weather.advisory,
    incidents_on_route: plan.incidents.map((i) => ({
      kind: i.kind,
      area: i.area,
      confirmations: i.confirmations,
      minutes_ago: i.minutesAgo,
    })),
    active_sos_near_route: plan.activeAlertsNearRoute,
    safety_notes: plan.safety,
    alternatives: plan.alternatives.map((a) => ({
      label: a.label,
      distance: a.distanceText,
      duration: a.durationText,
    })),
    navigation_started: true,
  };
}
