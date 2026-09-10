"use client";

/**
 * The assistant panel: conversation, voice, and the tool trace.
 *
 * The trace is shown on purpose rather than hidden behind a spinner. Part IV
 * insists the model never invents a location, and letting the user watch which
 * tool ran is what makes that claim checkable instead of a promise. It also
 * turns the genuine wait — Nominatim allows about one call per second — into
 * visible progress.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowUp,
  ChevronDown,
  Compass,
  MapPin,
  Mic,
  Navigation,
  Route,
  Search,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import styles from "./Assistant.module.css";

export interface TraceItem {
  tool: string;
  band?: "high" | "moderate" | "low";
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  trace?: TraceItem[];
}

export interface AssistantProps {
  turns: ChatTurn[];
  busy: boolean;
  /** Live trace for the turn currently being generated. */
  liveTrace: TraceItem[];
  notice: string | null;
  voice: {
    supported: boolean;
    listening: boolean;
    transcript: string;
    speaking: boolean;
    toggle: () => void;
    stopSpeaking: () => void;
  };
  speakReplies: boolean;
  onToggleSpeakReplies: () => void;
  onSend: (text: string) => void;
  locationLabel: string;
  usage?: UsageReadout | null;
  /** Opens the full-screen voice assistant. */
  onOpenVoice: () => void;
  /** Returns to the panel behind the conversation. */
  onClose?: () => void;
  /** True when rendered inside the bottom sheet, which owns the chrome. */
  embedded?: boolean;
}

export interface UsageReadout {
  model: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

const SUGGESTIONS = [
  "Where am I?",
  "Find a filling station near me",
  "Take me to the guest house behind the mosque on Buhari Street, Wuse",
  "Any pharmacy around here?",
];

const TOOL_LABEL: Record<string, { label: string; Icon: typeof MapPin }> = {
  resolve_place: { label: "Resolving place", Icon: MapPin },
  search_nearby: { label: "Searching nearby", Icon: Search },
  where_am_i: { label: "Locating you", Icon: Compass },
  calculate_route: { label: "Working out the route", Icon: Route },
  check_route_conditions: { label: "Checking the route", Icon: Route },
};

const BAND_LABEL = {
  high: "Confident",
  moderate: "Needs confirming",
  low: "Not enough detail",
} as const;

export default function Assistant({
  turns,
  busy,
  liveTrace,
  notice,
  voice,
  speakReplies,
  onToggleSpeakReplies,
  onSend,
  locationLabel,
  usage,
  onOpenVoice,
  onClose,
  embedded = false,
}: AssistantProps) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows, including mid-stream.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [turns, liveTrace, busy]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a newline. Standard for a chat composer.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section
      className={embedded ? styles.embedded : styles.panel}
      data-collapsed={collapsed}
      aria-label="Find Me assistant"
    >
      <header className={styles.header}>
        <span className={styles.brandMark} aria-hidden="true">
          <Navigation size={17} strokeWidth={2.4} />
        </span>

        <span className={styles.brandText}>
          <span className={styles.brandName}>Find Me</span>
          <span className={styles.brandSub}>{locationLabel}</span>
        </span>

        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            data-active={speakReplies}
            onClick={onToggleSpeakReplies}
            aria-pressed={speakReplies}
            title={speakReplies ? "Turn off spoken replies" : "Speak replies aloud"}
          >
            {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
            <span className="sr-only">
              {speakReplies ? "Turn off spoken replies" : "Speak replies aloud"}
            </span>
          </button>

          {embedded && onClose ? (
            <button
              type="button"
              className={styles.iconButton}
              onClick={onClose}
              title="Close conversation"
            >
              <X size={18} />
              <span className="sr-only">Close conversation</span>
            </button>
          ) : (
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setCollapsed((value) => !value)}
              aria-expanded={!collapsed}
              title={collapsed ? "Show conversation" : "Hide conversation"}
            >
              <ChevronDown
                size={18}
                style={{
                  transform: collapsed ? "rotate(180deg)" : "none",
                  transition: "transform var(--dur) var(--ease)",
                }}
              />
              <span className="sr-only">
                {collapsed ? "Show conversation" : "Hide conversation"}
              </span>
            </button>
          )}
        </span>
      </header>

