"use client";

/**
 * The SOS beacon — the client half of "our system pays close attention to
 * their location".
 *
 * Once an alert is open this keeps a `watchPosition` subscription running and
 * posts each fix to the server, so the tracking link stays live and the trail
 * grows. It runs until the person stands down, the alert expires, or the tab
 * closes.
 *
 * FOUR THINGS THAT MATTER MORE HERE THAN ELSEWHERE
 *
 * 1. A failed ping is not a failed alert. Coverage in an emergency is exactly
 *    where it is worst. Failures are counted and surfaced, never thrown, and
 *    the next fix simply tries again.
 *
 * 2. It keeps transmitting when the screen is off, as far as the browser will
 *    allow. `watchPosition` is throttled hard in a backgrounded tab and there
 *    is no way around that from a web page — so the UI says so rather than
 *    letting someone believe a pocketed phone is still reporting. A native
 *    app is the honest fix and it is a real limitation of shipping this on
 *    the web.
 *
 * 3. It survives a reload. The alert id and token go in sessionStorage, so
 *    refreshing the page — or an accidental back gesture — does not silently
 *    end an emergency.
 *
 * 4. `sendBeacon` on unload. A closing tab cannot await a fetch, but it can
 *    queue a beacon, which gets one last position out of a phone that is
 *    about to be put away or taken.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AlertKind, DispatchChannel } from "./types";

const STORAGE_KEY = "findme.sos.active";

/**
 * How often to report position.
 *
 * Five seconds. A person on foot moves ~7m in that time and a car ~80m, which
 * is close enough for a responder to follow, and it is not so frequent that
 * the radio never sleeps — battery life is a safety property here, not a
 * nicety.
 */
const PING_INTERVAL_MS = 5_000;

export interface ActiveAlert {
  id: string;
  token: string;
  trackUrl: string;
  openedAt: number;
  durable: boolean;
  dispatch: DispatchChannel[];
  summary: string;
}

export interface SosBeaconState {
  alert: ActiveAlert | null;
  /** Position reports the server has accepted. */
  pingsSent: number;
  /** Consecutive failures — non-zero means the trail has a gap right now. */
  pingsFailed: number;
  /** True while the tab is backgrounded and updates are being throttled. */
  throttled: boolean;
  starting: boolean;
  error: string | null;
}

export interface OpenAlertRequest {
  kind: AlertKind;
  note: string;
  locationDescription: string | null;
}

