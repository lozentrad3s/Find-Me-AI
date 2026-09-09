"use client";

/**
 * Find Me — the app shell.
 *
 * Map-first, per the design philosophy in Part 2.3: the map is the page, and
 * everything else floats over it. The assistant is the primary control, not a
 * feature tucked behind a button.
 *
 * Map state is derived from tool results rather than from anything the model
 * says. A pin only appears because `resolve_place` returned coordinates; a
 * route is only drawn because OSRM returned geometry. If the model hallucinated
 * a place, nothing would move — which is the property we want.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, Moon, Sun } from "lucide-react";

import Assistant, { type ChatTurn, type TraceItem } from "@/components/Assistant";
import VoiceOverlay, { type VoiceState } from "@/components/VoiceOverlay";
import type { MapMarker } from "@/components/MapView";
import type { LatLng } from "@/lib/geo/distance";
import { useVoice } from "@/lib/voice/useVoice";

// Leaflet touches `window` on import, so it must never be server-rendered.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%", background: "var(--surface-sunken)" }} />,
});

/** Abuja city centre — a sensible view before permission is granted. */
const FALLBACK_CENTRE: LatLng = { lat: 9.0765, lng: 7.3986 };

type Theme = "light" | "dark";

interface ResolveResultShape {
  band?: "high" | "moderate" | "low";
  best?: { name?: string; address?: string; lat?: number; lng?: number } | null;
}

interface NearbyResultShape {
  results?: Array<{ name?: string; address?: string | null; lat?: number; lng?: number }>;
}

interface RouteResultShape {
  geometry?: string | null;
}

