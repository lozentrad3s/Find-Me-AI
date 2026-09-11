/**
 * Movement: which way you are pointing, and how you are travelling.
 *
 * Google Maps' blue arrow does two things that a static dot does not — it
 * shows heading, so you can tell whether you are walking the right way, and it
 * follows you, so the map moves instead of you dragging it. Both are the
 * difference between "a map with me on it" and "navigation".
 *
 * Two sources, best first:
 *
 * - The GPS's own speed and course. Phones compute these from the Doppler
 *   shift of the satellite signal, which is far steadier than differencing
 *   positions — it reads walking pace correctly even when successive fixes
 *   wobble by more than a stride.
 * - Consecutive fixes, when the device does not report speed (many desktop
 *   browsers and some Android builds). Standing still, a bearing between two
 *   positions is noise, which is why it is only reported above a speed floor.
 */

import type { LatLng } from "@/lib/geo/distance";
import { bearingDegrees, distanceMetres } from "@/lib/geo/distance";

export type TravelMode = "foot" | "bike" | "car" | "still";

export interface MovementState {
  /** Degrees clockwise from north, or null when stationary. */
  heading: number | null;
  /** Metres per second, smoothed. */
  speedMps: number;
  /** Inferred travel mode. */
  mode: TravelMode;
  /** True when the inference is from too little data to rely on. */
  uncertain: boolean;
}

/** What the device itself reported with a fix. */
export interface DeviceMotion {
  speedMps: number | null;
  heading: number | null;
}

interface Sample {
  point: LatLng;
  at: number;
  accuracyM: number;
}

/**
 * Below this, GPS jitter dominates and any "heading" is noise — a stationary
 * phone will happily report a bearing that spins.
 */
const MOVING_SPEED_MPS = 0.6;

/** Speed bands, metres per second. 1 m/s ~ 3.6 km/h. */
const WALK_MAX_MPS = 2.2; // ~8 km/h
const BIKE_MAX_MPS = 7.0; // ~25 km/h

/** How many fixes to smooth over. */
const WINDOW = 5;

/** Device speed older than this is a reading from before the user stopped. */
const DEVICE_SPEED_MAX_AGE_MS = 8_000;

export class MovementTracker {
  private samples: Sample[] = [];

  /** Sticky mode, so a moment of traffic does not turn a car into a walker. */
  private lastMode: TravelMode = "still";
  private modeHeldSince = 0;

  /** Smoothed device speed, when the device reports one. */
  private deviceSpeed: number | null = null;
  private deviceSpeedAt = 0;
  private deviceHeading: number | null = null;

  /** Feed every position update. */
  push(point: LatLng, accuracyM: number, at = Date.now(), device?: DeviceMotion): MovementState {
    if (device && typeof device.speedMps === "number" && Number.isFinite(device.speedMps)) {
      // Light smoothing: responsive enough to show a stop within a couple of
      // fixes, steady enough that one odd reading does not flip the mode.
      this.deviceSpeed =
        this.deviceSpeed === null ? device.speedMps : this.deviceSpeed * 0.5 + device.speedMps * 0.5;
      this.deviceSpeedAt = at;
      this.deviceHeading = device.heading;
    }

    const previous = this.samples[this.samples.length - 1];

    /*
     * Reject fixes that cannot be real movement.
     *
     * A jump of 300m in one second is a positioning error, not a car, and
     * accepting it produces a wild heading and a nonsense speed. The check is
     * against the accuracy of the two fixes, since a ±2000m reading can move
     * hundreds of metres without anyone having moved at all.
     */
    let accepted = true;
    if (previous) {
      const metres = distanceMetres(previous.point, point);
      const seconds = Math.max(0.001, (at - previous.at) / 1000);
      const noiseFloor = Math.max(previous.accuracyM, accuracyM);

      if (metres < noiseFloor * 0.5) accepted = false;
      if (metres / seconds > 90) accepted = false;
    }

    if (accepted) {
      this.samples.push({ point, at, accuracyM });
      if (this.samples.length > WINDOW) this.samples.shift();
    }

    return this.state(at);
  }

  private state(now: number): MovementState {
    const deviceFresh =
      this.deviceSpeed !== null && now - this.deviceSpeedAt <= DEVICE_SPEED_MAX_AGE_MS;

    if (deviceFresh) {
      const speed = this.deviceSpeed!;
      const heading =
        speed >= MOVING_SPEED_MPS ? this.deviceHeading ?? this.windowBearing() : null;
      return { heading, speedMps: speed, mode: this.inferMode(speed), uncertain: false };
    }

    if (this.samples.length < 2) {
      return { heading: null, speedMps: 0, mode: this.inferMode(0), uncertain: true };
    }

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;

    const seconds = Math.max(0.001, (last.at - first.at) / 1000);
    const metres = distanceMetres(first.point, last.point);
    const speedMps = metres / seconds;

    // Stale samples mean the person stopped; do not keep reporting the last
    // speed forever.
    const age = (Date.now() - last.at) / 1000;
    if (age > 15) {
      return { heading: null, speedMps: 0, mode: this.inferMode(0), uncertain: false };
    }

    const heading = speedMps >= MOVING_SPEED_MPS ? bearingDegrees(first.point, last.point) : null;

    return {
      heading,
      speedMps,
      mode: this.inferMode(speedMps),
      uncertain: this.samples.length < 3,
    };
  }

  private windowBearing(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    return distanceMetres(first.point, last.point) > 3 ? bearingDegrees(first.point, last.point) : null;
  }

  /**
   * Speed to travel mode, with hysteresis.
   *
   * A car stopped at a junction reads as walking speed for thirty seconds, and
   * flipping the icon to a pedestrian every time traffic stops would be worse
   * than showing nothing. So a mode has to hold for a few seconds before it
   * replaces the previous one.
   */
  private inferMode(speedMps: number): TravelMode {
    const raw: TravelMode =
      speedMps < MOVING_SPEED_MPS
        ? "still"
        : speedMps <= WALK_MAX_MPS
          ? "foot"
          : speedMps <= BIKE_MAX_MPS
            ? "bike"
            : "car";

    const now = Date.now();

    if (raw === this.lastMode) {
      this.modeHeldSince = now;
      return this.lastMode;
    }

    // "still" is allowed to appear quickly when slowing; speeding up has to
    // be sustained.
    const settleMs = raw === "still" ? 4000 : 6000;

    if (now - this.modeHeldSince >= settleMs) {
      this.lastMode = raw;
      this.modeHeldSince = now;
    }

    return this.lastMode;
  }

  reset(): void {
    this.samples = [];
    this.lastMode = "still";
    this.modeHeldSince = 0;
    this.deviceSpeed = null;
    this.deviceHeading = null;
  }
}

/** What to show for a mode. Kept here so the map and the AI agree. */
export const MODE_LABEL: Record<TravelMode, string> = {
  foot: "walking",
  bike: "cycling",
  car: "driving",
  still: "stationary",
};
