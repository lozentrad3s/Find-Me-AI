/**
 * Known cities.
 *
 * Find Me is being built for Abuja first and made to work properly there
 * before anywhere else. This registry is the mechanism: it pins the default
 * map view, biases every search, and — most importantly — removes a network
 * call from the hot path.
 *
 * That last point is not a micro-optimisation. Resolving a phrase used to
 * begin by geocoding "Wuse 2, Abuja" just to find somewhere to search around,
 * and under Nominatim's one-request-per-second policy that lookup alone cost
 * over a second before any real work started. District centres barely move
 * from one year to the next, so looking them up over the network every time
 * was buying nothing.
 *
 * Districts are the ones people actually name when giving directions.
 */

import type { LatLng } from "./distance";

export interface CityDefinition {
  id: string;
  name: string;
  centre: LatLng;
  /** Rough radius covering the built-up area, metres. */
  radiusM: number;
  /** Districts, lowercased, to their approximate centres. */
  districts: Record<string, LatLng>;
  /** Whether the product is considered supported here. */
  supported: boolean;
}

export const ABUJA: CityDefinition = {
  id: "abuja",
  name: "Abuja",
  centre: { lat: 9.0579, lng: 7.4951 },
  radiusM: 25_000,
  supported: true,
  districts: {
    wuse: { lat: 9.0643, lng: 7.4711 },
    "wuse 2": { lat: 9.0787, lng: 7.4625 },
    maitama: { lat: 9.0857, lng: 7.4903 },
    garki: { lat: 9.0333, lng: 7.4881 },
    asokoro: { lat: 9.0392, lng: 7.5203 },
    gwarinpa: { lat: 9.1092, lng: 7.4053 },
    utako: { lat: 9.0686, lng: 7.4386 },
    jabi: { lat: 9.0723, lng: 7.4222 },
    wuye: { lat: 9.0503, lng: 7.4494 },
    kubwa: { lat: 9.1554, lng: 7.3299 },
    nyanya: { lat: 9.0, lng: 7.56 },
    lugbe: { lat: 8.9836, lng: 7.3711 },
    dutse: { lat: 9.1178, lng: 7.3906 },
    karu: { lat: 9.0022, lng: 7.5847 },
    gudu: { lat: 9.0139, lng: 7.4694 },
    durumi: { lat: 9.0244, lng: 7.4642 },
    apo: { lat: 9.0011, lng: 7.4664 },
    life_camp: { lat: 9.0925, lng: 7.4189 },
    "central business district": { lat: 9.0578, lng: 7.4898 },
    cbd: { lat: 9.0578, lng: 7.4898 },
    airport: { lat: 9.0068, lng: 7.2632 },
  },
};

/**
 * Jos is defined but not marked supported.
 *
 * The master document names it as a launch candidate, and it is where the
 * addressing problem is most acute — but OSM coverage there is thin enough
 * that the engine cannot yet do a good job. Keeping the definition means the
 * moment there is data or a correction layer, turning it on is one flag.
 */
export const JOS: CityDefinition = {
  id: "jos",
  name: "Jos",
  centre: { lat: 9.8965, lng: 8.8583 },
  radiusM: 20_000,
  supported: false,
  districts: {
    rayfield: { lat: 9.8478, lng: 8.8756 },
    terminus: { lat: 9.9285, lng: 8.8921 },
    "farin gada": { lat: 9.9518, lng: 8.8788 },
    naraguta: { lat: 9.9603, lng: 8.8897 },
    bukuru: { lat: 9.7938, lng: 8.8676 },
    "tudun wada": { lat: 9.9165, lng: 8.8845 },
    lamingo: { lat: 9.91, lng: 8.86 },
    jenta: { lat: 9.9219, lng: 8.8672 },
    katako: { lat: 9.9375, lng: 8.8869 },
    laranto: { lat: 9.9441, lng: 8.8931 },
  },
};

export const CITIES: Record<string, CityDefinition> = {
  abuja: ABUJA,
  jos: JOS,
};

/** The city the product is built around today. */
export const DEFAULT_CITY = ABUJA;

export function findCity(name?: string | null): CityDefinition | null {
  if (!name) return null;
  return CITIES[name.trim().toLowerCase()] ?? null;
}

/**
 * Best known centre for a place description, without touching the network.
 *
 * Preference order matters: a district the user actually named beats the city,
 * and the city they named beats wherever their phone happens to be. Someone
 * standing in Garki can perfectly well ask about Kubwa.
 */
export function localCentre(
  area?: string | null,
  city?: string | null,
): { point: LatLng; precision: "district" | "city" } | null {
  const resolved = findCity(city) ?? DEFAULT_CITY;

  if (area) {
    const key = area.trim().toLowerCase();
    const district = resolved.districts[key];
    if (district) return { point: district, precision: "district" };

    // Try every city, in case the district was named without its city.
    for (const candidate of Object.values(CITIES)) {
      const match = candidate.districts[key];
      if (match) return { point: match, precision: "district" };
    }
  }

  if (city && findCity(city)) {
    return { point: resolved.centre, precision: "city" };
  }

  return null;
}
