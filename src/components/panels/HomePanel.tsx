"use client";

/**
 * Home — the dashboard.
 *
 * Ordered by what someone opening the app actually wants: where am I, what is
 * the weather doing, then the few things they do repeatedly. Recents sit above
 * saved places because in practice people return to somewhere they went last
 * week far more often than they consult a list they curated once.
 */

import {
  Fuel,
  Hospital,
  MapPin,
  Mic,
  Search,
  Star,
  UtensilsCrossed,
  Clock,
} from "lucide-react";

import type { WeatherReport } from "@/lib/weather/open-meteo";
import type { RecentPlace, StoredPlace } from "@/lib/storage/places";
import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import WeatherCard from "./WeatherCard";
import styles from "./Panels.module.css";

export interface HomePanelProps {
  locationLabel: string;
  weather: WeatherReport | null;
  weatherLoading: boolean;
  recents: RecentPlace[];
  saved: StoredPlace[];
  userLocation: LatLng | null;
  onSearch: () => void;
  onVoice: () => void;
  onAsk: (phrase: string) => void;
  onOpenPlace: (point: LatLng, name: string) => void;
}

const QUICK_ACTIONS = [
  { label: "Fuel", phrase: "Find a filling station near me", Icon: Fuel, tint: "#f59e0b" },
  { label: "Food", phrase: "Find a restaurant near me", Icon: UtensilsCrossed, tint: "#ef4444" },
  { label: "Hospital", phrase: "Find a hospital near me", Icon: Hospital, tint: "#10b981" },
  { label: "Pharmacy", phrase: "Find a pharmacy near me", Icon: Star, tint: "#8b5cf6" },
] as const;

export default function HomePanel({
  locationLabel,
  weather,
  weatherLoading,
  recents,
  saved,
  userLocation,
  onSearch,
  onVoice,
  onAsk,
  onOpenPlace,
}: HomePanelProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>{timeGreeting()}</h1>
        <p className={styles.greetingSub}>Where would you like to go today?</p>
      </div>

      <button type="button" className={styles.searchBar} onClick={onSearch}>
        <Search size={18} className={styles.searchIcon} aria-hidden="true" />
        Ask Find Me…
        <span
          className={styles.searchMic}
          onClick={(event) => {
            // The mic is a button inside a button, so its click must not also
            // open the text composer behind it.
            event.stopPropagation();
            onVoice();
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onVoice();
            }
          }}
          aria-label="Talk to Find Me"
        >
          <Mic size={15} aria-hidden="true" />
        </span>
      </button>

      <WeatherCard
        report={weather}
        loading={weatherLoading}
        placeLabel={locationLabel}
      />

      <section>
        <h2 className={styles.sectionTitle}>Quick actions</h2>
        <div className={styles.actionGrid}>
          {QUICK_ACTIONS.map(({ label, phrase, Icon, tint }) => (
            <button
              key={label}
              type="button"
              className={styles.action}
              onClick={() => onAsk(phrase)}
            >
              <span
                className={styles.actionIcon}
                style={{ background: tint }}
                aria-hidden="true"
              >
                <Icon size={17} strokeWidth={2.1} />
              </span>
              {label}
            </button>
          ))}
        </div>
      </section>

      {recents.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>Recent</h2>
          <div className={styles.list}>
            {recents.slice(0, 4).map((place) => (
              <PlaceRow
                key={place.id}
                icon={<Clock size={16} />}
                name={place.name}
                meta={place.phrase}
                distance={distanceLabel(userLocation, place.point)}
                onClick={() => onOpenPlace(place.point, place.name)}
              />
            ))}
          </div>
        </section>
      )}

      {saved.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>Saved</h2>
          <div className={styles.list}>
            {saved.slice(0, 4).map((place) => (
              <PlaceRow
                key={place.id}
                icon={<Star size={16} />}
                name={place.name}
                meta={place.address}
                distance={distanceLabel(userLocation, place.point)}
                onClick={() => onOpenPlace(place.point, place.name)}
              />
            ))}
          </div>
        </section>
      )}

      {recents.length === 0 && saved.length === 0 && (
        <p className={styles.empty}>
          Places you search for will show up here.
          <br />
          Try &ldquo;a pharmacy in Garki&rdquo; or describe somewhere by its
          landmarks.
        </p>
      )}
    </div>
  );
}

export function PlaceRow({
  icon,
  name,
  meta,
  distance,
  onClick,
}: {
  icon: React.ReactNode;
  name: string;
  meta?: string;
  distance?: string | null;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.placeRow} onClick={onClick}>
      <span className={styles.placeIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.placeText}>
        <span className={styles.placeName}>{name}</span>
        {meta && <span className={styles.placeMeta}>{meta}</span>}
      </span>
      {distance && <span className={styles.placeDistance}>{distance}</span>}
    </button>
  );
}

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function distanceLabel(
  from: LatLng | null,
  to: LatLng,
): string | null {
  if (!from) return null;

  const metres = distanceMetres(from, to);
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
