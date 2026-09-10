"use client";

/**
 * Trips, Safety and Profile.
 *
 * Deliberately honest about what is not built yet. Each of these is a real
 * section of the master document with real depth behind it — journey planning,
 * trusted contacts, live sharing — and none of that exists at V0.1.
 *
 * Showing an empty tab with a clear note beats either hiding the tab (which
 * makes the shell wrong) or faking the feature (which is worse). The SOS
 * button is the exception: it is wired to something real, because a safety
 * control that does nothing is not a placeholder, it is a lie.
 */

import {
  Bell,
  ChevronRight,
  Clock,
  MapPin,
  Moon,
  Phone,
  Route,
  Share2,
  Shield,
  Star,
  Sun,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";

import type { RecentPlace, StoredPlace } from "@/lib/storage/places";
import type { LatLng } from "@/lib/geo/distance";
import { PlaceRow, distanceLabel } from "./HomePanel";
import styles from "./Panels.module.css";

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export function TripsPanel({
  recents,
  saved,
  userLocation,
  onOpenPlace,
  onClearRecents,
}: {
  recents: RecentPlace[];
  saved: StoredPlace[];
  userLocation: LatLng | null;
  onOpenPlace: (point: LatLng, name: string) => void;
  onClearRecents: () => void;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>Trips</h1>
        <p className={styles.greetingSub}>Where you have been looking.</p>
      </div>

      {saved.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>Saved places</h2>
          <div className={styles.list}>
            {saved.map((place) => (
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

      <section>
        <h2 className={styles.sectionTitle}>Recent searches</h2>
        {recents.length > 0 ? (
          <>
            <div className={styles.list}>
              {recents.map((place) => (
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
            <button
              type="button"
              onClick={onClearRecents}
              style={{
                marginTop: "var(--space-3)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                background: "none",
                color: "var(--fg-muted)",
                fontSize: 13,
                padding: 4,
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Clear history
            </button>
          </>
        ) : (
          <p className={styles.empty}>Nothing yet.</p>
        )}
      </section>

      <p className={styles.empty} style={{ paddingTop: 0 }}>
        Multi-stop journey planning is not built yet — it is next after the
        core search is proven.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export function SafetyPanel({
  locationLabel,
  onSos,
  onShareLocation,
}: {
  locationLabel: string;
  onSos: () => void;
  onShareLocation: () => void;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>Safety</h1>
        <p className={styles.greetingSub}>Your safety is the priority.</p>
      </div>

      <button type="button" className={styles.sosButton} onClick={onSos}>
        <Shield size={22} strokeWidth={2.4} aria-hidden="true" />
        SOS
      </button>

      <p className={styles.advisory}>
        <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        SOS currently copies your exact location so you can send it yourself. It
        does not alert anyone automatically — trusted contacts and the
        automatic alert path are not built yet, and a safety feature that only
        looks like it works is worse than none.
      </p>

      <section>
        <h2 className={styles.sectionTitle}>Right now</h2>
        <div className={styles.list}>
          <PlaceRow
            icon={<Share2 size={16} />}
            name="Share my location"
            meta={locationLabel}
            onClick={onShareLocation}
          />
          <PlaceRow
            icon={<Phone size={16} />}
            name="Emergency numbers"
            meta="Nigeria: 112 · Police 199 · FRSC 122"
            onClick={() => {
              window.location.href = "tel:112";
            }}
          />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function ProfilePanel({
  theme,
  onToggleTheme,
  speakReplies,
  onToggleSpeak,
  savedCount,
  recentCount,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  speakReplies: boolean;
  onToggleSpeak: () => void;
  savedCount: number;
  recentCount: number;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>Profile</h1>
        <p className={styles.greetingSub}>
          Signed out — everything is stored on this device only.
        </p>
      </div>

      <section>
        <h2 className={styles.sectionTitle}>Preferences</h2>
        <div className={styles.list}>
          <PlaceRow
            icon={theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
            name={theme === "dark" ? "Dark theme" : "Light theme"}
            meta="Tap to switch"
            onClick={onToggleTheme}
          />
          <PlaceRow
            icon={<Bell size={16} />}
            name={speakReplies ? "Spoken replies on" : "Spoken replies off"}
            meta="Read answers aloud in the chat panel"
            onClick={onToggleSpeak}
          />
        </div>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Your data</h2>
        <div className={styles.list}>
          <PlaceRow
            icon={<Star size={16} />}
            name={`${savedCount} saved place${savedCount === 1 ? "" : "s"}`}
            meta="Stored in this browser"
            onClick={() => undefined}
          />
          <PlaceRow
            icon={<Clock size={16} />}
            name={`${recentCount} recent search${recentCount === 1 ? "" : "es"}`}
            meta="Stored in this browser"
            onClick={() => undefined}
          />
        </div>
      </section>

      <p className={styles.empty} style={{ paddingTop: 0 }}>
        Accounts, trusted contacts and syncing across devices arrive with
        Supabase. Until then nothing leaves this browser except the searches
        you run.
      </p>
    </div>
  );
}

/** Re-exported so the shell has a single import for panel icons. */
export const PANEL_ICONS = { Route, MapPin, UserRound, ChevronRight };
