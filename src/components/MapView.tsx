"use client";

/**
 * The map. Leaflet over OpenStreetMap raster tiles — free, no key.
 *
 * Loaded via next/dynamic with ssr:false from the page, because Leaflet
 * touches `window` at import time and will crash a server render.
 *
 * Markers are built from inline SVG rather than Leaflet's default PNG pins:
 * the default icon needs bundler-specific asset juggling, and building them
 * here means they inherit the theme tokens and stay legible in dark mode.
 *
 * THE USER MARKER
 *
 * Built once and then moved, never rebuilt. The previous marker was a new
 * icon on every render, so at one fix per second it flickered and jumped from
 * point to point. Now it glides between fixes over most of a second — which is
 * what makes movement read as movement — and turns with you: a car icon
 * rotates with the road, and on foot or a bike a cone sweeps round to show
 * which way you are heading.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  Circle,
  MapContainer,
  Marker,
  Pane,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./map/map.css";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { decodePolyline } from "@/lib/geo/polyline";
import type { CongestionLevel } from "@/lib/traffic/types";
import { TRAFFIC_COLOUR } from "@/lib/traffic/colours";

export interface MapMarker {
  id: string;
  point: LatLng;
  label: string;
  detail?: string;
  /**
   * `incident` — a community report: static, amber, a warning not an alarm.
   * `alert` — someone nearby with SOS active: red and pulsing, because it is
   * live and it is the one thing on the map a neighbour must not miss.
   * `landmark` — a named feature explaining an area; smaller than a result.
   */
  kind: "user" | "result" | "route-end" | "incident" | "alert" | "landmark";
}

export type TravelMode = "foot" | "bike" | "car" | "still";

export interface TrafficReading {
  lat: number;
  lng: number;
  level: CongestionLevel;
}

/** A road coloured by a road-traffic check. */
export interface RoadOverlay {
  id: string;
  lines: LatLng[][];
  readings: TrafficReading[];
  level: CongestionLevel;
}

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  /** Encoded polyline from OSRM. */
  routeGeometry?: string | null;
  /** Traffic readings along the route; each stretch takes its nearest reading's colour. */
  routeTraffic?: TrafficReading[] | null;
  /** Roads highlighted by "is there traffic on…". */
  roads?: RoadOverlay[];
  /** Recentre when this changes. */
  focus?: LatLng | null;
  /** Fit the view to these points whenever a new set arrives. */
  fitPoints?: LatLng[] | null;
  /**
   * Pixels of map hidden by the sheet at the bottom.
   *
   * Results are fitted into the visible strip above it; without this the pins
   * are centred in the map and half of them sit behind the panel listing them.
   */
  bottomInset?: number;
  dark?: boolean;
  /** Degrees clockwise from north; null when unknown. */
  heading?: number | null;
  /** Drives which character is drawn on the user marker. */
  travelMode?: TravelMode;
  /** Accuracy halo radius in metres. */
  accuracyM?: number | null;
  /** Keep the map centred on the user as they move. */
  followUser?: boolean;
  /** Navigating: follow closer, and do not zoom out to fit the route. */
  navigating?: boolean;
  /** Draw live traffic flow tiles. */
  trafficLayer?: boolean;
  /** The user dragged the map — the caller stops following. */
  onUserPan?: () => void;
  /**
   * Path already travelled, oldest first.
   *
   * Distinct from `routeGeometry`, which is a route someone is *proposing* to
   * take. This is where a person has actually been.
   */
  trail?: LatLng[];
}

/**
 * Glyphs for the user marker, as inline SVG so they inherit the theme and
 * need no network request. The car is drawn from above, nose up, so rotating
 * it by the heading points it down the road.
 */
