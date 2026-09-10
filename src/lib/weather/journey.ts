/**
 * Weather along a journey — here, there, and whether that changes anything.
 *
 * The case this exists for: travelling Jos to Abuja, dry where you are, heavy
 * rain where you are going. Checking the weather at your own location tells you
 * nothing about that, and it is the single most useful thing a travel assistant
 * can volunteer in a country with a five-month rainy season.
 *
 * Deliberately comparative rather than two separate reports. "27° and clear"
 * followed by "24° and thunderstorms" makes the reader do the work; "it is
 * clear here but there are thunderstorms in Abuja" is the actual answer.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { getWeather, type WeatherReport } from "./open-meteo";

export interface JourneyWeather {
  origin: { label: string; report: WeatherReport | null };
  destination: { label: string; report: WeatherReport | null };
  /**
   * The one sentence worth saying, or null when conditions are unremarkable
   * at both ends. Null is a real answer — an assistant that comments on the
   * weather every single time gets tuned out.
   */
  alert: string | null;
  /** True when the destination is materially worse than here. */
  destinationWorse: boolean;
}

/** WMO codes at or above this are actively disruptive to travel. */
const DISRUPTIVE = 61;
const SEVERE = 95;

export async function getJourneyWeather(
  origin: LatLng,
  destination: LatLng,
  labels: { origin?: string; destination?: string } = {},
): Promise<JourneyWeather> {
  /*
   * Skip the second lookup for short hops.
   *
   * Weather does not meaningfully differ across 20km, so a cross-town trip
   * would spend an API call to compare a place with itself and then report a
   * difference that is really just forecast noise.
   */
  const farApart = distanceMetres(origin, destination) > 20_000;

  const [originReport, destinationReport] = await Promise.all([
    getWeather(origin),
    farApart ? getWeather(destination) : Promise.resolve(null),
  ]);

  const originLabel = labels.origin ?? "where you are";
  const destinationLabel = labels.destination ?? "your destination";

  return {
    origin: { label: originLabel, report: originReport },
    destination: {
      label: destinationLabel,
      report: destinationReport ?? originReport,
    },
    alert: buildAlert({
      originReport,
      destinationReport,
      originLabel,
      destinationLabel,
      farApart,
    }),
    destinationWorse: isWorse(destinationReport, originReport),
  };
}

function severity(report: WeatherReport | null): number {
  if (!report) return 0;

  const code = report.current.code;
  // Today's forecast matters as much as this minute's conditions when someone
  // is about to travel for two hours.
  const todayCode = report.daily[0]?.code ?? 0;
  const rainChance = report.daily[0]?.rainChancePct ?? 0;

  let score = Math.max(code >= SEVERE ? 3 : code >= DISRUPTIVE ? 2 : 0, 0);
  if (todayCode >= SEVERE) score = Math.max(score, 2);
  if (rainChance >= 70) score = Math.max(score, 1);

  return score;
}

function isWorse(
  destination: WeatherReport | null,
  origin: WeatherReport | null,
): boolean {
  if (!destination) return false;
  return severity(destination) > severity(origin);
}

function buildAlert(input: {
  originReport: WeatherReport | null;
  destinationReport: WeatherReport | null;
  originLabel: string;
  destinationLabel: string;
  farApart: boolean;
}): string | null {
  const { originReport, destinationReport, destinationLabel, farApart } = input;

  // Different places: the comparison is the point.
  if (farApart && destinationReport) {
    const there = destinationReport.current;
    const thereRain = destinationReport.daily[0]?.rainChancePct ?? 0;

    if (there.code >= SEVERE) {
      return `There are thunderstorms in ${destinationLabel} right now — roads flood quickly there. Consider delaying or allowing extra time.`;
    }
    if (there.code >= DISRUPTIVE) {
      return `It is raining in ${destinationLabel} (${there.description.toLowerCase()}), even though conditions here are different.`;
    }
    if (thereRain >= 70 && severity(destinationReport) > severity(originReport)) {
      return `${destinationLabel} has a ${thereRain}% chance of rain today. Worth setting off earlier.`;
    }

    return null;
  }

  // Same area: fall back to the local advisory, which already only speaks when
  // rain is close enough to change a departure decision.
  return originReport?.travelAdvisory ?? null;
}
