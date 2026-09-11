"use client";

/**
 * Everything that floats over the map: category chips, the travel-mode
 * buttons, the traffic legend, the navigation banner, and the "are you in a
 * car now?" prompt.
 *
 * All of it is a shortcut to something the assistant can also do, and all of
 * it works without the assistant — tapping "Hospitals" pins hospitals straight
 * from the search API, with no model call to wait for or quota to spend.
 */

import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Banknote,
  BedDouble,
  Bike,
  Bus,
  Car,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Footprints,
  Fuel,
  Hospital,
  Pill,
  RotateCw,
  Shield,
  Sparkles,
  Undo2,
  UtensilsCrossed,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import type { TravelMode } from "@/lib/location/movement";
import { TRAFFIC_COLOUR } from "@/lib/traffic/colours";
import styles from "./MapOverlays.module.css";

// ---------------------------------------------------------------------------
// Category chips
// ---------------------------------------------------------------------------

export const MAP_CATEGORIES = [
  { query: "restaurant", label: "Restaurants", Icon: UtensilsCrossed },
  { query: "fuel", label: "Fuel", Icon: Fuel },
  { query: "hospital", label: "Hospitals", Icon: Hospital },
  { query: "pharmacy", label: "Pharmacies", Icon: Pill },
  { query: "atm", label: "ATMs", Icon: Banknote },
  { query: "bus station", label: "Bus parks", Icon: Bus },
  { query: "hotel", label: "Hotels", Icon: BedDouble },
  { query: "police station", label: "Police", Icon: Shield },
] as const;