      {!collapsed && (
        <div className={styles.thread} ref={threadRef}>
          {turns.length === 0 && !busy ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Where are you trying to get to?</p>
              <p className={styles.emptyBody}>
                Describe it however you would say it out loud — landmarks, a
                nearby shop, &ldquo;behind the mosque&rdquo;. You do not need a
                formal address.
              </p>

              <div className={styles.suggestions}>
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className={styles.suggestion}
                    onClick={() => onSend(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {turns.map((turn, index) => (
            <div
              // Turns are append-only and never reordered, so the index is a
              // stable identity here.
              key={`${turn.role}-${index}`}
              className={styles.message}
              data-role={turn.role}
            >
              <div className={styles.bubble}>{turn.content}</div>
              {turn.trace && turn.trace.length > 0 && (
                <Trace items={turn.trace} />
              )}
            </div>
          ))}

          {busy && (
            <div className={styles.message} data-role="assistant">
              {liveTrace.length > 0 && <Trace items={liveTrace} />}
              <span className={styles.thinking}>
                <span className={styles.spinner} aria-hidden="true" />
                {liveTrace.length > 0 ? "Reading the results" : "Thinking"}
              </span>
            </div>
          )}

          {notice && <p className={styles.notice}>{notice}</p>}
        </div>
      )}

      <form className={styles.composer} onSubmit={submit}>
        {voice.listening && (
          <span className={styles.listening}>
            <span className={styles.bars} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            {voice.transcript || "Listening…"}
          </span>
        )}

        <div className={styles.inputRow}>
          <label htmlFor="fm-composer" className="sr-only">
            Ask Find Me
          </label>
          <textarea
            id="fm-composer"
            className={styles.input}
            rows={1}
            value={draft}
            placeholder="Ask Find Me…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy}
          />

          <button
            type="button"
            className={styles.mic}
            data-listening={voice.listening}
            onClick={onOpenVoice}
            disabled={busy}
            title="Talk to Find Me"
          >
            <Mic size={18} />
            <span className="sr-only">Talk to Find Me</span>
          </button>

          <button
            type="submit"
            className={styles.send}
            disabled={busy || !draft.trim()}
            title="Send"
          >
            <ArrowUp size={18} strokeWidth={2.5} />
            <span className="sr-only">Send</span>
          </button>
        </div>

        {!voice.supported && (
          <p className={styles.hint}>
            Voice input needs Chrome or Edge. Typing works everywhere.
          </p>
        )}

        {usage && <UsageLine usage={usage} />}
      </form>
    </section>
  );
}

/**
 * What the last turn cost.
 *
 * Visible on purpose while the model choice is still being decided: the whole
 * question of whether a cheap model is good enough is unanswerable without
 * seeing what each turn actually spends. `cached` is the one to watch — if it
 * never appears, the prompt prefix is too short to cache and every turn is
 * paying full price for the same system prompt.
 */
function UsageLine({ usage }: { usage: UsageReadout }) {
  const cents = usage.estimatedCostUsd * 100;
  const cost =
    cents < 1 ? `${cents.toFixed(3)}¢` : `$${usage.estimatedCostUsd.toFixed(4)}`;

  return (
    <p className={styles.hint}>
      {usage.model.replace("claude-", "")} · {usage.iterations} call
      {usage.iterations === 1 ? "" : "s"} · {usage.inputTokens.toLocaleString()} in
      {" / "}
      {usage.outputTokens.toLocaleString()} out
      {usage.cacheReadTokens > 0 && (
        <> · {usage.cacheReadTokens.toLocaleString()} cached</>
      )}{" "}
      · ~{cost}
    </p>
  );
}

function Trace({ items }: { items: TraceItem[] }) {
  return (
    <div className={styles.trace}>
      {items.map((item, index) => {
        const meta = TOOL_LABEL[item.tool] ?? { label: item.tool, Icon: Search };
        const Icon = meta.Icon;

        return (
          <span key={`${item.tool}-${index}`} style={{ display: "contents" }}>
            <span className={styles.traceChip}>
              <Icon size={12} aria-hidden="true" />
              {meta.label}
            </span>
            {item.band && (
              <span className={styles.band} data-band={item.band}>
                {BAND_LABEL[item.band]}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
