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
 */

import { useEffect, useMemo } from "react";
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import type { LatLng } from "@/lib/geo/distance";
import { decodePolyline } from "@/lib/geo/polyline";

export interface MapMarker {
  id: string;
  point: LatLng;
  label: string;
  detail?: string;
  kind: "user" | "result" | "route-end";
}

export type TravelMode = "foot" | "bike" | "car" | "still";

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  /** Encoded polyline from OSRM. */
  routeGeometry?: string | null;
  /** Recentre when this changes. */
  focus?: LatLng | null;
  dark?: boolean;
  /** Degrees clockwise from north; null when stationary. */
  heading?: number | null;
  /** Drives which character is drawn on the user marker. */
  travelMode?: TravelMode;
  /** Accuracy halo radius in metres. */
  accuracyM?: number | null;
  /** Keep the map centred on the user as they move. */
  followUser?: boolean;
}

/**
 * Glyphs for the user marker.
 *
 * Inline SVG paths rather than an icon font or images: they inherit the theme,
 * need no network request, and cannot flash a broken image while loading.
 */
const MODE_GLYPH: Record<TravelMode, string> = {
  foot: '<circle cx="12" cy="4.5" r="2.2"/><path d="M10.5 8 L9 14 L7 20 M13 8 L15 13 L17.5 18 M9.5 11 L14.5 11" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  bike: '<circle cx="6" cy="16.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 16.5 L10.5 8.5 L14 8.5 M10.5 16.5 L14.5 10 L18 16.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="15" cy="4.6" r="1.9"/>',
  car: '<path d="M4 15.5 L5.4 10.4 A2 2 0 0 1 7.3 9 h9.4 a2 2 0 0 1 1.9 1.4 L20 15.5 v3 a1 1 0 0 1-1 1 h-1.6 a1 1 0 0 1-1-1 v-1 H7.6 v1 a1 1 0 0 1-1 1 H5 a1 1 0 0 1-1-1 z" fill="currentColor"/><circle cx="7.6" cy="14.6" r="1.15" fill="var(--surface)"/><circle cx="16.4" cy="14.6" r="1.15" fill="var(--surface)"/>',
  still: "",
};

/**
 * The user marker.
 *
 * A plain dot tells you where you are; it does not tell you which way you are
 * facing, which is the thing you actually need when deciding whether to walk
 * left or right out of a building. So: a heading cone when moving, and a
 * glyph showing how you are travelling.
 */
function userIcon(heading: number | null, mode: TravelMode): L.DivIcon {
  const moving = heading !== null && mode !== "still";

  // The cone rotates; the glyph does not, so it stays readable at any bearing.
  const cone = moving
    ? `<span style="
         position:absolute;left:50%;top:50%;
         transform:translate(-50%,-100%) rotate(${heading}deg);
         transform-origin:50% 100%;
         width:0;height:0;
         border-left:13px solid transparent;
         border-right:13px solid transparent;
         border-bottom:22px solid var(--primary);
         opacity:.32;filter:blur(0.4px);
       "></span>`
    : "";

  const glyph = MODE_GLYPH[mode]
    ? `<svg viewBox="0 0 24 24" width="17" height="17"
            style="position:relative;color:var(--on-primary)">${MODE_GLYPH[mode]}</svg>`
    : "";

  return L.divIcon({
    className: "",
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<span style="position:relative;display:grid;place-items:center;width:44px;height:44px">
      ${cone}
      <span style="
        position:relative;display:grid;place-items:center;
        width:${moving ? 28 : 20}px;height:${moving ? 28 : 20}px;border-radius:50%;
        background:var(--primary);border:3px solid var(--surface);
        box-shadow:0 0 0 1px var(--primary), var(--shadow-md);
        transition:width .2s,height .2s;
      ">${glyph}</span>
    </span>`,
  });
}

function pinIcon(kind: MapMarker["kind"]): L.DivIcon {
  if (kind === "user") {
    return userIcon(null, "still");
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

/** Fits the viewport to the whole route once one exists. */
function RouteFitter({ points }: { points: LatLng[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length < 2) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 16 });
  }, [points, map]);

  return null;
}

/**
 * Keeps the map centred on the user while they move.
 *
 * `panTo` rather than `flyTo`: a fly animation restarts on every fix, so at
 * one update per second the map never settles and the whole view shimmers.
 */
function FollowController({
  point,
  enabled,
}: {
  point: LatLng | null;
  enabled: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || !point) return;
    map.panTo([point.lat, point.lng], { animate: true, duration: 0.6 });
  }, [point, enabled, map]);

  return null;
}

export default function MapView({
  center,
  zoom = 14,
  markers,
  routeGeometry,
  focus,
  dark = false,
  heading = null,
  travelMode = "still",
  accuracyM = null,
  followUser = false,
}: MapViewProps) {
  const routePoints = useMemo(
    () => (routeGeometry ? decodePolyline(routeGeometry) : []),
    [routeGeometry],
  );

  const userPoint = markers.find((m) => m.kind === "user")?.point ?? null;

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

      {routePoints.length > 1 && (
        <>
          {/* Casing beneath the line keeps it readable over busy tiles. */}
          <Polyline
            positions={routePoints.map((p) => [p.lat, p.lng])}
            pathOptions={{ color: "var(--surface)", weight: 9, opacity: 0.9 }}
          />
          <Polyline
            positions={routePoints.map((p) => [p.lat, p.lng])}
            pathOptions={{ color: "var(--accent)", weight: 5, opacity: 1 }}
          />
          <RouteFitter points={routePoints} />
        </>
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

      <FollowController point={userPoint} enabled={followUser} />

      {markers.map((marker) => (
        <Marker
          key={marker.id}
          position={[marker.point.lat, marker.point.lng]}
          icon={
            marker.kind === "user"
              ? userIcon(heading, travelMode)
              : pinIcon(marker.kind)
          }
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

      <FocusController focus={focus} zoom={16} />
    </MapContainer>
  );
}