const MODE_GLYPH: Record<TravelMode, string> = {
  foot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="2.2" fill="currentColor"/><path d="M10.5 8 L9 14 L7 20 M13 8 L15 13 L17.5 18 M9.5 11 L14.5 11" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>',
  bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 16.5 L10.5 8.5 L14 8.5 M10.5 16.5 L14.5 10 L18 16.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="15" cy="4.6" r="1.9" fill="currentColor"/></svg>',
  car: '<svg viewBox="0 0 22 28" aria-hidden="true"><path d="M6.4 1.5h9.2a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H6.4a3 3 0 0 1-3-3v-19a3 3 0 0 1 3-3z" fill="currentColor"/><path d="M5.6 8.6c1.6-1.2 3.5-1.8 5.4-1.8s3.8.6 5.4 1.8l-1 3.3H6.6z" fill="var(--primary)" opacity=".6"/><rect x="6.6" y="19.6" width="8.8" height="3.2" rx="1" fill="var(--primary)" opacity=".45"/></svg>',
  still: "",
};

function userMarkerHtml(mode: TravelMode): string {
  return `<div class="fm-user" data-mode="${mode}" data-heading="false">
    <span class="fm-user-halo"></span>
    <span class="fm-user-cone"></span>
    <span class="fm-user-body"><span class="fm-user-glyph">${MODE_GLYPH[mode]}</span></span>
  </div>`;
}

function pinIcon(kind: MapMarker["kind"]): L.DivIcon {
  if (kind === "alert") {
    return L.divIcon({
      className: "",
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -18],
      html: `<span class="fm-alert-pin" style="position:relative;display:grid;place-items:center;width:40px;height:40px">
        <span style="position:absolute;inset:0;border-radius:50%;background:rgb(239 68 68 / .28)"></span>
        <span style="position:relative;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;
          background:#dc2626;border:3px solid #fff;box-shadow:0 2px 8px rgb(127 29 29 / .5);
          color:#fff;font:800 11px/1 system-ui">!</span>
      </span>`,
    });
  }

  if (kind === "incident") {
    return L.divIcon({
      className: "",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -12],
      html: `<span style="display:grid;place-items:center;width:26px;height:26px;border-radius:50%;
          background:#f59e0b;border:2.5px solid var(--surface);
          box-shadow:0 2px 6px rgb(120 53 15 / .4);color:#fff">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.8" stroke-linecap="round" aria-hidden="true">
          <path d="M12 8v5M12 17h.01"/>
        </svg>
      </span>`,
    });
  }

  if (kind === "landmark") {
    return L.divIcon({
      className: "",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -8],
      html: `<span style="display:block;width:16px;height:16px;border-radius:50%;
          background:var(--accent);border:3px solid var(--surface);
          box-shadow:0 2px 6px rgb(12 74 110 / .35)"></span>`,
    });
  }

  const fill = kind === "route-end" ? "var(--accent)" : "var(--primary)";

  return L.divIcon({
    className: "",
    iconSize: [26, 34],
    // Anchor at the tip of the pin, not its centre, or every marker sits
    // slightly north of the place it is marking.
    iconAnchor: [13, 34],
    popupAnchor: [0, -30],
    html: `<svg width="26" height="34" viewBox="0 0 26 34" fill="none" aria-hidden="true"
        style="filter:drop-shadow(0 3px 5px rgb(12 74 110 / .35))">
        <path d="M13 33C13 33 24 21.4 24 13A11 11 0 1 0 2 13c0 8.4 11 20 11 20Z"
              fill="${fill}" stroke="var(--surface)" stroke-width="2.5"/>
        <circle cx="13" cy="13" r="4.2" fill="var(--surface)"/>
      </svg>`,
  });
}

/**
 * The live user marker, managed imperatively so it can glide and turn
 * without React rebuilding it on every fix.
 */
