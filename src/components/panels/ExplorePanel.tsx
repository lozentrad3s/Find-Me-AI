"use client";

/**
 * Explore — browse by category.
 *
 * The counterpart to the assistant: when you know the *kind* of thing you want
 * but have no words for the specific place, tapping a category beats
 * describing one. Screen 5 of the design reference.
 *
 * Categories are chosen for this market rather than copied from a generic
 * template — fuel and pharmacies matter more here than coffee shops, and
 * "mechanic" is a category people genuinely search under pressure.
 */

import { useState } from "react";
import {
  Banknote,
  Building2,
  Cross,
  Fuel,
  Hospital,
  MapPin,
  Pill,
  School,
  ShoppingBasket,
  Store,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";

import type { LatLng } from "@/lib/geo/distance";
import { PlaceRow, distanceLabel } from "./HomePanel";
import styles from "./Panels.module.css";

export interface NearbyPlace {
  name: string;
  address: string | null;
  point: LatLng;
  distanceM: number;
}

export interface ExplorePanelProps {
  userLocation: LatLng | null;
  results: NearbyPlace[];
  loading: boolean;
  activeCategory: string | null;
  onCategory: (category: string, label: string) => void;
  onOpenPlace: (point: LatLng, name: string) => void;
}

const CATEGORIES = [
  { label: "Food", query: "restaurant", Icon: UtensilsCrossed, tint: "#ef4444" },
  { label: "Fuel", query: "fuel", Icon: Fuel, tint: "#f59e0b" },
  { label: "Pharmacy", query: "pharmacy", Icon: Pill, tint: "#8b5cf6" },
  { label: "Hospital", query: "hospital", Icon: Hospital, tint: "#10b981" },
  { label: "Bank", query: "bank", Icon: Banknote, tint: "#3b82f6" },
  { label: "Hotel", query: "hotel", Icon: Building2, tint: "#6366f1" },
  { label: "Market", query: "market", Icon: ShoppingBasket, tint: "#f97316" },
  { label: "Shops", query: "supermarket", Icon: Store, tint: "#14b8a6" },
  { label: "Mechanic", query: "mechanic", Icon: Wrench, tint: "#64748b" },
  { label: "Clinic", query: "clinic", Icon: Cross, tint: "#22c55e" },
  { label: "School", query: "school", Icon: School, tint: "#0ea5e9" },
  { label: "All", query: "", Icon: MapPin, tint: "#8b5cf6" },
] as const;

export default function ExplorePanel({
  userLocation,
  results,
  loading,
  activeCategory,
  onCategory,
  onOpenPlace,
}: ExplorePanelProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? CATEGORIES : CATEGORIES.slice(0, 8);

  return (
    <div className={styles.panel}>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>Explore</h1>
        <p className={styles.greetingSub}>
          {userLocation
            ? "What's around you right now."
            : "Share your location to see what's nearby."}
        </p>
      </div>

      <section>
        <h2 className={styles.sectionTitle}>Categories</h2>
        <div className={styles.categoryGrid}>
          {visible.map(({ label, query, Icon, tint }) => (
            <button
              key={label}
              type="button"
              className={styles.action}
              onClick={() => onCategory(query, label)}
              style={
                activeCategory === label
                  ? { borderColor: tint, boxShadow: "var(--shadow-md)" }
                  : undefined
              }
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

        {!showAll && CATEGORIES.length > 8 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{
              marginTop: "var(--space-2)",
              border: "none",
              background: "none",
              color: "var(--primary)",
              fontSize: 13,
              fontWeight: 550,
              padding: 4,
            }}
          >
            Show more categories
          </button>
        )}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>
          {activeCategory ? `${activeCategory} nearby` : "Nearby"}
        </h2>

        {loading ? (
          <div className={styles.list}>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        ) : results.length > 0 ? (
          <div className={styles.list}>
            {results.map((place, index) => (
              <PlaceRow
                key={`${place.name}-${index}`}
                icon={<MapPin size={16} />}
                name={place.name}
                meta={place.address ?? undefined}
                distance={distanceLabel(userLocation, place.point)}
                onClick={() => onOpenPlace(place.point, place.name)}
              />
            ))}
          </div>
        ) : activeCategory ? (
          <p className={styles.empty}>
            Nothing of that kind is mapped nearby.
            <br />
            OpenStreetMap coverage is uneven here — that may mean it is missing
            from the map rather than missing from the area.
          </p>
        ) : (
          <p className={styles.empty}>Pick a category to see what is around you.</p>
        )}
      </section>
    </div>
  );
}
