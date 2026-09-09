/**
 * Step 8 — reverse translation, machine back to human.
 *
 * The other half of the core insight: having turned a description into a point,
 * turn the point back into something a person can act on. This is the seed of
 * Tell My Driver — a sentence that works when read aloud to someone who will
 * never look at the screen, and who navigates by landmark rather than by street
 * name.
 *
 * Deliberately not turn-by-turn. Turn-by-turn is Google's job and it needs a
 * route. This describes the destination itself, which is what fails today.
 */

import type { PlacesProvider } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import {
  bearingDegrees,
  compassFromBearing,
  distanceMetres,
} from "@/lib/geo/distance";
import type { Candidate, NearbyLandmark, ReverseDescription } from "./types";

/* 500m rather than 800m. The area Overpass scans grows with the square of the
   radius, and a landmark you would mention to a driver is close by regardless. */
const LANDMARK_RADIUS_M = 500;
const MAX_LANDMARKS = 3;

export interface ReverseInput {
  candidate: Candidate;
  places: PlacesProvider;
  /** Where the traveller is starting from, when known. */
  origin?: LatLng;
}

export async function describeForHumans(
  input: ReverseInput,
): Promise<ReverseDescription> {
  const { candidate, places, origin } = input;

  const results = await places
    .nearbySearch({
      center: candidate.point,
      radiusM: LANDMARK_RADIUS_M,
      maxResults: 6,
    })
    .catch(() => []);

  const landmarks: NearbyLandmark[] = results
    .filter((result) => result.placeId !== candidate.placeId)
    // Rank by recognisability per unit distance: a well-known market 400 m away
    // is a better instruction than an anonymous shop next door, because the
    // driver has to have heard of it.
    .map((result) => {
      const metres = distanceMetres(candidate.point, result.point);
      return {
        result,
        metres,
        utility: (result.prominence ?? 0.2) / (1 + metres / 300),
      };
    })
    .sort((a, b) => b.utility - a.utility)
    .slice(0, MAX_LANDMARKS)
    .map(({ result, metres }) => {
      // Bearing FROM the landmark TO the destination: the driver is at the
      // landmark and needs to know which way to go next.
      const bearing = bearingDegrees(result.point, candidate.point);
      return {
        name: result.name,
        distanceM: Math.round(metres),
        bearing,
        direction: compassFromBearing(bearing),
      };
    });

  return {
    landmarks,
    approach: origin ? describeApproach(origin, candidate.point) : null,
    driverInstruction: buildDriverInstruction(candidate, landmarks),
  };
}

function describeApproach(origin: LatLng, destination: LatLng): string {
  const direction = compassFromBearing(bearingDegrees(origin, destination));
  const metres = distanceMetres(origin, destination);
  return `Roughly ${formatDistance(metres)} ${direction} of where you are now.`;
}

/**
 * The sentence a passenger reads out.
 *
 * Landmark first, because that is the part the driver recognises. The street
 * name goes second — in much of the country it is confirmation rather than
 * instruction.
 */
function buildDriverInstruction(
  candidate: Candidate,
  landmarks: NearbyLandmark[],
): string {
  const nearest = landmarks[0];
  const address = spokenAddress(candidate);

  if (!nearest) {
    return address
      ? `Take me to ${candidate.name}, on ${address}.`
      : `Take me to ${candidate.name}.`;
  }

  const proximity =
    nearest.distanceM <= 80
      ? `right beside ${nearest.name}`
      : `about ${formatDistance(nearest.distanceM)} ${nearest.direction} of ${nearest.name}`;

  const second = landmarks[1];
  const crossCheck = second ? ` If you pass ${second.name}, you have gone too far.` : "";

  const where = address ? `, on ${address}` : "";
  return `Take me to ${candidate.name} — it is ${proximity}${where}.${crossCheck}`;
}

/**
 * Trim a formatted address down to something you can say out loud.
 *
 * Nominatim's `display_name` is exhaustive rather than useful — it opens by
 * repeating the place name and then runs through street, district, city, LGA,
 * state, postcode and country. Read to a driver that is noise, and the
 * repetition ("Take me to Transcorp Hilton, Transcorp Hilton, 1, Aguiyi
 * Ironsi Street, ...") sounds like a stutter. Keep the street and district;
 * drop the name it already said and the administrative tail nobody needs.
 */
function spokenAddress(candidate: Candidate): string {
  const raw = candidate.formattedAddress?.trim();
  if (!raw) return "";

  const name = candidate.name.trim().toLowerCase();

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    // Drop the leading repeat of the place name, and any bare house number
    // stranded by removing it.
    .filter((part, index) => !(index <= 1 && part.toLowerCase() === name))
    .filter((part) => !/^\d{4,}$/.test(part));

  if (parts.length === 0) return "";

  // Street plus district is enough to orient a driver; past that it is filler.
  return parts.slice(0, 3).join(", ");
}

function formatDistance(metres: number): string {
  if (metres < 100) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