export function useSosBeacon() {
  const [state, setState] = useState<SosBeaconState>({
    alert: null,
    pingsSent: 0,
    pingsFailed: 0,
    throttled: false,
    starting: false,
    error: null,
  });

  const watchRef = useRef<number | null>(null);
  const lastPingRef = useRef(0);
  const alertRef = useRef<ActiveAlert | null>(null);

  // --- Recover an alert across a reload ------------------------------------
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const saved = JSON.parse(raw) as ActiveAlert;
      if (!saved?.id || !saved?.token) return;

      alertRef.current = saved;
      setState((s) => ({ ...s, alert: saved }));
    } catch {
      // Corrupt entry. Not worth surfacing — the person can press SOS again.
    }
  }, []);

  // --- Stop transmitting ----------------------------------------------------
  const stopBeacon = useCallback(() => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    alertRef.current = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private mode */
    }
  }, []);

  // --- Post one fix ---------------------------------------------------------
  const ping = useCallback(async (position: GeolocationPosition) => {
    const alert = alertRef.current;
    if (!alert) return;

    const now = Date.now();
    if (now - lastPingRef.current < PING_INTERVAL_MS) return;
    lastPingRef.current = now;

    const { coords } = position;

    try {
      const response = await fetch(`/api/sos/${alert.id}/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fix: {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracyM: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
            heading: Number.isFinite(coords.heading ?? NaN) ? coords.heading : null,
            speedMps: Number.isFinite(coords.speed ?? NaN) ? coords.speed : null,
          },
        }),
        keepalive: true,
      });

      // 410 means the alert is over — server-side expiry, or stood down from
      // another device. Stop rather than transmitting into the void.
      if (response.status === 410) {
        stopBeacon();
        setState((s) => ({ ...s, alert: null }));
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      setState((s) => ({ ...s, pingsSent: s.pingsSent + 1, pingsFailed: 0 }));
    } catch {
      setState((s) => ({ ...s, pingsFailed: s.pingsFailed + 1 }));
    }
  }, [stopBeacon]);

  const startWatching = useCallback(() => {
    if (watchRef.current !== null) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    watchRef.current = navigator.geolocation.watchPosition(
      (position) => void ping(position),
      () => {
        // A geolocation error mid-alert is worth showing: the trail has
        // stopped growing and the person watching the link needs to know.
        setState((s) => ({ ...s, pingsFailed: s.pingsFailed + 1 }));
      },
      {
        enableHighAccuracy: true,
        // No cached fixes on an emergency. A 30-second-old position can be a
        // street away.
        maximumAge: 0,
        timeout: 20_000,
      },
    );
  }, [ping]);

  // Resume watching whenever an alert is present — including one recovered
  // from sessionStorage after a reload.
  useEffect(() => {
    if (state.alert) startWatching();
    return () => {
      if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
      }
    };
  }, [state.alert, startWatching]);

  // --- Background throttling ------------------------------------------------
  useEffect(() => {
    const onVisibility = () =>
      setState((s) => ({ ...s, throttled: document.visibilityState === "hidden" }));

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // --- One last position on the way out ------------------------------------
  useEffect(() => {
    const onUnload = () => {
      const alert = alertRef.current;
      if (!alert || !navigator.sendBeacon) return;

      navigator.geolocation?.getCurrentPosition(
        (position) => {
          navigator.sendBeacon(
            `/api/sos/${alert.id}/ping`,
            new Blob(
              [
                JSON.stringify({
                  fix: {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    accuracyM: position.coords.accuracy ?? null,
                  },
                }),
              ],
              { type: "application/json" },
            ),
          );
        },
        () => undefined,
        { maximumAge: 10_000, timeout: 1_000 },
      );
    };

    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, []);

  // --- Open ----------------------------------------------------------------
  const open = useCallback(
    async (request: OpenAlertRequest): Promise<ActiveAlert | null> => {
      setState((s) => ({ ...s, starting: true, error: null }));

      /*
       * Grab a position first, but never block on it.
       *
       * A GPS fix in a building can take fifteen seconds and an alert that
       * waits for one is an alert that has not been raised. Six seconds, then
       * open regardless — the beacon fills the position in moments later.
       */
      const fix = await currentFix(6_000);

      try {
        const response = await fetch("/api/sos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: request.kind,
            note: request.note,
            locationDescription: request.locationDescription,
            fix,
          }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const alert = (await response.json()) as ActiveAlert;

        alertRef.current = alert;
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(alert));
        } catch {
          /* private mode: the alert still works, it just will not survive a reload */
        }

        setState((s) => ({ ...s, alert, starting: false, error: null }));
        return alert;
      } catch (error) {
        setState((s) => ({
          ...s,
          starting: false,
          error:
            error instanceof Error
              ? `The alert could not be sent (${error.message}). Call 112 directly.`
              : "The alert could not be sent. Call 112 directly.",
        }));
        return null;
      }
    },
    [],
  );

  // --- Stand down -----------------------------------------------------------
  const resolve = useCallback(async () => {
    const alert = alertRef.current;
    if (!alert) return;

    // Stop transmitting first. Even if the resolve call fails, the person has
    // pressed the button and should not keep broadcasting their position.
    stopBeacon();
    setState((s) => ({ ...s, alert: null, pingsSent: 0, pingsFailed: 0 }));

    await fetch(`/api/sos/${alert.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: alert.token }),
    }).catch(() => undefined);
  }, [stopBeacon]);

  return { ...state, open, resolve };
}

/** One position, with a hard deadline. Resolves null rather than rejecting. */
function currentFix(timeoutMs: number): Promise<{
  lat: number;
  lng: number;
  accuracyM: number | null;
  heading: number | null;
  speedMps: number | null;
} | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      value: Awaited<ReturnType<typeof currentFix>>,
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        const { coords } = position;
        finish({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracyM: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
          heading: Number.isFinite(coords.heading ?? NaN) ? coords.heading : null,
          speedMps: Number.isFinite(coords.speed ?? NaN) ? coords.speed : null,
        });
      },
      () => {
        clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export type SosBeacon = ReturnType<typeof useSosBeacon>;
