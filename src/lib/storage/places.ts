"use client";

/**
 * Saved places and recent searches, in the browser.
 *
 * localStorage is the right home for this *today* and the wrong home for it
 * eventually. Right today because it works with no account, no backend and no
 * signup friction, which matters enormously for a product nobody has heard of
 * yet. Wrong eventually because it does not survive a cleared cache or reach a
 * second device, and because saved places are exactly the kind of personal
 * data the Supabase schema already has a table for.
 *
 * So the shape here deliberately matches what will go into Postgres, and the
 * whole module is one swap away from being backed by it.
 *
 * Every read and write is wrapped: private browsing, blocked site data and
 * some embedded webviews all throw on access rather than returning null.
 */

import type { LatLng } from "@/lib/geo/distance";

const SAVED_KEY = "fm.saved-places.v1";
const RECENT_KEY = "fm.recent-places.v1";
const MAX_RECENTS = 12;

export interface StoredPlace {
  id: string;
  name: string;
  address: string;
  point: LatLng;
  /** "home" | "work" | null — drives the icon and pinning. */
  label: string | null;
  savedAt: string;
}

export interface RecentPlace {
  id: string;
  /** The phrase the user actually typed or said, not a tidied version. */
  phrase: string;
  name: string;
  address: string;
  point: LatLng;
  visitedAt: string;
}

function read<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, value: T[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked. Losing a recent entry is not worth
    // interrupting anyone over.
  }
}

// ---------------------------------------------------------------------------
// Saved places
// ---------------------------------------------------------------------------

export function getSavedPlaces(): StoredPlace[] {
  return read<StoredPlace>(SAVED_KEY);
}

export function savePlace(
  place: Omit<StoredPlace, "id" | "savedAt">,
): StoredPlace[] {
  const existing = getSavedPlaces();

  // Identity is the point, not the name: the same shop saved from a search and
  // from a map tap should not appear twice.
  const duplicate = existing.find(
    (entry) => nearlySame(entry.point, place.point),
  );
  if (duplicate) return existing;

  const next: StoredPlace = {
    ...place,
    id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: new Date().toISOString(),
  };

  const updated = [next, ...existing];
  write(SAVED_KEY, updated);
  return updated;
}

export function removeSavedPlace(id: string): StoredPlace[] {
  const updated = getSavedPlaces().filter((entry) => entry.id !== id);
  write(SAVED_KEY, updated);
  return updated;
}

export function isPlaceSaved(point: LatLng): boolean {
  return getSavedPlaces().some((entry) => nearlySame(entry.point, point));
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

export function getRecentPlaces(): RecentPlace[] {
  return read<RecentPlace>(RECENT_KEY);
}

export function addRecentPlace(
  place: Omit<RecentPlace, "id" | "visitedAt">,
): RecentPlace[] {
  const existing = getRecentPlaces().filter(
    (entry) => !nearlySame(entry.point, place.point),
  );

  const next: RecentPlace = {
    ...place,
    id: `recent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    visitedAt: new Date().toISOString(),
  };

  const updated = [next, ...existing].slice(0, MAX_RECENTS);
  write(RECENT_KEY, updated);
  return updated;
}

export function clearRecentPlaces(): void {
  write(RECENT_KEY, []);
}

// ---------------------------------------------------------------------------

/**
 * Two points close enough to be the same place.
 *
 * ~50m. Geocoders return slightly different coordinates for the same building
 * depending on which source answered, so exact comparison would create
 * duplicates that look identical to the user.
 */
function nearlySame(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lng - b.lng) < 0.0005;
}
