"use client";

/**
 * Device location, requested properly and kept fresh.
 *
 * This replaces a tap-only implementation that never asked for location on
 * load, which produced the worst possible failure: the browser had permission,
 * the user believed they had granted it, and the assistant kept insisting no
 * location was shared — because nothing had ever called getCurrentPosition.
 *
 * Three things make the difference between "asks for location" and "actually
 * has location":
 *
 * 1. Check the Permissions API first. When permission is already granted, the
 *    position can be fetched immediately on load with no prompt at all. That
 *    is the returning-user path and it should be silent.
 * 2. Watch rather than poll. `watchPosition` delivers updates as the fix
 *    improves — the first reading is often a coarse network estimate and GPS
 *    refines it seconds later. A one-shot call frequently captures the coarse
 *    one and keeps it forever.
 * 3. Keep the best fix, not the newest. Accuracy fluctuates, and letting a
 *    ±2000m reading overwrite a ±15m one makes the pin visibly jump.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { LatLng } from "@/lib/geo/distance";

export type LocationStatus =
  | "idle"
  | "prompting"
  | "locating"
  | "granted"
  | "denied"
  | "unavailable";

export interface UseLocation {
  point: LatLng | null;
  accuracyM: number | null;
  status: LocationStatus;
  error: string | null;
  /** Explicitly ask, for a button. Safe to call when already granted. */
  request: () => void;
}

/** A newer fix must be this much worse before it is allowed to replace a good one. */
const ACCURACY_TOLERANCE = 1.5;
/** Beyond this age, even a worse reading is preferable to a stale one. */
const STALE_AFTER_MS = 60_000;

export function useLocation(): UseLocation {
  const [point, setPoint] = useState<LatLng | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const bestRef = useRef<{ accuracy: number; at: number } | null>(null);
  const watchRef = useRef<number | null>(null);

  const accept = useCallback((position: GeolocationPosition) => {
    const accuracy = position.coords.accuracy;
    const best = bestRef.current;
    const stale = best ? Date.now() - best.at > STALE_AFTER_MS : true;

    // Keep the better fix unless the one we hold has gone stale.
    if (best && !stale && accuracy > best.accuracy * ACCURACY_TOLERANCE) return;

    bestRef.current = { accuracy, at: Date.now() };
    setPoint({ lat: position.coords.latitude, lng: position.coords.longitude });
    setAccuracyM(Math.round(accuracy));
    setStatus("granted");
    setError(null);
  }, []);

  const fail = useCallback((positionError: GeolocationPositionError) => {
    if (positionError.code === positionError.PERMISSION_DENIED) {
      setStatus("denied");
      setError(
        "Location permission was denied. You can still search by name, but I cannot tell you what is around you.",
      );
      return;
    }

    // Timeout and unavailable are transient — the watch may still succeed, so
    // this must not latch into a permanent failure state.
    setError(
      positionError.code === positionError.TIMEOUT
        ? "Still trying to get a location fix — this can take a moment indoors."
        : "Could not get a location fix right now.",
    );
  }, []);

  const startWatch = useCallback(() => {
    if (watchRef.current !== null) return;

    setStatus((current) => (current === "granted" ? current : "locating"));

    watchRef.current = navigator.geolocation.watchPosition(accept, fail, {
      enableHighAccuracy: true,
      timeout: 20_000,
      // Accept a recent cached fix immediately, then let the watch refine it.
      maximumAge: 15_000,
    });
  }, [accept, fail]);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unavailable");
      setError("This browser cannot report your location.");
      return;
    }

    setStatus((current) => (current === "granted" ? current : "prompting"));

    // One immediate read so there is a position within a second or two, then
    // the watch takes over and improves it.
    navigator.geolocation.getCurrentPosition(accept, fail, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 30_000,
    });

    startWatch();
  }, [accept, fail, startWatch]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unavailable");
      return;
    }

    let cancelled = false;

    /*
     * Ask on load when permission already exists.
     *
     * Without this the app waited for a button tap that most users never make,
     * so the assistant reported "no location shared" on a device that had
     * granted permission long ago.
     */
    const boot = async () => {
      try {
        const permission = await navigator.permissions?.query({
          name: "geolocation" as PermissionName,
        });

        if (cancelled) return;

        if (permission?.state === "granted") {
          request();
        } else if (permission?.state === "denied") {
          setStatus("denied");
        } else {
          // "prompt" — surface a button rather than firing a permission dialog
          // at someone who has not yet been told why it is needed.
          setStatus("idle");
        }

        if (permission) {
          permission.onchange = () => {
            if (permission.state === "granted") request();
            else if (permission.state === "denied") setStatus("denied");
          };
        }
      } catch {
        // Safari and some embedded webviews do not implement Permissions for
        // geolocation. Asking directly is the only way to find out there.
        if (!cancelled) request();
      }
    };

    void boot();

    return () => {
      cancelled = true;
      if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
      }
    };
    // `request` is stable via useCallback; re-running would restart the watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { point, accuracyM, status, error, request };
}
