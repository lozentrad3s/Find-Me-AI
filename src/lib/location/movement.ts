/**
 * Movement: which way you are pointing, and how you are travelling.
 *
 * Google Maps' blue arrow does two things that a static dot does not — it
 * shows heading, so you can tell whether you are walking the right way, and it
 * follows you, so the map moves instead of you dragging it. Both are the
 * difference between "a map with me on it" and "navigation".
 *
 * Heading is derived from consecutive fixes rather than taken from the device
 * compass. `deviceorientation` needs an explicit permission prompt on iOS and
 * is unreliable indoors and near vehicles; a bearing between two positions is
 * always available and is what you actually want while moving. Standing still
 * it is meaningless, which is why it is only reported above a speed floor.
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

export class MovementTracker {
  private samples: Sample[] = [];

  /** Sticky mode, so a moment of traffic does not turn a car into a walker. */
  private lastMode: TravelMode = "still";
  private modeHeldSince = 0;

  /** Feed every position update. */
  push(point: LatLng, accuracyM: number, at = Date.now()): MovementState {
    const previous = this.samples[this.samples.length - 1];

    /*
     * Reject fixes that cannot be real movement.
     *
     * A jump of 300m in one second is a positioning error, not a car, and
     * accepting it produces a wild heading and a nonsense speed. The check is
     * against the accuracy of the two fixes, since a ±2000m reading can move
     * hundreds of metres without anyone having moved at all.
     */
    if (previous) {
      const metres = distanceMetres(previous.point, point);
      const seconds = Math.max(0.001, (at - previous.at) / 1000);
      const noiseFloor = Math.max(previous.accuracyM, accuracyM);

      if (metres < noiseFloor * 0.5) {
        // Within the error of the fix — treat as stationary, not as motion.
        return this.state();
      }
      if (metres / seconds > 90) {
        // Over 320 km/h. Discard rather than model.
        return this.state();
      }
    }

    this.samples.push({ point, at, accuracyM });
    if (this.samples.length > WINDOW) this.samples.shift();

    return this.state();
  }

  /** Called when a fix arrives but nothing moved, to decay toward "still". */
  private state(): MovementState {
    if (this.samples.length < 2) {
      return { heading: null, speedMps: 0, mode: "still", uncertain: true };
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
      return { heading: null, speedMps: 0, mode: "still", uncertain: false };
    }

    const heading =
      speedMps >= MOVING_SPEED_MPS
        ? bearingDegrees(first.point, last.point)
        : null;

    const mode = this.inferMode(speedMps);

    return {
      heading,
      speedMps,
      mode,
      uncertain: this.samples.length < 3,
    };
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
      this.modeHeldSince = this.modeHeldSince || now;
      return this.lastMode;
    }

    // "still" is allowed to appear immediately when slowing; speeding up has
    // to be sustained.
    const settleMs = raw === "still" ? 4000 : 6000;

    if (!this.modeHeldSince) this.modeHeldSince = now;

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
  }
}

/** What to show for a mode. Kept here so the map and the AI agree. */
export const MODE_LABEL: Record<TravelMode, string> = {
  foot: "walking",
  bike: "cycling",
  car: "driving",
  still: "stationary",
};
