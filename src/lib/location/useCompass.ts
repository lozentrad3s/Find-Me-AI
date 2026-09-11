"use client";

/**
 * Which way the phone is facing — for when you are standing still.
 *
 * GPS only knows your direction while you move. Standing on a corner deciding
 * which way to walk, the useful arrow is the one that turns as you turn the
 * phone, and that needs the compass.
 *
 * Android Chrome exposes an absolute orientation event with no prompt. iOS
 * Safari needs an explicit permission request from a tap, so on iOS this
 * reports `needsPermission` and the app asks when the user touches the mode
 * buttons or the location button.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface CompassEvent extends DeviceOrientationEvent {
  /** iOS: degrees from magnetic north, already corrected for the device. */
  webkitCompassHeading?: number;
}

interface OrientationPermission {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
}

export interface UseCompass {
  /** Degrees clockwise from north, or null when unavailable. */
  heading: number | null;
  /** iOS: a tap must call `request` before any reading arrives. */
  needsPermission: boolean;
  request: () => void;
}

/** Changes smaller than this are hand tremor, not a turn. */
const MIN_CHANGE_DEG = 3;
/** Readings arrive at 60Hz; the marker does not need more than ~8 a second. */
const MIN_INTERVAL_MS = 120;

export function useCompass(): UseCompass {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);

  const lastRef = useRef<{ value: number; at: number } | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const onReading = useCallback((raw: number | null | undefined) => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return;

    const screenAngle =
      typeof screen !== "undefined" && screen.orientation ? screen.orientation.angle : 0;
    const value = (((raw + screenAngle) % 360) + 360) % 360;

    const now = performance.now();
    const last = lastRef.current;
    if (last) {
      const delta = Math.abs(((value - last.value + 540) % 360) - 180);
      if (delta < MIN_CHANGE_DEG || now - last.at < MIN_INTERVAL_MS) return;
    }

    lastRef.current = { value, at: now };
    setHeading(Math.round(value));
  }, []);

  const attach = useCallback(() => {
    if (detachRef.current || typeof window === "undefined") return;

    // Checked on a widened reference: the DOM typings declare this event, so
    // an `in` check on `window` itself would narrow the fallback to `never`.
    const supportsAbsolute = "ondeviceorientationabsolute" in (window as object);

    if (supportsAbsolute) {
      const handler = (event: Event) => {
        const alpha = (event as DeviceOrientationEvent).alpha;
        if (alpha !== null) onReading(360 - alpha);
      };
      window.addEventListener("deviceorientationabsolute", handler);
      detachRef.current = () => window.removeEventListener("deviceorientationabsolute", handler);
      return;
    }

    const handler = (event: DeviceOrientationEvent) => {
      const compass = (event as CompassEvent).webkitCompassHeading;
      if (typeof compass === "number") onReading(compass);
      else if (event.absolute && event.alpha !== null) onReading(360 - event.alpha);
    };
    window.addEventListener("deviceorientation", handler);
    detachRef.current = () => window.removeEventListener("deviceorientation", handler);
  }, [onReading]);

  useEffect(() => {
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;

    const permission = window.DeviceOrientationEvent as unknown as OrientationPermission;
    if (typeof permission.requestPermission === "function") {
      setNeedsPermission(true);
    } else {
      attach();
    }

    return () => {
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [attach]);

  const request = useCallback(() => {
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;

    const permission = window.DeviceOrientationEvent as unknown as OrientationPermission;
    if (typeof permission.requestPermission !== "function") {
      attach();
      return;
    }

    permission
      .requestPermission()
      .then((state) => {
        if (state === "granted") {
          setNeedsPermission(false);
          attach();
        }
      })
      .catch(() => undefined);
  }, [attach]);

  return { heading, needsPermission, request };
}
