"use client";

/**
 * Find Me — the app shell.
 *
 * Map-first, per the design philosophy: the map is the page and everything
 * else floats over it in a bottom sheet, which is the pattern both Google Maps
 * and Apple Maps converged on. It keeps content in thumb reach without ever
 * fully hiding where you are.
 *
 * The invariant worth protecting: map state is derived from tool and API
 * results, never from anything the model says. A pin appears because
 * coordinates came back; a route is drawn because OSRM returned geometry. If
 * the assistant hallucinated a place, nothing on the map would move.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, Shield } from "lucide-react";

import Assistant, { type ChatTurn, type TraceItem } from "@/components/Assistant";
import VoiceOverlay, { type VoiceState } from "@/components/VoiceOverlay";
import BottomSheet, { type Detent } from "@/components/shell/BottomSheet";
import BottomNav, { type TabId } from "@/components/shell/BottomNav";
import HomePanel from "@/components/panels/HomePanel";
import ExplorePanel, { type NearbyPlace } from "@/components/panels/ExplorePanel";
import {
  ProfilePanel,
  SafetyPanel,
  TripsPanel,
} from "@/components/panels/SimplePanels";
import type { MapMarker } from "@/components/MapView";
import type { LatLng } from "@/lib/geo/distance";
import type { WeatherReport } from "@/lib/weather/open-meteo";
import { useVoice } from "@/lib/voice/useVoice";
import { DEFAULT_CITY } from "@/lib/geo/cities";
import {
  addRecentPlace,
  clearRecentPlaces,
  getRecentPlaces,
  getSavedPlaces,
  type RecentPlace,
  type StoredPlace,
} from "@/lib/storage/places";

// Leaflet touches `window` on import, so it must never be server-rendered.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100%", height: "100%", background: "var(--surface-sunken)" }} />
  ),
});

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
  // --- conversation -------------------------------------------------------
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [liveTrace, setLiveTrace] = useState<TraceItem[]>([]);
  const [liveReply, setLiveReply] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageShape | null>(null);

  // --- shell --------------------------------------------------------------
  const [tab, setTab] = useState<TabId>("home");
  const [detent, setDetent] = useState<Detent>("half");
  const [chatOpen, setChatOpen] = useState(false);

  // --- location and map ---------------------------------------------------
  const [location, setLocation] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationLabel, setLocationLabel] = useState("Abuja");
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);

  // --- data ---------------------------------------------------------------
  const [weather, setWeather] = useState<WeatherReport | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [nearby, setNearby] = useState<NearbyPlace[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentPlace[]>([]);
  const [saved, setSaved] = useState<StoredPlace[]>([]);

  // --- prefs --------------------------------------------------------------
  const [theme, setTheme] = useState<Theme>("light");
  const [speakReplies, setSpeakReplies] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);

  // Refs for callbacks that must not re-subscribe on every render.
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;
  const voiceOpenRef = useRef(false);
  voiceOpenRef.current = voiceOpen;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const locationRef = useRef<LatLng | null>(null);
  locationRef.current = location;

  // --- boot ---------------------------------------------------------------

  useEffect(() => {
    const stored = (() => {
      try {
        return window.localStorage.getItem("fm-theme") as Theme | null;
      } catch {
        return null;
      }
    })();

    const initial =
      stored ??
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

    setTheme(initial);
    document.documentElement.dataset.theme = initial;

    setRecents(getRecentPlaces());
    setSaved(getSavedPlaces());
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem("fm-theme", next);
      } catch {
        /* not worth surfacing */
      }
      return next;
    });
  }, []);

  // --- weather ------------------------------------------------------------

  useEffect(() => {
    const point = location ?? DEFAULT_CITY.centre;
    let cancelled = false;

    setWeatherLoading(true);

    fetch(`/api/weather?lat=${point.lat}&lng=${point.lng}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data) return;
        setWeather(data as WeatherReport);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setWeatherLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [location]);

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
          `${point.lat.toFixed(3)}, ${point.lng.toFixed(3)} · ±${Math.round(
            position.coords.accuracy,
          )}m`,
        );
        setNotice(null);
      },
      (error) => {
        setLocating(false);
        setNotice(
          error.code === error.PERMISSION_DENIED
            ? "Location permission denied. You can still search by name."
            : "Could not get a fix. You can still search by name.",
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
    onSpeechEnd: () => {
      // Re-arm only while the overlay is open, so the panel mic stays one-shot.
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
      setChatOpen(true);
      setDetent("full");
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
            lat: locationRef.current?.lat,
            lng: locationRef.current?.lng,
            city: DEFAULT_CITY.id,
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
                  rememberPlace: (place) => {
                    setRecents(
                      addRecentPlace({ ...place, phrase: trimmed }),
                    );
                  },
                });
                if (band) {
                  const last = trace[trace.length - 1];
                  if (last && last.tool === name) last.band = band;
                  setLiveTrace([...trace]);
                }
              },
              onUsage: (value) => setUsage(value),
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

          if (speakReplies || voiceOpenRef.current) {
            voice.speak(assistantText.trim());
          }
        }
      }
    },
    [busy, speakReplies, voice],
  );

  // --- explore ------------------------------------------------------------

  const loadNearby = useCallback(
    async (category: string, label: string) => {
      const point = location ?? DEFAULT_CITY.centre;

      setActiveCategory(label);
      setNearbyLoading(true);

      try {
        const params = new URLSearchParams({
          lat: String(point.lat),
          lng: String(point.lng),
        });
        if (category) params.set("category", category);

        const response = await fetch(`/api/nearby?${params.toString()}`);
        const data = (await response.json()) as {
          places?: Array<{
            name: string;
            address: string | null;
            point: LatLng;
            distanceM: number;
          }>;
        };

        const places = data.places ?? [];
        setNearby(places);

        setMarkers(
          places.slice(0, 12).map((place, index) => ({
            id: `nearby-${index}`,
            point: place.point,
            label: place.name,
            detail: place.address ?? undefined,
            kind: "result" as const,
          })),
        );

        const first = places[0];
        if (first) setFocus(first.point);
      } catch {
        setNearby([]);
      } finally {
        setNearbyLoading(false);
      }
    },
    [location],
  );

  // --- map helpers --------------------------------------------------------

  const openPlace = useCallback((point: LatLng, name: string) => {
    setMarkers([{ id: `place-${name}`, point, label: name, kind: "route-end" }]);
    setFocus(point);
    setDetent("peek");
  }, []);

  const openVoice = useCallback(() => {
    setVoiceOpen(true);
    setLastQuestion(null);
    setLiveReply("");
    if (voice.supported) voice.start();
  }, [voice]);

  const closeVoice = useCallback(() => {
    setVoiceOpen(false);
    voice.stop();
    voice.stopSpeaking();
  }, [voice]);

  const shareLocation = useCallback(() => {
    const point = locationRef.current;
    if (!point) {
      setNotice("Share your location first so there is something to send.");
      return;
    }

    const text = `I'm here: https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=18/${point.lat}/${point.lng}`;

    if (navigator.share) {
      void navigator.share({ title: "My location", text }).catch(() => undefined);
      return;
    }

    void navigator.clipboard
      ?.writeText(text)
      .then(() => setNotice("Location link copied to your clipboard."))
      .catch(() => setNotice("Could not copy the location link."));
  }, []);

  // --- derived ------------------------------------------------------------

  const allMarkers = useMemo<MapMarker[]>(() => {
    const userMarker: MapMarker[] = location
      ? [{ id: "user", point: location, label: "You are here", kind: "user" }]
      : [];
    return [...userMarker, ...markers];
  }, [location, markers]);

  const voiceState: VoiceState = busy
    ? "thinking"
    : voice.speaking
      ? "speaking"
      : voice.listening
        ? "listening"
        : "idle";

  const centre = location ?? DEFAULT_CITY.centre;

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
          zIndex: 550,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <FloatingButton onClick={locate} title="My location" active={Boolean(location)}>
          {locating ? (
            <Loader2 size={18} style={{ animation: "fm-spin 0.8s linear infinite" }} />
          ) : (
            <Crosshair size={18} />
          )}
        </FloatingButton>

        <FloatingButton
          onClick={() => {
            setTab("safety");
            setChatOpen(false);
            setDetent("half");
          }}
          title="Safety and SOS"
          danger
        >
          <Shield size={18} />
        </FloatingButton>
      </div>

      <BottomSheet detent={detent} onDetentChange={setDetent} label="Find Me panel">
        {chatOpen ? (
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
            onClose={() => setChatOpen(false)}
            embedded
          />
        ) : tab === "home" ? (
          <HomePanel
            locationLabel={locationLabel}
            weather={weather}
            weatherLoading={weatherLoading}
            recents={recents}
            saved={saved}
            userLocation={location}
            onSearch={() => {
              setChatOpen(true);
              setDetent("full");
            }}
            onVoice={openVoice}
            onAsk={(phrase) => void send(phrase)}
            onOpenPlace={openPlace}
          />
        ) : tab === "explore" ? (
          <ExplorePanel
            userLocation={location}
            results={nearby}
            loading={nearbyLoading}
            activeCategory={activeCategory}
            onCategory={(category, label) => void loadNearby(category, label)}
            onOpenPlace={openPlace}
          />
        ) : tab === "trips" ? (
          <TripsPanel
            recents={recents}
            saved={saved}
            userLocation={location}
            onOpenPlace={openPlace}
            onClearRecents={() => {
              clearRecentPlaces();
              setRecents([]);
            }}
          />
        ) : tab === "safety" ? (
          <SafetyPanel
            locationLabel={locationLabel}
            onSos={shareLocation}
            onShareLocation={shareLocation}
          />
        ) : (
          <ProfilePanel
            theme={theme}
            onToggleTheme={toggleTheme}
            speakReplies={speakReplies}
            onToggleSpeak={() => setSpeakReplies((value) => !value)}
            savedCount={saved.length}
            recentCount={recents.length}
          />
        )}
      </BottomSheet>

      <BottomNav
        active={tab}
        onChange={(next) => {
          setTab(next);
          setChatOpen(false);
          setDetent("half");
          if (next === "explore" && nearby.length === 0 && !nearbyLoading) {
            void loadNearby("", "Nearby");
          }
        }}
        onVoice={openVoice}
        listening={voice.listening}
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
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  danger?: boolean;
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
        color: danger
          ? "var(--danger)"
          : active
            ? "var(--primary)"
            : "var(--fg-muted)",
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
 * Returns the confidence band when one is reported, so the UI can show that
 * the engine was unsure rather than leaving it buried in a hedged sentence.
 */
function applyToolResult(
  name: string,
  result: unknown,
  setters: {
    setMarkers: (markers: MapMarker[]) => void;
    setRouteGeometry: (geometry: string | null) => void;
    setFocus: (point: LatLng | null) => void;
    rememberPlace: (place: {
      name: string;
      address: string;
      point: LatLng;
    }) => void;
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

      // Only remember confident answers. Recording a guess would put a wrong
      // place in the user's history and then offer it back to them later.
      if (payload.band === "high") {
        setters.rememberPlace({
          name: best.name ?? "Place",
          address: best.address ?? "",
          point,
        });
      }
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

  if (name === "calculate_route" || name === "check_route_conditions") {
    const payload = result as RouteResultShape & {
      primary_route?: { geometry?: string | null };
    };
    const geometry = payload.geometry ?? payload.primary_route?.geometry;
    if (typeof geometry === "string") setters.setRouteGeometry(geometry);
    return undefined;
  }

  return undefined;
}