function UserLayer({
  point,
  heading,
  mode,
}: {
  point: LatLng | null;
  heading: number | null;
  mode: TravelMode;
}) {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  const shownRef = useRef<L.LatLng | null>(null);
  const frameRef = useRef<number | null>(null);
  const modeRef = useRef<TravelMode | null>(null);
  const rotationRef = useRef(0);

  // Create on the first fix; remove on unmount.
  useEffect(() => {
    if (!point || markerRef.current) return;

    const marker = L.marker([point.lat, point.lng], {
      icon: L.divIcon({ className: "", iconSize: [52, 52], iconAnchor: [26, 26], html: userMarkerHtml(mode) }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(map);

    markerRef.current = marker;
    shownRef.current = L.latLng(point.lat, point.lng);
    modeRef.current = mode;
  }, [map, point, mode]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      markerRef.current?.remove();
      markerRef.current = null;
    },
    [],
  );

  // Glide to each new fix.
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || !point) return;

    const from = shownRef.current ?? L.latLng(point.lat, point.lng);
    const to = L.latLng(point.lat, point.lng);

    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

    // A jump of kilometres is a new fix after a gap, not motion to animate.
    if (from.distanceTo(to) > 1500) {
      marker.setLatLng(to);
      shownRef.current = to;
      return;
    }

    const started = performance.now();
    const duration = 850;

    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = t * (2 - t);
      const current = L.latLng(
        from.lat + (to.lat - from.lat) * eased,
        from.lng + (to.lng - from.lng) * eased,
      );
      marker.setLatLng(current);
      shownRef.current = current;
      frameRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };

    frameRef.current = requestAnimationFrame(step);
  }, [point?.lat, point?.lng, point]);

  // Mode and heading: update the marker's own DOM in place.
  useEffect(() => {
    const element = markerRef.current?.getElement();
    const root = element?.querySelector<HTMLElement>(".fm-user");
    if (!root) return;

    if (modeRef.current !== mode) {
      root.dataset.mode = mode;
      const glyph = root.querySelector<HTMLElement>(".fm-user-glyph");
      if (glyph) glyph.innerHTML = MODE_GLYPH[mode];
      modeRef.current = mode;
    }

    const hasHeading = heading !== null && Number.isFinite(heading);
    root.dataset.heading = String(hasHeading && mode !== "car");

    if (hasHeading) {
      // Turn the short way round: 350° -> 10° is a 20° turn, not 340°.
      const current = rotationRef.current;
      const delta = ((((heading! - current) % 360) + 540) % 360) - 180;
      rotationRef.current = current + delta;
    }

    const cone = root.querySelector<HTMLElement>(".fm-user-cone");
    const body = root.querySelector<HTMLElement>(".fm-user-body");
    if (cone) cone.style.transform = `rotate(${rotationRef.current}deg)`;
    if (body) body.style.transform = mode === "car" && hasHeading ? `rotate(${rotationRef.current}deg)` : "";
  }, [heading, mode, point]);

  return null;
}

/** Imperatively pans the map when the focus point changes. */
function FocusController({ focus, zoom }: { focus?: LatLng | null; zoom: number }) {
  const map = useMap();

  useEffect(() => {
    if (!focus) return;
    map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), zoom), {
      duration: 0.85,
    });
  }, [focus, map, zoom]);

  return null;
}

/**
 * Fits the view to a new set of results or a new route.
 *
 * `bottomInset` is how much of the map the sheet is covering. Without it, pins
 * are centred in the *map*, which puts half of them behind the panel listing
 * them — the results are on screen and invisible at the same time.
 */
function FitController({
  points,
  bottomInset = 0,
}: {
  points?: LatLng[] | null;
  bottomInset?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (!points || points.length === 0) return;

    const topLeft: [number, number] = [36, 96];
    const bottomRight: [number, number] = [36, Math.max(36, bottomInset + 24)];

    if (points.length === 1) {
      const only = points[0]!;
      // A single point still has to clear the sheet, so it is fitted as a tiny
      // box rather than centred.
      map.flyToBounds(L.latLngBounds([[only.lat, only.lng], [only.lat, only.lng]]), {
        paddingTopLeft: topLeft,
        paddingBottomRight: bottomRight,
        maxZoom: 17,
        duration: 0.8,
      });
      return;
    }

    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.flyToBounds(bounds, {
      paddingTopLeft: topLeft,
      paddingBottomRight: bottomRight,
      maxZoom: 16,
      duration: 0.8,
    });
  }, [points, bottomInset, map]);

  return null;
}

