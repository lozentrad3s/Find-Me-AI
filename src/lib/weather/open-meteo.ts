/**
 * Weather via Open-Meteo. Free, no key, no signup.
 *
 * Chosen over the usual suspects because it needs no account at all and allows
 * 10,000 calls a day for non-commercial use — the same reasoning that put
 * OpenStreetMap under the map. Check their licence before commercial launch.
 *
 * Weather earns its place in a navigation product here specifically. Abuja's
 * rainy season runs roughly April to October, and a live call on a September
 * morning returned 73-86% thunderstorm probability for three consecutive days.
 * In that weather, "is it about to rain on my route" changes whether someone
 * leaves now or in an hour, and unpaved or poorly-drained roads become a
 * genuine routing consideration rather than a detail.
 */

import type { LatLng } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";

const BASE = "https://api.open-meteo.com/v1/forecast";
const MIN_INTERVAL_MS = 200;
/** Conditions do not move fast enough to justify re-fetching per request. */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface CurrentWeather {
  temperatureC: number;
  feelsLikeC: number;
  humidityPct: number;
  windKph: number;
  precipitationMm: number;
  /** WMO weather code. */
  code: number;
  description: string;
  /** Lucide icon name the UI can render directly. */
  icon: WeatherIcon;
  isDay: boolean;
}

export interface DayForecast {
  date: string;
  /** "Today", "Tomorrow", then weekday names. */
  label: string;
  maxC: number;
  minC: number;
  code: number;
  description: string;
  icon: WeatherIcon;
  rainChancePct: number;
}

export interface WeatherReport {
  current: CurrentWeather;
  daily: DayForecast[];
  /** Set when rain is likely soon enough to change a departure decision. */
  travelAdvisory: string | null;
}

export type WeatherIcon =
  | "sun"
  | "cloud-sun"
  | "cloud"
  | "cloud-fog"
  | "cloud-drizzle"
  | "cloud-rain"
  | "cloud-lightning"
  | "snowflake";

/**
 * WMO weather interpretation codes.
 *
 * Open-Meteo returns a numeric code rather than a description, so this is the
 * lookup that turns 95 into "Thunderstorm". Descriptions are written to be
 * read aloud by the voice assistant, which is why they are plain phrases
 * rather than meteorological terms.
 */
const WMO: Record<number, { text: string; icon: WeatherIcon }> = {
  0: { text: "Clear", icon: "sun" },
  1: { text: "Mostly clear", icon: "cloud-sun" },
  2: { text: "Partly cloudy", icon: "cloud-sun" },
  3: { text: "Overcast", icon: "cloud" },
  45: { text: "Foggy", icon: "cloud-fog" },
  48: { text: "Freezing fog", icon: "cloud-fog" },
  51: { text: "Light drizzle", icon: "cloud-drizzle" },
  53: { text: "Drizzle", icon: "cloud-drizzle" },
  55: { text: "Heavy drizzle", icon: "cloud-drizzle" },
  56: { text: "Freezing drizzle", icon: "cloud-drizzle" },
  57: { text: "Freezing drizzle", icon: "cloud-drizzle" },
  61: { text: "Light rain", icon: "cloud-rain" },
  63: { text: "Rain", icon: "cloud-rain" },
  65: { text: "Heavy rain", icon: "cloud-rain" },
  66: { text: "Freezing rain", icon: "cloud-rain" },
  67: { text: "Freezing rain", icon: "cloud-rain" },
  71: { text: "Light snow", icon: "snowflake" },
  73: { text: "Snow", icon: "snowflake" },
  75: { text: "Heavy snow", icon: "snowflake" },
  77: { text: "Snow grains", icon: "snowflake" },
  80: { text: "Light showers", icon: "cloud-rain" },
  81: { text: "Showers", icon: "cloud-rain" },
  82: { text: "Heavy showers", icon: "cloud-rain" },
  85: { text: "Snow showers", icon: "snowflake" },
  86: { text: "Snow showers", icon: "snowflake" },
  95: { text: "Thunderstorm", icon: "cloud-lightning" },
  96: { text: "Thunderstorm with hail", icon: "cloud-lightning" },
  99: { text: "Thunderstorm with hail", icon: "cloud-lightning" },
};

function describe(code: number): { text: string; icon: WeatherIcon } {
  return WMO[code] ?? { text: "Unknown", icon: "cloud" };
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    precipitation?: number;
    weather_code?: number;
    is_day?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
  hourly?: {
    time?: string[];
    precipitation_probability?: number[];
  };
}

export async function getWeather(point: LatLng): Promise<WeatherReport | null> {
  const params = new URLSearchParams({
    latitude: point.lat.toFixed(3),
    longitude: point.lng.toFixed(3),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    hourly: "precipitation_probability",
    forecast_days: "5",
    timezone: "auto",
  });

  const data = await throttledFetchJson<OpenMeteoResponse>(
    `${BASE}?${params.toString()}`,
    { minIntervalMs: MIN_INTERVAL_MS, ttlMs: CACHE_TTL_MS },
  ).catch(() => null);

  const current = data?.current;
  if (!current || typeof current.temperature_2m !== "number") return null;

  const currentCode = current.weather_code ?? 0;
  const currentMeta = describe(currentCode);

  const daily = buildDaily(data.daily);

  return {
    current: {
      temperatureC: current.temperature_2m,
      feelsLikeC: current.apparent_temperature ?? current.temperature_2m,
      humidityPct: current.relative_humidity_2m ?? 0,
      windKph: current.wind_speed_10m ?? 0,
      precipitationMm: current.precipitation ?? 0,
      code: currentCode,
      description: currentMeta.text,
      icon: currentMeta.icon,
      isDay: current.is_day !== 0,
    },
    daily,
    travelAdvisory: buildAdvisory(data, currentCode),
  };
}

function buildDaily(daily: OpenMeteoResponse["daily"]): DayForecast[] {
  const dates = daily?.time ?? [];

  return dates.slice(0, 5).map((date, index) => {
    const code = daily?.weather_code?.[index] ?? 0;
    const meta = describe(code);

    return {
      date,
      label: dayLabel(date, index),
      maxC: daily?.temperature_2m_max?.[index] ?? 0,
      minC: daily?.temperature_2m_min?.[index] ?? 0,
      code,
      description: meta.text,
      icon: meta.icon,
      rainChancePct: daily?.precipitation_probability_max?.[index] ?? 0,
    };
  });
}

function dayLabel(date: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";

  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-GB", { weekday: "short" });
}

/**
 * A sentence worth interrupting someone with, or nothing.
 *
 * Deliberately conservative. An advisory that fires on every cloudy day is
 * noise people learn to ignore, which is worse than silence — so this only
 * speaks when rain is both likely and close enough to change whether you set
 * off now.
 */
function buildAdvisory(
  data: OpenMeteoResponse,
  currentCode: number,
): string | null {
  // Already raining hard: nothing to predict.
  if (currentCode >= 95) return "There is a thunderstorm right now. Roads flood quickly — consider waiting it out.";
  if (currentCode >= 80 && currentCode <= 82) return "Heavy showers right now.";

  const probabilities = data.hourly?.precipitation_probability ?? [];
  // The next three hours is the window in which "leave now or wait" is a real
  // question; beyond that it is a forecast, not a decision.
  const soon = probabilities.slice(0, 4).filter((p): p is number => typeof p === "number");
  if (soon.length === 0) return null;

  const peak = Math.max(...soon);
  if (peak >= 70) return `High chance of rain within the next few hours (${peak}%).`;
  if (peak >= 50) return `Rain is possible in the next few hours (${peak}%).`;

  return null;
}
