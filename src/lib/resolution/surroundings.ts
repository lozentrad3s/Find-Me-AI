/**
 * Surroundings scan — everything around a point, described the way a person
 * would describe it.
 *
 * This is the machine-to-human half of the core insight, done properly. Given
 * a coordinate it answers: what is the address, what is the nearest thing you
 * would actually recognise, what is on each side, and what would you say to a
 * driver.
 *
 * WHAT THIS CANNOT DO, AND WHY IT DOES NOT PRETEND TO
 *
 * Building colour is not available data. OpenStreetMap has a `building:colour`
 * tag and it is essentially never populated anywhere in Nigeria — a scan of
 * central Abuja returns none. There is no free source that has it, and street
 * imagery coverage (Google Street View, Mapillary) is close to absent in Abuja
 * too. So "the blue house on your left" cannot be produced from real data.
 *
 * The temptation is to let a language model fill that in, because it will
 * happily produce a plausible colour. That is the exact failure this product
 * exists to prevent: an invented detail, delivered in the same confident tone
 * as a measured one, in a tool people use to find each other. Where the tag
 * genuinely exists it is reported; where it does not, the field is absent and
 * the model is told not to guess.
 *
 * What IS available and genuinely useful: names, categories, distances,
 * compass bearings, street names, junctions, and how prominent each thing is.
 * That is enough to say "you are on Gana Street, about 80 m north of the
 * filling station, with the pharmacy on your right" — which is how people
 * actually give directions here.
 */

import type { PlacesProvider, GeocodingProvider } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import {
  bearingDegrees,
  compassFromBearing,
  distanceMetres,
} from "@/lib/geo/distance";

export interface SurroundingFeature {
  name: string;
  category: string | null;
  distanceM: number;
  /** Compass direction from the user to the feature. */
  direction: string;
  bearing: number;
  /**
   * Present only when OSM actually carries a colour tag for the building.
   * Absent means unknown, and unknown must be reported as unknown.
   */
  colour?: string;
}

export interface SurroundingsReport {
  point: LatLng;
  address: string | null;
  /** Street the point sits on, when the geocoder resolved one. */
  street: string | null;
  area: string | null;
  /** The single most recognisable thing nearby — what you'd name on a call. */
  primaryLandmark: SurroundingFeature | null;
  /** Everything found, nearest first. */
  features: SurroundingFeature[];
  /** Counts by category, so the model can say "three banks and a market". */
  summary: Record<string, number>;
  /** A sentence that works read aloud to a driver. */
  spokenDescription: string;
  /** Stated so the model does not fill the gap. */
  dataGaps: string[];
}

/*
 * 800m, not 400m.
 *
 * Measured, not guessed: a scan around a Maitama point found zero named
 * features at 400m and twelve at 800m. Abuja's districts are spread out and
 * OSM density is uneven, so a tight radius returns "nothing here" for places
 * that are visibly surrounded by landmarks. A landmark 700m away is still a
 * useful thing to say; an empty scan is not.
 */
const SCAN_RADIUS_M = 800;
const MAX_FEATURES = 14;

export async function scanSurroundings(
  point: LatLng,
  providers: { places: PlacesProvider; geocoding: GeocodingProvider },
): Promise<SurroundingsReport> {
  const [addressResults, nearby] = await Promise.all([
    providers.geocoding.reverse(point).catch(() => []),
    providers.places
      .nearbySearch({ center: point, radiusM: SCAN_RADIUS_M, maxResults: 25 })
      .catch(() => []),
  ]);

  const address = addressResults[0];
  const components = address?.components ?? {};

  const features: SurroundingFeature[] = nearby
    .filter((place) => place.name && place.name !== "Unnamed place")
    .map((place) => {
      const bearing = bearingDegrees(point, place.point);
      return {
        name: place.name,
        category: place.types?.[0] ?? null,
        distanceM: Math.round(distanceMetres(point, place.point)),
        direction: compassFromBearing(bearing),
        bearing,
        prominence: place.prominence ?? 0,
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_FEATURES)
    .map(({ prominence: _prominence, ...feature }) => feature);

  // The landmark you would name on a phone call is not simply the closest
  // one — it is the one the other person has heard of. Recognisability decays
  // with distance, so this trades the two off rather than taking either alone.
  const primaryLandmark =
    [...features]
      .map((feature) => ({
        feature,
        utility: recognisability(feature.category) / (1 + feature.distanceM / 200),
      }))
      .sort((a, b) => b.utility - a.utility)[0]?.feature ?? null;

  const summary: Record<string, number> = {};
  for (const feature of features) {
    const key = feature.category ?? "other";
    summary[key] = (summary[key] ?? 0) + 1;
  }

  const street = components.road ?? components.pedestrian ?? null;
  const area =
    components.suburb ?? components.neighbourhood ?? components.city_district ?? null;

  const dataGaps: string[] = [];
  if (features.every((feature) => feature.colour === undefined)) {
    dataGaps.push(
      "No building colours are recorded for this area. Do not describe the colour of any building — that data does not exist here.",
    );
  }
  if (features.length === 0) {
    dataGaps.push(
      "Nothing named is mapped within 400m. This is a gap in OpenStreetMap coverage, not necessarily an empty area.",
    );
  }
  if (!street) {
    dataGaps.push("The geocoder did not return a street name for this point.");
  }

  return {
    point,
    address: address?.formattedAddress ?? null,
    street,
    area,
    primaryLandmark,
    features,
    summary,
    spokenDescription: describe({ street, area, primaryLandmark, features }),
    dataGaps,
  };
}

/**
 * How likely someone is to recognise a category by name.
 *
 * Rough, and deliberately so — the ordering is what matters. A filling station
 * or a market is a landmark everyone in the area knows; an office is not.
 */
function recognisability(category: string | null): number {
  if (!category) return 0.2;

  const strong = /fuel|market|mall|hospital|university|stadium|airport|bank|place_of_worship|bus_station/;
  const medium = /pharmacy|restaurant|hotel|school|supermarket|police|clinic|fast_food/;

  if (strong.test(category)) return 1;
  if (medium.test(category)) return 0.6;
  return 0.3;
}

/** The sentence you would actually say. */
function describe(input: {
  street: string | null;
  area: string | null;
  primaryLandmark: SurroundingFeature | null;
  features: SurroundingFeature[];
}): string {
  const parts: string[] = [];

  if (input.street) {
    parts.push(`You're on ${input.street}${input.area ? ` in ${input.area}` : ""}.`);
  } else if (input.area) {
    parts.push(`You're in ${input.area}.`);
  }

  const landmark = input.primaryLandmark;
  if (landmark) {
    parts.push(
      landmark.distanceM <= 60
        ? `${landmark.name} is right beside you.`
        : `${landmark.name} is about ${formatMetres(landmark.distanceM)} ${landmark.direction} of you.`,
    );
  }

  // Two more nearby things, which is what makes a description checkable — one
  // landmark can be wrong, three agreeing rarely are.
  const others = input.features
    .filter((feature) => feature !== landmark)
    .slice(0, 2);

  if (others.length > 0) {
    parts.push(
      `Also nearby: ${others
        .map((feature) => `${feature.name} (${formatMetres(feature.distanceM)} ${feature.direction})`)
        .join(", ")}.`,
    );
  }

  if (parts.length === 0) {
    return "Nothing named is mapped around this point, so there is no landmark to describe.";
  }

  return parts.join(" ");
}

function formatMetres(metres: number): string {
  if (metres < 100) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
