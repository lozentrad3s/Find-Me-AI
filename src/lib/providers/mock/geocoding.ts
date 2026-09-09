/**
 * Mock geocoder.
 *
 * Deliberately worse than the Places mock, because that is the real-world
 * situation the product exists to fix: for informal Nigerian addresses a
 * geocoder typically returns an area centroid rather than a building. The
 * `precision` field carries that admission forward into scoring, where
 * centroid results are heavily discounted.
 *
 * If this mock were generous, the harness would flatter the pipeline.
 */

import type {
  GeocodeResult,
  GeocodingProvider,
} from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { containsAllTokens, tokenSimilarity } from "@/lib/text/similarity";
import { ALL_FIXTURES, CITY_CENTRES, type FixturePlace } from "./fixtures";

/** Area centroids, derived from the fixtures rather than hand-maintained. */
function areaCentroids(): Map<string, { point: LatLng; city: string }> {
  const groups = new Map<string, { lat: number; lng: number; n: number; city: string }>();

  for (const place of ALL_FIXTURES) {
    const key = `${place.city}::${place.area.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.lat += place.point.lat;
      existing.lng += place.point.lng;
      existing.n += 1;
    } else {
      groups.set(key, {
        lat: place.point.lat,
        lng: place.point.lng,
        n: 1,
        city: place.city,
      });
    }
  }

  const out = new Map<string, { point: LatLng; city: string }>();
  for (const [key, g] of groups) {
    const area = key.split("::")[1] ?? "";
    out.set(area, {
      point: { lat: g.lat / g.n, lng: g.lng / g.n },
      city: g.city,
    });
  }
  return out;
}

export class MockGeocodingProvider implements GeocodingProvider {
  readonly name = "mock";
  private readonly centroids = areaCentroids();

  async forward(address: string, bias?: LatLng): Promise<GeocodeResult[]> {
    const results: GeocodeResult[] = [];

    // A named route in the fixtures geocodes to an interpolated point. This is
    // where duplicate street names produce several equally-good answers, which
    // is exactly the ambiguity the confidence bands exist to catch.
    const routeMatches = ALL_FIXTURES.filter(
      (p) => p.types.includes("route") && tokenSimilarity(address, p.name) > 0.5,
    );

    for (const route of routeMatches) {
      results.push({
        formattedAddress: route.formattedAddress,
        point: route.point,
        precision: "interpolated",
        components: { route: route.name, area: route.area, city: route.city },
      });
    }

    // Otherwise fall back to an area centroid — the common real-world outcome.
    for (const [area, centroid] of this.centroids) {
      if (containsAllTokens(address, area)) {
        results.push({
          formattedAddress: `${titleCase(area)}, ${titleCase(centroid.city)}`,
          point: centroid.point,
          precision: "centroid",
          components: { area, city: centroid.city },
        });
      }
    }

    // Last resort: the city itself. Almost useless, and scored as such.
    if (results.length === 0) {
      for (const [city, point] of Object.entries(CITY_CENTRES)) {
        if (containsAllTokens(address, city)) {
          results.push({
            formattedAddress: `${titleCase(city)}, Nigeria`,
            point,
            precision: "approximate",
            components: { city },
          });
        }
      }
    }

    if (bias) {
      results.sort(
        (a, b) => distanceMetres(bias, a.point) - distanceMetres(bias, b.point),
      );
    }

    return results.slice(0, 5);
  }

  async reverse(point: LatLng): Promise<GeocodeResult[]> {
    const nearest = [...ALL_FIXTURES]
      .map((p) => ({ p, d: distanceMetres(point, p.point) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);

    return nearest.map(({ p, d }): GeocodeResult => ({
      formattedAddress: p.formattedAddress,
      point: p.point,
      precision: d < 40 ? "rooftop" : d < 250 ? "interpolated" : "centroid",
      components: { area: p.area, city: p.city },
    }));
  }
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export type { FixturePlace };