export function CategoryChips({
  active,
  onSelect,
}: {
  active: string | null;
  onSelect: (query: string, label: string) => void;
}) {
  return (
    <div className={styles.chips} role="toolbar" aria-label="Find nearby">
      {MAP_CATEGORIES.map(({ query, label, Icon }) => (
        <button
          key={query}
          type="button"
          className={styles.chip}
          data-active={active === query}
          aria-pressed={active === query}
          onClick={() => onSelect(query, label)}
        >
          <Icon size={15} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Travel mode
// ---------------------------------------------------------------------------

export type ModeChoice = "auto" | "foot" | "bike" | "car";

const MODES: Array<{ id: ModeChoice; label: string; Icon: typeof Car }> = [
  { id: "auto", label: "Auto — detect from speed", Icon: Sparkles },
  { id: "foot", label: "On foot", Icon: Footprints },
  { id: "bike", label: "On a bike", Icon: Bike },
  { id: "car", label: "In a car", Icon: Car },
];

/**
 * Speed alone cannot tell a slow car in traffic from a cyclist, or a bus
 * passenger from a driver. So the mode is detected, and the user can simply
 * say — which the map and the assistant then both trust over the guess.
 */
export function ModeSwitcher({
  choice,
  detected,
  onChange,
}: {
  choice: ModeChoice;
  detected: TravelMode;
  onChange: (choice: ModeChoice) => void;
}) {
  return (
    <div className={styles.modes} role="radiogroup" aria-label="How are you travelling?">
      {MODES.map(({ id, label, Icon }) => {
        const selected = choice === id;
        const live = choice === "auto" && id !== "auto" && detected === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={styles.mode}
            data-selected={selected}
            data-live={live}
            title={live ? `${label} (detected)` : label}
            onClick={() => onChange(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ModeSuggestion({
  mode,
  onAccept,
  onDismiss,
}: {
  mode: TravelMode;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const words = mode === "car" ? "in a car" : mode === "bike" ? "on a bike" : "on foot";
  return (
    <div className={styles.suggestion} role="status">
      <span>You seem to be moving {words}. Switch mode?</span>
      <button type="button" className={styles.suggestionYes} onClick={onAccept}>
        Switch
      </button>
      <button type="button" className={styles.suggestionNo} onClick={onDismiss} title="Dismiss">
        <X size={15} aria-hidden="true" />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic legend
// ---------------------------------------------------------------------------

export function TrafficLegend({
  available,
  onClose,
}: {
  available: boolean | null;
  onClose: () => void;
}) {
  return (
    <div className={styles.legend} role="note" aria-label="Traffic legend">
      <div className={styles.legendHead}>
        <span>Traffic</span>
        <button type="button" onClick={onClose} className={styles.legendClose} title="Hide traffic">
          <X size={14} aria-hidden="true" />
          <span className="sr-only">Hide traffic</span>
        </button>
      </div>
      {available === false ? (
        <p className={styles.legendNote}>
          Live traffic isn&rsquo;t connected yet, so roads are not coloured.
        </p>
      ) : (
        <ul className={styles.legendList}>
          <li>
            <span className={styles.swatch} style={{ background: TRAFFIC_COLOUR.heavy }} />
            Heavy
          </li>
          <li>
            <span className={styles.swatch} style={{ background: TRAFFIC_COLOUR.moderate }} />
            Medium
          </li>
          <li>
            <span className={styles.swatch} style={{ background: TRAFFIC_COLOUR.free }} />
            Light
          </li>
          <li>
            <span className={styles.swatch} data-empty="true" />
            No colour: no data
          </li>
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation banner
// ---------------------------------------------------------------------------

function ManeuverIcon({ type, modifier }: { type?: string; modifier?: string }) {
  const size = 30;
  if (type === "arrive") return <Flag size={size} aria-hidden="true" />;
  if (type === "roundabout" || type === "rotary") return <RotateCw size={size} aria-hidden="true" />;
  switch (modifier) {
    case "left":
    case "sharp left":
      return <CornerUpLeft size={size} aria-hidden="true" />;
    case "slight left":
      return <ArrowUpLeft size={size} aria-hidden="true" />;
    case "right":
    case "sharp right":
      return <CornerUpRight size={size} aria-hidden="true" />;
    case "slight right":
      return <ArrowUpRight size={size} aria-hidden="true" />;
    case "uturn":
      return <Undo2 size={size} aria-hidden="true" />;
    default:
      return <ArrowUp size={size} aria-hidden="true" />;
  }
}

export interface NavBannerProps {
  destination: string;
  instruction: string;
  maneuver: { type?: string; modifier?: string };
  /** Distance to the next manoeuvre, or null before the first fix. */
  distanceText: string | null;
  remainingText: string;
  etaText: string;
  arrived: boolean;
  offRoute: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
}

export function NavBanner({
  destination,
  instruction,
  maneuver,
  distanceText,
  remainingText,
  etaText,
  arrived,
  offRoute,
  muted,
  onToggleMute,
  onEnd,
}: NavBannerProps) {
  return (
    <div className={styles.nav} role="region" aria-label={`Navigating to ${destination}`}>
      <div className={styles.navStep} aria-live="polite">
        <span className={styles.navIcon}>
          {arrived ? <Flag size={30} aria-hidden="true" /> : <ManeuverIcon {...maneuver} />}
        </span>
        <span className={styles.navText}>
          {arrived ? (
            <strong>You&rsquo;ve arrived at {destination}</strong>
          ) : offRoute ? (
            <strong>Rerouting…</strong>
          ) : (
            <>
              {distanceText && <span className={styles.navDistance}>{distanceText}</span>}
              <strong>{instruction}</strong>
            </>
          )}
        </span>
      </div>

      <div className={styles.navFooter}>
        <span className={styles.navRemaining}>
          {arrived ? destination : `${remainingText} · arrive ${etaText}`}
        </span>
        <button
          type="button"
          className={styles.navButton}
          onClick={onToggleMute}
          title={muted ? "Turn voice guidance on" : "Mute voice guidance"}
          aria-pressed={!muted}
        >
          {muted ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
          <span className="sr-only">{muted ? "Unmute" : "Mute"}</span>
        </button>
        <button type="button" className={styles.navEnd} onClick={onEnd}>
          {arrived ? "Done" : "End"}
        </button>
      </div>
    </div>
  );
}
