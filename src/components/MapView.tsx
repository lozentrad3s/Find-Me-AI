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
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
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

export interface MapViewProps {
  center: LatLng;
  zoom?: number;
  markers: MapMarker[];
  /** Encoded polyline from OSRM. */
  routeGeometry?: string | null;
  /** Recentre when this changes. */
  focus?: LatLng | null;
  dark?: boolean;
}

function pinIcon(kind: MapMarker["kind"]): L.DivIcon {
  if (kind === "user") {
    return L.divIcon({
      className: "",
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      html: `<span style="
        display:block;width:20px;height:20px;border-radius:50%;
        background:var(--primary);border:3px solid var(--surface);
        box-shadow:0 0 0 2px var(--primary), var(--shadow-md);
      "></span>`,
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

export default function MapView({
  center,
  zoom = 14,
  markers,
  routeGeometry,
  focus,
  dark = false,
}: MapViewProps) {
  const routePoints = useMemo(
    () => (routeGeometry ? decodePolyline(routeGeometry) : []),
    [routeGeometry],
  );

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

      {markers.map((marker) => (
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

      <FocusController focus={focus} zoom={16} />
    </MapContainer>
  );
}
