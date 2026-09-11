"use client";

/**
 * Home — the dashboard.
 *
 * Ordered by what someone opening the app actually wants: where am I, what is
 * the weather doing, then the few things they do repeatedly. Recents sit above
 * saved places because in practice people return to somewhere they went last
 * week far more often than they consult a list they curated once.
 *
 * The quick actions search directly and pin the results on the map. They used
 * to go through the assistant, which made the most-tapped buttons in the app
 * the slowest ones, and spent the model's small daily quota on requests that
 * need no language understanding at all.
 */

import {
  Banknote,
  BedDouble,
  Bus,
  Clock,
  Fuel,
  Hospital,
  MapPin,
  Mic,
  Pill,
  Search,
  Shield,
  Star,
  UtensilsCrossed,
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
  /** Search a category directly and pin the results. */
  onCategory: (query: string, label: string) => void;
  onOpenPlace: (point: LatLng, name: string) => void;
}

const QUICK_ACTIONS = [
  { label: "Food", query: "restaurant", Icon: UtensilsCrossed, tint: "#ef4444" },
  { label: "Fuel", query: "fuel", Icon: Fuel, tint: "#f59e0b" },
  { label: "Hospital", query: "hospital", Icon: Hospital, tint: "#10b981" },
  { label: "Pharmacy", query: "pharmacy", Icon: Pill, tint: "#8b5cf6" },
  { label: "ATM", query: "atm", Icon: Banknote, tint: "#3b82f6" },
  { label: "Bus park", query: "bus station", Icon: Bus, tint: "#0ea5e9" },
  { label: "Hotel", query: "hotel", Icon: BedDouble, tint: "#6366f1" },
  { label: "Police", query: "police station", Icon: Shield, tint: "#64748b" },
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
  onCategory,
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
        <h2 className={styles.sectionTitle}>Find nearby</h2>
        <div className={styles.actionGrid}>
          {QUICK_ACTIONS.map(({ label, query, Icon, tint }) => (
            <button
              key={label}
              type="button"
              className={styles.action}
              onClick={() => onCategory(query, label)}
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
        {icon ?? <MapPin size={16} />}
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