/**
 * Keeps the map centred on the user while they move.
 *
 * `panTo` rather than `flyTo`: a fly animation restarts on every fix, so at
 * one update per second the map never settles and the whole view shimmers.
 * Navigating, it also zooms in to street level the first time.
 */
function FollowController({
  point,
  enabled,
  navigating,
}: {
  point: LatLng | null;
  enabled: boolean;
  navigating: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || !point) return;

    if (navigating && map.getZoom() < 16) {
      map.setView([point.lat, point.lng], 17, { animate: true });
      return;
    }
    map.panTo([point.lat, point.lng], { animate: true, duration: 0.8 });
  }, [point, enabled, navigating, map]);

  return null;
}

/** Tells the page when the user drags the map, so it stops following. */
function PanWatcher({ onUserPan }: { onUserPan?: () => void }) {
  useMapEvents({
    dragstart: () => onUserPan?.(),
  });
  return null;
}

/**
 * Split a line into runs coloured by the nearest traffic reading.
 *
 * Five readings cannot colour every metre of a route, so each stretch takes
 * the colour of the closest one — the same approximation the readings
 * themselves make — and anything far from every reading keeps the plain
 * route colour rather than borrowing a verdict from somewhere else.
 */
function colourRuns(
  points: LatLng[],
  readings: TrafficReading[] | null | undefined,
  fallback: string,
  reachM = 2_500,
): Array<{ colour: string; positions: Array<[number, number]> }> {
  if (points.length < 2) return [];
  if (!readings || readings.length === 0) {
    return [{ colour: fallback, positions: points.map((p) => [p.lat, p.lng]) }];
  }

  const colourAt = (point: LatLng): string => {
    let best: TrafficReading | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const reading of readings) {
      const d = distanceMetres(point, reading);
      if (d < bestDistance) {
        bestDistance = d;
        best = reading;
      }
    }
    return best && bestDistance <= reachM && best.level !== "unknown"
      ? TRAFFIC_COLOUR[best.level]
      : fallback;
  };

  const runs: Array<{ colour: string; positions: Array<[number, number]> }> = [];
  let run = { colour: colourAt(points[0]!), positions: [[points[0]!.lat, points[0]!.lng]] as Array<[number, number]> };

  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    run.positions.push([point.lat, point.lng]);
    const colour = colourAt(point);
    if (colour !== run.colour) {
      runs.push(run);
      run = { colour, positions: [[point.lat, point.lng]] };
    }
  }
  if (run.positions.length > 1) runs.push(run);

  return runs;
}

