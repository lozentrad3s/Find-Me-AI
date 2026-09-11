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
 *    position can be fetched immediately on load with no prompt at all.
 * 2. Watch rather than poll. `watchPosition` delivers updates as the fix
 *    improves and as the user moves.
 * 3. Reject only fixes that are clearly worse, not every fix that is slightly
 *    less accurate. An earlier version kept "the best fix", which is right for
 *    a stationary pin and wrong for a moving one: walking along a street, each
 *    new reading was a few metres less precise than the last good one and was
 *    thrown away, so the icon sat still and then jumped. Now a coarse network
 *    fix cannot overwrite a GPS lock, and a physically impossible jump is
 *    discarded — everything else is accepted, so the marker moves as you do.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";

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
  /** Direction of travel from the GPS, degrees from north; null when unknown or still. */
  heading: number | null;
  /** Speed from the GPS in m/s; null when the device does not report it. */
  speedMps: number | null;
  /** When the last accepted fix was taken. */
  fixAt: number | null;
}

/** A GPS lock is this good or better. */
const LOCK_ACCURACY_M = 60;
/** A reading this coarse is a network estimate, not GPS. */
const COARSE_ACCURACY_M = 150;
/** Beyond this age, even a coarse reading is preferable to a stale lock. */
const STALE_AFTER_MS = 60_000;
/** Faster than this, beyond the fixes' own error, is a glitch, not a car. */
const MAX_PLAUSIBLE_MPS = 75;
/** GPS heading is noise below walking pace. */
const HEADING_MIN_SPEED_MPS = 0.8;

export function useLocation(): UseLocation {
  const [point, setPoint] = useState<LatLng | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [speedMps, setSpeedMps] = useState<number | null>(null);
  const [fixAt, setFixAt] = useState<number | null>(null);

  const lastRef = useRef<{ point: LatLng; accuracy: number; at: number } | null>(null);
  const watchRef = useRef<number | null>(null);

  const accept = useCallback((position: GeolocationPosition) => {
    const { accuracy, latitude, longitude } = position.coords;
    const at = position.timestamp || Date.now();
    const next = { lat: latitude, lng: longitude };
    const last = lastRef.current;

    if (last) {
      const fresh = at - last.at < STALE_AFTER_MS;

      // A network estimate arriving after a GPS lock would drag the pin
      // hundreds of metres for no reason.
      if (fresh && accuracy > COARSE_ACCURACY_M && last.accuracy <= LOCK_ACCURACY_M) return;

      const seconds = Math.max(0.5, (at - last.at) / 1000);
      const moved = distanceMetres(last.point, next) - accuracy - last.accuracy;
      if (moved / seconds > MAX_PLAUSIBLE_MPS) return;
    }

    lastRef.current = { point: next, accuracy, at };

    const speed = position.coords.speed;
    const course = position.coords.heading;
    const validSpeed = typeof speed === "number" && Number.isFinite(speed) && speed >= 0 ? speed : null;
    const validHeading =
      typeof course === "number" &&
      Number.isFinite(course) &&
      (validSpeed ?? 0) >= HEADING_MIN_SPEED_MPS
        ? course
        : null;

    setPoint(next);
    setAccuracyM(Math.round(accuracy));
    setSpeedMps(validSpeed);
    setHeading(validHeading);
    setFixAt(at);
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
      // Live movement needs live fixes; a cached one is a position from the past.
      maximumAge: 2_000,
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
    // the watch takes over and keeps it moving.
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

  return { point, accuracyM, status, error, request, heading, speedMps, fixAt };
}
