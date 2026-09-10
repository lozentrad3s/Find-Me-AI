"use client";

/**
 * Full-screen voice assistant — screen 4 of the design reference.
 *
 * The point of this screen, versus just talking into the chat panel, is the
 * conversation loop: speak, get an answer read back, and be listening again
 * without touching anything. That hands-free round trip is what makes it usable
 * while driving, which is when someone actually asks whether a route is busy.
 *
 * One state machine drives everything:
 *
 *   idle -> listening -> thinking -> speaking -> listening -> ...
 *
 * with the microphone hard-muted during `speaking`. Without that the recogniser
 * hears the synthesised reply, transcribes it, and the assistant starts
 * answering itself — the classic open-mic feedback loop.
 */

import { useEffect, useRef } from "react";
import { Mic, Navigation, Route, Search, Compass, MapPin, X } from "lucide-react";

import styles from "./VoiceOverlay.module.css";
import type { TraceItem } from "./Assistant";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceOverlayProps {
  open: boolean;
  state: VoiceState;
  supported: boolean;
  /** Live transcript while the user speaks. */
  transcript: string;
  /** The last thing the user said, once finalised. */
  lastQuestion: string | null;
  /** The assistant's reply, as it streams. */
  reply: string;
  trace: TraceItem[];
  error: string | null;
  onClose: () => void;
  onToggleListening: () => void;
  onAsk: (text: string) => void;
}

const SUGGESTIONS = [
  "Where am I?",
  "Is there traffic on my route?",
  "Find me a filling station",
  "Take me to Bluewiz",
];

const TOOL_LABEL: Record<string, { label: string; Icon: typeof MapPin }> = {
  resolve_place: { label: "Finding the place", Icon: MapPin },
  search_nearby: { label: "Looking around", Icon: Search },
  where_am_i: { label: "Locating you", Icon: Compass },
  calculate_route: { label: "Working out the route", Icon: Route },
  check_route_conditions: { label: "Checking the route", Icon: Route },
  scan_surroundings: { label: "Scanning your surroundings", Icon: Compass },
  get_weather: { label: "Checking the weather", Icon: Search },
  check_journey_weather: { label: "Checking weather ahead", Icon: Route },
};

const STATUS: Record<VoiceState, { title: string; sub: string }> = {
  idle: {
    title: "Tap to speak",
    sub: "Ask about a place, a route, or what is around you.",
  },
  listening: {
    title: "I'm listening…",
    sub: "How can I help you today?",
  },
  thinking: {
    title: "One moment",
    sub: "Checking the map.",
  },
  speaking: {
    title: "Find Me",
    sub: "Tap the orb to interrupt and speak again.",
  },
};

/** Bar heights, fixed so the waveform reads as a shape rather than noise. */
const BARS = [38, 62, 100, 74, 46];

export default function VoiceOverlay({
  open,
  state,
  supported,
  transcript,
  lastQuestion,
  reply,
  trace,
  error,
  onClose,
  onToggleListening,
  onAsk,
}: VoiceOverlayProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and the overlay takes focus so a keyboard user is not left
  // tabbing through the map underneath it.
  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const status = STATUS[state];
  const waveActive = state === "listening" || state === "speaking";

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Find Me voice assistant"
    >
      <div className={styles.topBar}>
        <span className={styles.brand}>
          <span className={styles.brandDot} aria-hidden="true">
            <Navigation size={14} strokeWidth={2.5} color="#fff" />
          </span>
          Find Me
        </span>

        <button
          ref={closeRef}
          type="button"
          className={styles.close}
          onClick={onClose}
          title="Close voice assistant"
        >
          <X size={20} />
          <span className="sr-only">Close voice assistant</span>
        </button>
      </div>

      <div className={styles.stage}>
        <div className={styles.status}>
          {/* aria-live so a screen reader announces state changes that are
              otherwise conveyed only by the animating orb. */}
          <h2 className={styles.statusTitle} aria-live="polite">
            {status.title}
          </h2>
          <p className={styles.statusSub}>{status.sub}</p>
        </div>

        <div className={styles.orbRow}>
          <Waveform side="left" active={waveActive} />

          <span className={styles.orbWrap} data-state={state}>
            <button
              type="button"
              className={styles.orb}
              data-state={state}
              onClick={onToggleListening}
              disabled={!supported}
              title={
                state === "listening" ? "Stop listening" : "Start listening"
              }
            >
              <Mic size={34} strokeWidth={2} />
              <span className="sr-only">
                {state === "listening" ? "Stop listening" : "Start listening"}
              </span>
            </button>
          </span>

          <Waveform side="right" active={waveActive} />
        </div>

        <div className={styles.transcript} aria-live="polite">
          {transcript ? (
            <span className={styles.transcriptUser}>{transcript}</span>
          ) : reply ? (
            <span className={styles.transcriptReply}>{reply}</span>
          ) : lastQuestion ? (
            <span className={styles.transcriptUser}>{lastQuestion}</span>
          ) : (
            <span className={styles.placeholder}>
              {supported ? "Say something…" : "Voice input is unavailable"}
            </span>
          )}
        </div>

        <div className={styles.trace}>
          {trace.map((item, index) => {
            const meta = TOOL_LABEL[item.tool] ?? {
              label: item.tool,
              Icon: Search,
            };
            const Icon = meta.Icon;
            return (
              <span
                key={`${item.tool}-${index}`}
                className={styles.traceChip}
              >
                <Icon size={12} aria-hidden="true" />
                {meta.label}
              </span>
            );
          })}
        </div>

        {/* Suggestions only while idle — once talking, they are clutter. */}
        {state === "idle" && !lastQuestion && (
          <div className={styles.suggestions}>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={styles.suggestion}
                onClick={() => onAsk(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        {error && <p className={styles.unsupported}>{error}</p>}

        {!supported && (
          <p className={styles.unsupported}>
            Voice input needs Chrome or Edge — Safari and Firefox do not support
            the browser speech API. You can still type in the panel behind this.
          </p>
        )}

        <p className={styles.hint}>
          {state === "listening" ? "Tap the orb to stop" : "Tap the orb to speak"}
        </p>
      </div>
    </div>
  );
}

function Waveform({ side, active }: { side: "left" | "right"; active: boolean }) {
  const bars = side === "left" ? [...BARS].reverse() : BARS;

  return (
    <span className={styles.wave} data-side={side} data-active={active} aria-hidden="true">
      {bars.map((height, index) => (
        <span
          key={index}
          style={{
            height: `${height}%`,
            animationDelay: `${index * 0.11}s`,
          }}
        />
      ))}
    </span>
  );
}