export default function Home() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [liveTrace, setLiveTrace] = useState<TraceItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [location, setLocation] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationLabel, setLocationLabel] = useState("Location not shared");

  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);

  const [theme, setTheme] = useState<Theme>("light");
  const [speakReplies, setSpeakReplies] = useState(false);
  const [usage, setUsage] = useState<UsageShape | null>(null);

  // --- voice conversation -------------------------------------------------
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [liveReply, setLiveReply] = useState("");
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);

  // Read inside callbacks that must not re-subscribe on every render.
  const voiceOpenRef = useRef(false);
  voiceOpenRef.current = voiceOpen;
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Held in a ref so the send handler never closes over a stale conversation.
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;

  // --- theme --------------------------------------------------------------

  useEffect(() => {
    const stored = (() => {
      try {
        return window.localStorage.getItem("fm-theme") as Theme | null;
      } catch {
        // Private mode and blocked site data both throw here.
        return null;
      }
    })();

    const initial =
      stored ??
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem("fm-theme", next);
      } catch {
        /* not important enough to surface */
      }
      return next;
    });
  }, []);

  // --- location -----------------------------------------------------------

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setNotice("This browser cannot report your location.");
      return;
    }

    setLocating(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        setLocation(point);
        setFocus(point);
        setLocating(false);
        setLocationLabel(
          `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)} · ±${Math.round(
            position.coords.accuracy,
          )} m`,
        );
        setNotice(null);
      },
      (error) => {
        setLocating(false);
        setNotice(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. You can still search and ask about places by name."
            : "Could not get a location fix. You can still search by name.",
        );
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  }, []);

  // --- voice --------------------------------------------------------------

  const voice = useVoice({
    onFinalTranscript: (transcript) => {
      setLastQuestion(transcript);
      void send(transcript);
    },
    // Closes the hands-free loop: when the spoken reply ends, listen again —
    // but only while the overlay is open, so the panel's mic button stays a
    // one-shot control rather than silently becoming always-on.
    onSpeechEnd: () => {
      if (voiceOpenRef.current && !busyRef.current) {
        window.setTimeout(() => {
          if (voiceOpenRef.current && !busyRef.current) voice.start();
        }, 350);
      }
    },
  });

  // --- chat ---------------------------------------------------------------

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      voice.stopSpeaking();
      setNotice(null);
      setLiveTrace([]);
      setLiveReply("");
      setBusy(true);

      const outgoing: ChatTurn[] = [
        ...turnsRef.current,
        { role: "user", content: trimmed },
      ];
      setTurns(outgoing);

      let assistantText = "";
      const trace: TraceItem[] = [];

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: outgoing.map(({ role, content }) => ({ role, content })),
            lat: location?.lat,
            lng: location?.lng,
          }),
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setNotice(payload?.error ?? "The assistant is unavailable.");
          setBusy(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line. A partial frame stays in
          // the buffer until the rest of it arrives.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;

            let event: unknown;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            handleEvent(event, {
              onText: (delta) => {
                assistantText += delta;
                setLiveReply(assistantText);
              },
              onTool: (name) => {
                trace.push({ tool: name });
                setLiveTrace([...trace]);
              },
              onToolResult: (name, result) => {
                const band = applyToolResult(name, result, {
                  setMarkers,
                  setRouteGeometry,
                  setFocus,
                });
                if (band) {
                  const last = trace[trace.length - 1];
                  if (last && last.tool === name) last.band = band;
                  setLiveTrace([...trace]);
                }
              },
              onUsage: (usage) => setUsage(usage),
              onError: (message) => setNotice(message),
            });
          }
        }
      } catch {
        setNotice("Lost connection to the assistant.");
      } finally {
        setBusy(false);
        setLiveTrace([]);

        if (assistantText.trim()) {
          setTurns((current) => [
            ...current,
            {
              role: "assistant",
              content: assistantText.trim(),
              trace: trace.length > 0 ? trace : undefined,
            },
          ]);

          // The overlay is a spoken interface by definition, so it always
          // reads replies back; the panel respects the toggle.
          if (speakReplies || voiceOpenRef.current) {
            voice.speak(assistantText.trim());
          }
        }
      }
    },
    [busy, location, speakReplies, voice],
  );

  // --- map ----------------------------------------------------------------

  const allMarkers = useMemo<MapMarker[]>(() => {
    const userMarker: MapMarker[] = location
      ? [{ id: "user", point: location, label: "You are here", kind: "user" }]
      : [];
    return [...userMarker, ...markers];
  }, [location, markers]);

  const centre = location ?? FALLBACK_CENTRE;

  /*
   * The overlay's state is derived rather than stored.
   *
   * Keeping a separate copy in state guarantees it eventually disagrees with
   * whether the microphone is actually open — and a listening animation over a
   * closed mic is the single most confusing thing a voice UI can do.
   */
  const voiceState: VoiceState = busy
    ? "thinking"
    : voice.speaking
      ? "speaking"
      : voice.listening
        ? "listening"
        : "idle";

  const openVoice = useCallback(() => {
    setVoiceOpen(true);
    setLastQuestion(null);
    setLiveReply("");
    // Open the mic immediately: the user tapped a microphone, so making them
    // tap a second one inside the overlay is a wasted step.
    if (voice.supported) voice.start();
  }, [voice]);

  const closeVoice = useCallback(() => {
    setVoiceOpen(false);
    voice.stop();
    voice.stopSpeaking();
  }, [voice]);

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <MapView
        center={centre}
        markers={allMarkers}
        routeGeometry={routeGeometry}
        focus={focus}
        dark={theme === "dark"}
      />

      <div
        style={{
          position: "absolute",
          top: "var(--space-4)",
          right: "var(--space-4)",
          zIndex: 500,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <FloatingButton
          onClick={locate}
          title={location ? "Recentre on your location" : "Share your location"}
          active={Boolean(location)}
        >
          {locating ? (
            <Loader2 size={18} style={{ animation: "fm-spin 0.8s linear infinite" }} />
          ) : (
            <Crosshair size={18} />
          )}
        </FloatingButton>

        <FloatingButton
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </FloatingButton>
      </div>

      <Assistant
        turns={turns}
        busy={busy}
        liveTrace={liveTrace}
        notice={notice}
        voice={voice}
        speakReplies={speakReplies}
        onToggleSpeakReplies={() => {
          setSpeakReplies((value) => {
            if (value) voice.stopSpeaking();
            return !value;
          });
        }}
        onSend={(text) => void send(text)}
        locationLabel={locationLabel}
        usage={usage}
        onOpenVoice={openVoice}
      />

      <VoiceOverlay
        open={voiceOpen}
        state={voiceState}
        supported={voice.supported}
        transcript={voice.transcript}
        lastQuestion={lastQuestion}
        reply={liveReply}
        trace={liveTrace}
        error={voice.error ?? notice}
        onClose={closeVoice}
        onToggleListening={voice.toggle}
        onAsk={(text) => {
          setLastQuestion(text);
          void send(text);
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------

function FloatingButton({
  children,
  onClick,
  title,
  active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: "grid",
        placeItems: "center",
        width: 44,
        height: 44,
        borderRadius: "var(--radius-md)",
        background: "var(--glass-bg)",
        backdropFilter: "blur(var(--glass-blur))",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        border: "1px solid var(--glass-border)",
        boxShadow: "var(--shadow-md)",
        color: active ? "var(--primary)" : "var(--fg-muted)",
        transition: "color var(--dur-fast) var(--ease)",
      }}
    >
      {children}
      <span className="sr-only">{title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

export interface UsageShape {
  model: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

function handleEvent(
  event: unknown,
  handlers: {
    onText: (delta: string) => void;
    onTool: (name: string) => void;
    onToolResult: (name: string, result: unknown) => void;
    onUsage: (usage: UsageShape) => void;
    onError: (message: string) => void;
  },
): void {
  if (typeof event !== "object" || event === null) return;
  const e = event as Record<string, unknown>;

  switch (e.type) {
    case "text":
      if (typeof e.delta === "string") handlers.onText(e.delta);
      break;
    case "tool_call":
      if (typeof e.name === "string") handlers.onTool(e.name);
      break;
    case "tool_result":
      if (typeof e.name === "string") handlers.onToolResult(e.name, e.result);
      break;
    case "usage":
      if (typeof e.usage === "object" && e.usage !== null) {
        handlers.onUsage(e.usage as UsageShape);
      }
      break;
    case "error":
      if (typeof e.message === "string") handlers.onError(e.message);
      break;
    default:
      break;
  }
}

/**
 * Turn a tool result into map state.
 *
 * Returns the confidence band when the tool reports one, so the UI can show it
 * beside the tool chip — the user should be able to see that the engine was
 * unsure, not just read a hedged sentence.
 */
function applyToolResult(
  name: string,
  result: unknown,
  setters: {
    setMarkers: (markers: MapMarker[]) => void;
    setRouteGeometry: (geometry: string | null) => void;
    setFocus: (point: LatLng | null) => void;
  },
): "high" | "moderate" | "low" | undefined {
  if (typeof result !== "object" || result === null) return undefined;

  if (name === "resolve_place") {
    const payload = result as ResolveResultShape;
    const best = payload.best;

    if (best && typeof best.lat === "number" && typeof best.lng === "number") {
      const point = { lat: best.lat, lng: best.lng };
      setters.setMarkers([
        {
          id: `resolve-${best.lat}-${best.lng}`,
          point,
          label: best.name ?? "Result",
          detail: best.address,
          kind: "route-end",
        },
      ]);
      setters.setFocus(point);
    }

    return payload.band;
  }

  if (name === "search_nearby") {
    const payload = result as NearbyResultShape;
    const found = (payload.results ?? []).filter(
      (r): r is { name?: string; address?: string | null; lat: number; lng: number } =>
        typeof r.lat === "number" && typeof r.lng === "number",
    );

    if (found.length > 0) {
      setters.setMarkers(
        found.map((place, index) => ({
          id: `nearby-${index}-${place.lat}-${place.lng}`,
          point: { lat: place.lat, lng: place.lng },
          label: place.name ?? "Place",
          detail: place.address ?? undefined,
          kind: "result",
        })),
      );
      const first = found[0];
      if (first) setters.setFocus({ lat: first.lat, lng: first.lng });
    }
    return undefined;
  }

  if (name === "calculate_route") {
    const payload = result as RouteResultShape;
    if (typeof payload.geometry === "string") {
      setters.setRouteGeometry(payload.geometry);
    }
    return undefined;
  }

  return undefined;
}