export default function MapView({
  center,
  zoom = 14,
  markers,
  routeGeometry,
  routeTraffic,
  roads,
  focus,
  fitPoints,
  bottomInset = 0,
  dark = false,
  heading = null,
  travelMode = "still",
  accuracyM = null,
  followUser = false,
  navigating = false,
  trafficLayer = false,
  onUserPan,
  trail,
}: MapViewProps) {
  const routePoints = useMemo(
    () => (routeGeometry ? decodePolyline(routeGeometry) : []),
    [routeGeometry],
  );

  const routeRuns = useMemo(
    () => colourRuns(routePoints, routeTraffic, "var(--accent)"),
    [routePoints, routeTraffic],
  );

  const roadRuns = useMemo(
    () =>
      (roads ?? []).flatMap((road) =>
        road.lines.flatMap((line, lineIndex) =>
          colourRuns(
            line,
            road.readings,
            road.level !== "unknown" ? TRAFFIC_COLOUR[road.level] : "var(--primary)",
            4_000,
          ).map((run, runIndex) => ({ ...run, key: `${road.id}-${lineIndex}-${runIndex}` })),
        ),
      ),
    [roads],
  );

  const userPoint = markers.find((m) => m.kind === "user")?.point ?? null;
  const pins = markers.filter((m) => m.kind !== "user");

  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={zoom}
      zoomControl={false}
      className={dark ? "fm-dark-tiles" : undefined}
      style={{ width: "100%", height: "100%" }}
    >
      <TileLayer
        // OSM tile policy: fine for development and low traffic. Move to a
        // dedicated tile host before this carries real users.
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
      />

      {/*
        Live traffic. Its own pane so the dark-mode filter on the base tiles
        does not invert it — red must stay red.
      */}
      {trafficLayer && (
        <Pane name="traffic" style={{ zIndex: 350 }} className="leaflet-traffic-pane">
          <TileLayer
            url="/api/traffic/tile/{z}/{x}/{y}?style=relative0"
            opacity={0.9}
            maxZoom={19}
            minZoom={5}
            attribution="Traffic &copy; TomTom"
          />
        </Pane>
      )}

      {roadRuns.map((run) => (
        <Polyline
          key={`${run.key}-casing`}
          positions={run.positions}
          pathOptions={{ color: "var(--surface)", weight: 11, opacity: 0.9 }}
        />
      ))}
      {roadRuns.map((run) => (
        <Polyline
          key={run.key}
          positions={run.positions}
          pathOptions={{ color: run.colour, weight: 7, opacity: 0.95, lineCap: "round" }}
        />
      ))}

      {routePoints.length > 1 && (
        <>
          {/* Casing beneath the line keeps it readable over busy tiles. */}
          <Polyline
            positions={routePoints.map((p) => [p.lat, p.lng])}
            pathOptions={{ color: "var(--surface)", weight: 10, opacity: 0.95 }}
          />
          {routeRuns.map((run, index) => (
            <Polyline
              key={`route-${index}-${run.colour}`}
              positions={run.positions}
              pathOptions={{ color: run.colour, weight: 6, opacity: 1, lineCap: "round" }}
            />
          ))}
          {!navigating && <FitController points={routePoints} />}
        </>
      )}

      {/*
        The travelled path. Dashed and beneath everything else so it reads as
        history rather than as a route to follow.
      */}
      {trail && trail.length > 1 && (
        <Polyline
          positions={trail.map((p) => [p.lat, p.lng])}
          pathOptions={{
            color: "var(--danger, #e5484d)",
            weight: 4,
            opacity: 0.75,
            dashArray: "1 9",
            lineCap: "round",
          }}
        />
      )}

      {/*
        Accuracy halo. Showing the real uncertainty is honest and useful — a
        ±800m fix drawn as a precise dot invites someone to trust a position
        the device never had.
      */}
      {userPoint && accuracyM && accuracyM > 25 && (
        <Circle
          center={[userPoint.lat, userPoint.lng]}
          radius={accuracyM}
          pathOptions={{
            color: "var(--primary)",
            weight: 1,
            opacity: 0.35,
            fillColor: "var(--primary)",
            fillOpacity: 0.08,
          }}
        />
      )}

      <UserLayer point={userPoint} heading={heading} mode={travelMode} />
      <FollowController point={userPoint} enabled={followUser} navigating={navigating} />
      <PanWatcher onUserPan={onUserPan} />

      {pins.map((marker) => (
        <Marker
          key={marker.id}
          position={[marker.point.lat, marker.point.lng]}
          icon={pinIcon(marker.kind)}
        >
          <Popup>
            <strong>{marker.label}</strong>
            {marker.detail ? (
              <>
                <br />
                <span style={{ color: "var(--fg-muted)" }}>{marker.detail}</span>
              </>
            ) : null}
          </Popup>
        </Marker>
      ))}

      <FitController points={fitPoints} bottomInset={bottomInset} />
      <FocusController focus={focus} zoom={16} />
    </MapContainer>
  );
}
