/**
 * Encoded-polyline decoder (Google/OSRM algorithm, precision 5).
 *
 * Small enough to own rather than take a dependency for, and it removes the
 * only thing standing between an OSRM response and a drawn route.
 */

import type { LatLng } from "./distance";

export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];

  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    // Latitude delta.
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;

    // Longitude delta.
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }

  return points;
}
