"use client";

/**
 * Weather, sized for a glance.
 *
 * On the home screen of a navigation app weather is not a feature in its own
 * right — it is one input to "should I leave now". So the card leads with the
 * current temperature and the five-day rain chance, and only interrupts with
 * an advisory when rain is close enough to change that decision.
 *
 * Rain probability is shown for every day rather than tucked away, because in
 * Abuja between April and October it is the number people are actually
 * looking for.
 */

import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  Snowflake,
  Sun,
  TriangleAlert,
} from "lucide-react";

import type { WeatherIcon, WeatherReport } from "@/lib/weather/open-meteo";
import styles from "./Panels.module.css";

const ICONS: Record<WeatherIcon, typeof Sun> = {
  sun: Sun,
  "cloud-sun": CloudSun,
  cloud: Cloud,
  "cloud-fog": CloudFog,
  "cloud-drizzle": CloudDrizzle,
  "cloud-rain": CloudRain,
  "cloud-lightning": CloudLightning,
  snowflake: Snowflake,
};

export interface WeatherCardProps {
  report: WeatherReport | null;
  loading: boolean;
  placeLabel: string;
}

export default function WeatherCard({
  report,
  loading,
  placeLabel,
}: WeatherCardProps) {
  if (loading && !report) {
    return <div className={styles.skeleton} style={{ height: 132 }} />;
  }

  if (!report) return null;

  const Icon = ICONS[report.current.icon] ?? Cloud;

  return (
    <div className={styles.weatherCard}>
      <div className={styles.weatherTop}>
        <span className={styles.weatherIcon} aria-hidden="true">
          <Icon size={24} strokeWidth={2} />
        </span>

        <span>
          <span className={styles.weatherTemp}>
            {Math.round(report.current.temperatureC)}°
          </span>
          <span className={styles.weatherDesc}>
            {report.current.description}
            {/* Only mention "feels like" when it actually differs — a
                redundant number is noise on a glanceable card. */}
            {Math.abs(
              report.current.feelsLikeC - report.current.temperatureC,
            ) >= 2 && <> · feels {Math.round(report.current.feelsLikeC)}°</>}
          </span>
        </span>

        <span className={styles.weatherPlace}>{placeLabel}</span>
      </div>

      {report.daily.length > 0 && (
        <div className={styles.forecastRow}>
          {report.daily.slice(0, 5).map((day) => {
            const DayIcon = ICONS[day.icon] ?? Cloud;
            return (
              <span key={day.date} className={styles.forecastDay}>
                <span className={styles.forecastLabel}>{day.label}</span>
                <DayIcon size={17} strokeWidth={1.9} aria-hidden="true" />
                <span className={styles.forecastTemp}>
                  {Math.round(day.maxC)}°
                </span>
                {day.rainChancePct >= 20 && (
                  <span className={styles.rainChance}>
                    <Droplets size={9} aria-hidden="true" />
                    {day.rainChancePct}%
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {report.travelAdvisory && (
        <p className={styles.advisory}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          {report.travelAdvisory}
        </p>
      )}
    </div>
  );
}
