"use client";

/**
 * Find Me — the app shell.
 *
 * Map-first, per the design philosophy: the map is the page and everything
 * else floats over it in a bottom sheet, which is the pattern both Google Maps
 * and Apple Maps converged on. It keeps content in thumb reach without ever
 * fully hiding where you are.
 *
 * The flow it is built around is Google Maps': ask for a place, see it on the
 * map with what it is, get asked whether to go, and on "yes" the route is
 * drawn and live navigation starts — your icon moving along it, the next turn
 * announced, a new route if you leave this one.
 *
 * The invariant worth protecting: map state is derived from tool and API
 * results, never from anything the model says. A pin appears because
 * coordinates came back; a route is drawn because the router returned
 * geometry. If the assistant hallucinated a place, nothing on the map would
 * move. (`lib/chat/interpret.ts` is where that translation lives.)
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, ShieldAlert, TrafficCone } from "lucide-react";

import Assistant, { type ChatTurn, type TraceItem } from "@/components/Assistant";
import VoiceOverlay, { type VoiceState } from "@/components/VoiceOverlay";
import SosSheet from "@/components/panels/SosSheet";
import BottomSheet, { type Detent } from "@/components/shell/BottomSheet";
import BottomNav, { type TabId } from "@/components/shell/BottomNav";
import HomePanel from "@/components/panels/HomePanel";
import ExplorePanel, { type NearbyPlace } from "@/components/panels/ExplorePanel";
import { ProfilePanel, TripsPanel } from "@/components/panels/SimplePanels";
import SafetyCommunity, { useCommunityFeed } from "@/components/panels/SafetyCommunity";
import {
  CategoryChips,
  ModeSuggestion,
  ModeSwitcher,
  NavBanner,
  TrafficLegend,
  type ModeChoice,
} from "@/components/map/MapOverlays";
import type { CardPlace, ChatCard } from "@/components/chat/Cards";
import type { MapMarker, RoadOverlay } from "@/components/MapView";
import { useSosBeacon } from "@/lib/safety/useSosBeacon";
import type { LatLng } from "@/lib/geo/distance";
import type { WeatherReport } from "@/lib/weather/open-meteo";
import { useVoice } from "@/lib/voice/useVoice";
import { useLocation } from "@/lib/location/useLocation";
import { useCompass } from "@/lib/location/useCompass";
import { MovementTracker, MODE_LABEL, type TravelMode } from "@/lib/location/movement";
import { DEFAULT_CITY } from "@/lib/geo/cities";
import { decodePolyline } from "@/lib/geo/polyline";
import { indexRoute, progressOnRoute, spokenDistance, type NavProgress } from "@/lib/nav/progress";
import { interpretToolResult, tripCard, type Interpretation } from "@/lib/chat/interpret";
import type { ContextPlace } from "@/lib/ai/intent";
import type { TripPlan } from "@/lib/trip/plan";
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

/** Spoken once when the microphone opens, then listening begins. */
const GREETING = "Hello, I'm Find Me. Where would you like to go?";
const MODE_STORAGE_KEY = "fm-travel-mode";
/** Traffic on the route is re-measured this often while navigating. */
const TRAFFIC_REFRESH_MS = 5 * 60 * 1000;
/** Weather and the community feed only need a new position every ~500 m. */
const COARSE_DEGREES = 0.005;

function routingMode(mode: TravelMode): "driving" | "walking" | "cycling" {
  return mode === "foot" ? "walking" : mode === "bike" ? "cycling" : "driving";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "under 1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function clockAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export default function Home() {
  // --- conversation -------------------------------------------------------
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [liveTrace, setLiveTrace] = useState<TraceItem[]>([]);
  const [liveReply, setLiveReply] = useState("");
  const [liveCards, setLiveCards] = useState<ChatCard[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageShape | null>(null);
  /** Places on screen that "take me there" and "the second one" refer to. */
  const [contextPlaces, setContextPlaces] = useState<ContextPlace[]>([]);

  // --- shell --------------------------------------------------------------
  const [tab, setTab] = useState<TabId>("home");
  const [detent, setDetent] = useState<Detent>("half");
  const [chatOpen, setChatOpen] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);

  // --- location and movement ----------------------------------------------
  const geo = useLocation();
  const location = geo.point;
  const compass = useCompass();

  /*
   * Movement, derived from consecutive fixes and the GPS's own speed.
   *
   * The tracker lives in a ref because it holds a rolling window across
   * renders — recreating it each render would reset the window and the mode
   * would never settle.
   */
  const trackerRef = useRef(new MovementTracker());
  const [movementHeading, setMovementHeading] = useState<number | null>(null);
  const [detectedMode, setDetectedMode] = useState<TravelMode>("still");
  const [speedMps, setSpeedMps] = useState(0);
  const [followUser, setFollowUser] = useState(true);
  const [modeChoice, setModeChoice] = useState<ModeChoice>("auto");
  const [modeHint, setModeHint] = useState<TravelMode | null>(null);
  const mismatchSinceRef = useRef<number | null>(null);
  const dismissedHintRef = useRef<TravelMode | null>(null);

  useEffect(() => {
    if (!geo.point) return;
    const state = trackerRef.current.push(geo.point, geo.accuracyM ?? 50, geo.fixAt ?? Date.now(), {
      speedMps: geo.speedMps,
      heading: geo.heading,
    });
    setMovementHeading(state.heading);
    setDetectedMode(state.mode);
    setSpeedMps(state.speedMps);
  }, [geo.point, geo.accuracyM, geo.fixAt, geo.speedMps, geo.heading]);

  /** The user's own choice wins over the guess from speed. */
  const travelMode: TravelMode = modeChoice === "auto" ? detectedMode : modeChoice;

  /*
   * Which way the marker points. Moving: the direction of travel, from the
   * GPS. Standing still: the compass, so the cone turns as you turn — the
   * question on a street corner is "which way am I facing", not "which way
   * was I going".
   */
  const heading =
    speedMps >= 1
      ? geo.heading ?? movementHeading ?? compass.heading
      : compass.heading ?? movementHeading;

  // Suggest switching when the chosen mode has disagreed with the measured
  // speed for a while — "you seem to be in a car now".
  useEffect(() => {
    if (modeChoice === "auto" || detectedMode === "still" || detectedMode === modeChoice) {
      mismatchSinceRef.current = null;
      setModeHint(null);
      return;
    }
    const now = Date.now();
    if (mismatchSinceRef.current === null) {
      mismatchSinceRef.current = now;
      return;
    }
    if (now - mismatchSinceRef.current > 20_000 && dismissedHintRef.current !== detectedMode) {
      setModeHint(detectedMode);
    }
  }, [modeChoice, detectedMode, geo.fixAt]);

  // --- map ----------------------------------------------------------------
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<string | null>(null);
  const [focus, setFocus] = useState<LatLng | null>(null);
  const [fitPoints, setFitPoints] = useState<LatLng[] | null>(null);
  const [roadHighlights, setRoadHighlights] = useState<RoadOverlay[]>([]);
  const [trafficOn, setTrafficOn] = useState(false);
  const [trafficAvailable, setTrafficAvailable] = useState<boolean | null>(null);
  const [chipCategory, setChipCategory] = useState<string | null>(null);

  // --- trip ---------------------------------------------------------------
  const [trip, setTrip] = useState<TripPlan | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [progress, setProgress] = useState<NavProgress | null>(null);
  const [navMuted, setNavMuted] = useState(false);
  const [offRoute, setOffRoute] = useState(false);
  const segmentRef = useRef(0);
  const offRouteCountRef = useRef(0);
  const lastRerouteRef = useRef(0);
  const spokenRef = useRef<Set<string>>(new Set());

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
  const [sosOpen, setSosOpen] = useState(false);
  /*
   * The SOS beacon lives here, at the top of the app, and nowhere lower.
   *
   * An emergency has to outlive whatever screen started it — closing the SOS
   * sheet, switching tabs or opening the assistant must never stop the
   * position reports. Owning it at the root is what guarantees that.
   */
  const beacon = useSosBeacon();
  /*
   * How the current turn arrived.
   *
   * Spoken questions get spoken answers; typed questions get typed ones.
   */
  const inputModeRef = useRef<"voice" | "text">("text");
  /** Human-readable position, filled by the last surroundings scan. */
  const [locationDescription, setLocationDescription] = useState<string | null>(null);

  // Refs for callbacks that must not re-subscribe on every render.
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;
  const voiceOpenRef = useRef(false);
  voiceOpenRef.current = voiceOpen;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const locationRef = useRef<LatLng | null>(null);
  locationRef.current = location;
  const travelModeRef = useRef<TravelMode>("still");
  travelModeRef.current = travelMode;
  const modeChoiceRef = useRef<ModeChoice>("auto");
  modeChoiceRef.current = modeChoice;
  const accuracyRef = useRef<number | null>(null);
  accuracyRef.current = geo.accuracyM;
  const contextPlacesRef = useRef<ContextPlace[]>([]);
  contextPlacesRef.current = contextPlaces;
  const tripRef = useRef<TripPlan | null>(null);
  tripRef.current = trip;
  const navigatingRef = useRef(false);
  navigatingRef.current = navigating;
  const navMutedRef = useRef(false);
  navMutedRef.current = navMuted;
  const speakRepliesRef = useRef(false);
  speakRepliesRef.current = speakReplies;

  /*
   * Location rounded to ~500 m, for things that only care roughly where you
   * are. Live movement delivers a fix a second; the weather and the community
   * feed must not refetch on every one of them.
   */
  const coarseLat = location ? Math.round(location.lat / COARSE_DEGREES) * COARSE_DEGREES : null;
  const coarseLng = location ? Math.round(location.lng / COARSE_DEGREES) * COARSE_DEGREES : null;
  const coarseLocation = useMemo<LatLng | null>(
    () => (coarseLat !== null && coarseLng !== null ? { lat: coarseLat, lng: coarseLng } : null),
    [coarseLat, coarseLng],
  );

  // --- boot ---------------------------------------------------------------

  useEffect(() => {
    const read = (key: string) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    const stored = read("fm-theme") as Theme | null;
    const initial =
      stored ??
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");

    setTheme(initial);
    document.documentElement.dataset.theme = initial;

    const mode = read(MODE_STORAGE_KEY);
    if (mode === "auto" || mode === "foot" || mode === "bike" || mode === "car") setModeChoice(mode);

    setRecents(getRecentPlaces());
    setSaved(getSavedPlaces());

    fetch("/api/traffic")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { available?: boolean } | null) => setTrafficAvailable(Boolean(data?.available)))
      .catch(() => setTrafficAvailable(false));
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

  const chooseMode = useCallback(
    (choice: ModeChoice) => {
      // A tap is the one moment iOS allows the compass permission prompt.
      if (compass.needsPermission) compass.request();
      setModeChoice(choice);
      setModeHint(null);
      dismissedHintRef.current = null;
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, choice);
      } catch {
        /* not worth surfacing */
      }
    },
    [compass],
  );

  // --- weather ------------------------------------------------------------

  useEffect(() => {
    const point = coarseLocation ?? DEFAULT_CITY.centre;
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
  }, [coarseLocation]);

  // --- location -----------------------------------------------------------

  const locating = geo.status === "locating" || geo.status === "prompting";

  const locate = useCallback(() => {
    geo.request();
    if (compass.needsPermission) compass.request();
    // Tapping the crosshair means "follow me again" — the usual reason it was
    // switched off is that the user panned the map to look elsewhere.
    setFollowUser(true);
    if (geo.point) setFocus({ ...geo.point });
  }, [geo, compass]);

  // Centre the map the first time a fix arrives, and surface permission
  // problems where the user will actually see them.
  const centredOnce = useRef(false);
  useEffect(() => {
    if (geo.point && !centredOnce.current) {
      centredOnce.current = true;
      setFocus(geo.point);
    }
  }, [geo.point]);

  useEffect(() => {
    if (geo.error) setNotice(geo.error);
  }, [geo.error]);

  const locationLabel = geo.point
    ? `${MODE_LABEL[travelMode]}${modeChoice === "auto" ? "" : " (set)"} · ±${geo.accuracyM ?? "?"}m`
    : geo.status === "denied"
      ? "Location blocked — tap to retry"
      : locating
        ? "Finding you…"
        : "Tap the crosshair to share location";

  // --- voice --------------------------------------------------------------

  const voice = useVoice({
    onFinalTranscript: (transcript) => {
      setLastQuestion(transcript);
      void send(transcript, "voice");
    },
    onSpeechEnd: () => {
      /*
       * Listening resumes the moment speech ends — including after the
       * greeting, which is what makes the open-mic flow feel continuous
       * rather than requiring a second tap. Only while the overlay is open,
       * so the panel mic stays one-shot.
       */
      if (voiceOpenRef.current && !busyRef.current) {
        window.setTimeout(() => {
          if (voiceOpenRef.current && !busyRef.current) voice.start();
        }, 250);
      }
    },
  });

  /** Navigation prompts — spoken unless the user muted guidance. */
  const announce = useCallback(
    (text: string) => {
      if (!navMutedRef.current) voice.speak(text);
    },
    [voice],
  );

  // --- trip ---------------------------------------------------------------

  const applyTrip = useCallback((plan: TripPlan) => {
    setTrip(plan);
    tripRef.current = plan;
    setRouteGeometry(plan.route.geometry);
    setRoadHighlights([]);
    setFitPoints(null);
    setChipCategory(null);
    setMarkers([
      {
        id: "destination",
        point: plan.destination.point,
        label: plan.destination.name,
        detail: `${plan.route.distanceText} · arrive ${plan.arrivalTime}`,
        kind: "route-end",
      },
      ...plan.incidents.map((incident, index) => ({
        id: `trip-incident-${index}`,
        point: incident.point,
        label: incident.kind.charAt(0).toUpperCase() + incident.kind.slice(1),
        detail: incident.note || "Community report on your route",
        kind: "incident" as const,
      })),
    ]);
    setContextPlaces([
      {
        id: "destination",
        name: plan.destination.name,
        lat: plan.destination.point.lat,
        lng: plan.destination.point.lng,
      },
    ]);
    segmentRef.current = 0;
    offRouteCountRef.current = 0;
    spokenRef.current = new Set();
    setProgress(null);
    setOffRoute(false);
    setArrived(false);
    setNavigating(true);
    setFollowUser(true);
    setDetent("peek");
  }, []);

  const endTrip = useCallback(() => {
    setNavigating(false);
    setArrived(false);
    setTrip(null);
    tripRef.current = null;
    setRouteGeometry(null);
    setProgress(null);
    setOffRoute(false);
    setMarkers([]);
    voice.stopSpeaking();
  }, [voice]);

  /** Re-plan from where the user is now: off the route, or traffic changed. */
  const refreshTrip = useCallback(
    async (reason: "reroute" | "traffic") => {
      const current = tripRef.current;
      const here = locationRef.current;
      if (!current || !here) return;

      if (reason === "reroute") setOffRoute(true);

      try {
        const response = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: here,
            to: current.destination.point,
            name: current.destination.name,
            mode: current.mode,
          }),
        });
        const data = (await response.json()) as { plan?: TripPlan };
        if (!data.plan || !tripRef.current) return;

        setTrip(data.plan);
        tripRef.current = data.plan;
        setRouteGeometry(data.plan.route.geometry);
        segmentRef.current = 0;
        spokenRef.current = new Set();
        if (reason === "reroute") announce("Rerouting.");
      } catch {
        /* keep navigating on the old route; the next fix will try again */
      } finally {
        setOffRoute(false);
      }
    },
    [announce],
  );

  const routeIndex = useMemo(
    () => (trip ? indexRoute(decodePolyline(trip.route.geometry), trip.route.steps) : null),
    [trip],
  );

  // Live progress on every fix: where along the route, the next turn, spoken
  // prompts, arrival, and rerouting when the user leaves the line.
  useEffect(() => {
    if (!navigating || !trip || !routeIndex || !location) return;

    const next = progressOnRoute(routeIndex, location, trip.destination.point, segmentRef.current);
    segmentRef.current = next.segment;
    setProgress(next);

    if (next.arrived) {
      setNavigating(false);
      setArrived(true);
      announce(`You've arrived at ${trip.destination.name}.`);
      return;
    }

    const tolerance =
      (trip.mode === "walking" ? 35 : 60) + Math.min(60, accuracyRef.current ?? 20);
    if (next.offRouteM > tolerance) {
      offRouteCountRef.current += 1;
      if (offRouteCountRef.current >= 3 && Date.now() - lastRerouteRef.current > 20_000) {
        offRouteCountRef.current = 0;
        lastRerouteRef.current = Date.now();
        void refreshTrip("reroute");
      }
    } else {
      offRouteCountRef.current = 0;
    }

    if (next.nextStep !== null && next.distanceToNextM !== null) {
      const step = trip.route.steps[next.nextStep];
      if (step) {
        const foot = trip.mode === "walking";
        const far = foot ? 60 : 300;
        const near = foot ? 15 : 60;
        const distance = next.distanceToNextM;
        const farKey = `${next.nextStep}:far`;
        const nearKey = `${next.nextStep}:near`;

        if (distance <= near && !spokenRef.current.has(nearKey)) {
          spokenRef.current.add(nearKey);
          spokenRef.current.add(farKey);
          announce(step.instruction);
        } else if (distance <= far && distance > near && !spokenRef.current.has(farKey)) {
          spokenRef.current.add(farKey);
          announce(`In ${spokenDistance(distance)}, ${lowerFirst(step.instruction)}.`);
        }
      }
    }
    // Runs per fix; the callbacks it uses are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, navigating, trip, routeIndex]);

  // Traffic changes while you drive; re-measure it every few minutes.
  useEffect(() => {
    if (!navigating || trip?.mode === "walking") return;
    const id = window.setInterval(() => void refreshTrip("traffic"), TRAFFIC_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [navigating, trip?.mode, refreshTrip]);

  // --- what tool results do to the screen ---------------------------------

  const withUser = useCallback((points: LatLng[]) => {
    const here = locationRef.current;
    return here ? [here, ...points] : points;
  }, []);

  const applyInterpretation = useCallback(
    (interp: Interpretation) => {
      if (interp.locationDescription) setLocationDescription(interp.locationDescription);

      if (interp.trip) {
        applyTrip(interp.trip);
        // A typed request gets a short spoken start, like any navigation app;
        // a spoken one hears the full reply instead.
        if (inputModeRef.current === "text" && !speakRepliesRef.current) {
          announce(`Starting route to ${interp.trip.destination.name}.`);
        }
        return;
      }

      if (interp.route !== undefined && !navigatingRef.current) setRouteGeometry(interp.route);

      if (interp.markers) {
        const current = tripRef.current;
        setMarkers(
          navigatingRef.current && current
            ? [
                {
                  id: "destination",
                  point: current.destination.point,
                  label: current.destination.name,
                  kind: "route-end" as const,
                },
                ...interp.markers,
              ]
            : interp.markers,
        );
      }
      if (interp.roads) setRoadHighlights(interp.roads);
      if (interp.places) setContextPlaces(interp.places);

      if (interp.fit) setFitPoints(withUser(interp.fit));
      else if (interp.focus) setFocus(interp.focus);

      // Results on the map: stop dragging the view back to the user, and
      // lower the sheet so the pins are actually visible.
      if ((interp.markers || interp.fit || interp.roads) && !navigatingRef.current) {
        setFollowUser(false);
        setDetent((current) => (current === "full" ? "half" : current));
      }
    },
    [announce, applyTrip, withUser],
  );

  // --- chat ---------------------------------------------------------------

  const send = useCallback(
    async (text: string, mode: "voice" | "text" = "text") => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;

      inputModeRef.current = mode;

      // Sending is usually a tap too — prime here as well, so a typed
      // question with spoken replies enabled is not silently mute.
      voice.unlock();
      voice.stopSpeaking();
      setChatOpen(true);
      setDetent(navigatingRef.current ? "half" : "full");
      setNotice(null);
      setLiveTrace([]);
      setLiveReply("");
      setLiveCards([]);
      setBusy(true);
      busyRef.current = true;

      const outgoing: ChatTurn[] = [...turnsRef.current, { role: "user", content: trimmed }];
      setTurns(outgoing);

      let assistantText = "";
      const trace: TraceItem[] = [];
      const cards: ChatCard[] = [];

      try {
        const here = locationRef.current;
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: outgoing
              .filter((turn) => turn.content.trim())
              .map(({ role, content }) => ({ role, content })),
            lat: here?.lat,
            lng: here?.lng,
            city: DEFAULT_CITY.id,
            // So the assistant routes for how the user is actually travelling,
            // and trusts a mode the user chose over one guessed from speed.
            travelMode: travelModeRef.current,
            modeSource: modeChoiceRef.current === "auto" ? "auto" : "user",
            accuracyM: accuracyRef.current,
            // What "take me there" can refer to.
            places: contextPlacesRef.current,
          }),
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setNotice(payload?.error ?? "The assistant is unavailable.");
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
                const interp = interpretToolResult(name, result);
                applyInterpretation(interp);

                if (interp.cards && interp.cards.length > 0) {
                  cards.push(...interp.cards);
                  setLiveCards([...cards]);
                }
                if (interp.remember) {
                  setRecents(addRecentPlace({ ...interp.remember, phrase: trimmed }));
                }
                if (interp.band) {
                  const last = [...trace].reverse().find((item) => item.tool === name);
                  if (last) last.band = interp.band;
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
        busyRef.current = false;
        setLiveTrace([]);
        setLiveCards([]);
        setLiveReply("");

        const content = assistantText.trim();
        if (content || cards.length > 0) {
          setTurns((current) => [
            ...current,
            {
              role: "assistant",
              content,
              trace: trace.length > 0 ? trace : undefined,
              cards: cards.length > 0 ? cards : undefined,
            },
          ]);
        }

        // Voice in, voice out. The toggle only forces speech for typed input.
        if (content && (inputModeRef.current === "voice" || speakRepliesRef.current)) {
          voice.speak(content);
        }
      }
    },
    [applyInterpretation, voice],
  );

  /**
   * "Directions" on a card: plan straight away, no model in the loop — the
   * destination is already known exactly, so asking a model would only add
   * seconds and spend quota.
   */
  const startTrip = useCallback(
    async (place: { name: string; lat: number; lng: number }) => {
      voice.unlock();

      const here = locationRef.current;
      if (!here) {
        setNotice("Share your location so I can route from where you are.");
        geo.request();
        return;
      }

      setChatOpen(true);
      setNotice(null);
      setTurns((current) => [...current, { role: "user", content: `Take me to ${place.name}` }]);
      setBusy(true);
      busyRef.current = true;
      setLiveTrace([{ tool: "plan_trip" }]);

      try {
        const response = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: here,
            to: { lat: place.lat, lng: place.lng },
            name: place.name,
            mode: routingMode(travelModeRef.current),
          }),
        });
        const data = (await response.json()) as { plan?: TripPlan; summary?: string; error?: string };

        if (!response.ok || !data.plan) {
          const message = data.error ?? "I couldn't plan a route there right now.";
          setTurns((current) => [...current, { role: "assistant", content: message }]);
          return;
        }

        applyTrip(data.plan);
        const summary = data.summary ?? "";
        setTurns((current) => [
          ...current,
          { role: "assistant", content: summary, trace: [{ tool: "plan_trip" }], cards: [tripCard(data.plan!)] },
        ]);

        if (inputModeRef.current === "voice" || speakRepliesRef.current || voiceOpenRef.current) {
          voice.speak(summary);
        } else {
          announce(`Starting route to ${place.name}. ${data.plan.route.trafficDurationText ?? data.plan.route.durationText}.`);
        }
      } catch {
        setTurns((current) => [
          ...current,
          { role: "assistant", content: "I lost the connection while planning that route. Try again." },
        ]);
      } finally {
        setBusy(false);
        busyRef.current = false;
        setLiveTrace([]);
      }
    },
    [announce, applyTrip, geo, voice],
  );

  // --- explore ------------------------------------------------------------

  const runCategory = useCallback(
    async (query: string, label: string, openList: boolean) => {
      // Tapping the active chip again clears it.
      if (chipCategory === query && !openList) {
        setChipCategory(null);
        setMarkers([]);
        return;
      }

      const point = locationRef.current ?? DEFAULT_CITY.centre;

      setActiveCategory(label);
      setChipCategory(query);
      setNearbyLoading(true);
      if (openList) {
        setChatOpen(false);
        setTab("explore");
        setDetent("half");
      }

      try {
        const params = new URLSearchParams({
          lat: String(point.lat),
          lng: String(point.lng),
        });
        if (query) params.set("category", query);

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

        const pins = places.slice(0, 15).map((place, index) => ({
          id: `nearby-${index}-${place.point.lat}-${place.point.lng}`,
          point: place.point,
          label: place.name,
          detail: [formatDistance(place.distanceM), place.address].filter(Boolean).join(" · "),
          kind: "result" as const,
        }));
        const current = tripRef.current;
        setMarkers(
          navigatingRef.current && current
            ? [
                {
                  id: "destination",
                  point: current.destination.point,
                  label: current.destination.name,
                  kind: "route-end" as const,
                },
                ...pins,
              ]
            : pins,
        );

        setContextPlaces(
          places.slice(0, 10).map((place, index) => ({
            id: `nearby-${index}`,
            name: place.name,
            lat: place.point.lat,
            lng: place.point.lng,
            address: place.address,
          })),
        );

        if (places.length > 0 && !navigatingRef.current) {
          setFollowUser(false);
          setFitPoints(withUser(places.slice(0, 6).map((place) => place.point)));
        }
      } catch {
        setNearby([]);
      } finally {
        setNearbyLoading(false);
      }
    },
    [chipCategory, withUser],
  );

  // --- map helpers --------------------------------------------------------

  const openPlace = useCallback((point: LatLng, name: string) => {
    setMarkers([{ id: `place-${name}`, point, label: name, kind: "route-end" }]);
    setContextPlaces([{ id: `place-${name}`, name, lat: point.lat, lng: point.lng }]);
    setFollowUser(false);
    setFocus({ ...point });
    setDetent("peek");
  }, []);

  const showPlace = useCallback((place: CardPlace) => {
    const point = { lat: place.lat, lng: place.lng };
    setMarkers((current) =>
      current.some((marker) => marker.id === place.id)
        ? current
        : [...current, { id: place.id, point, label: place.name, detail: place.address ?? undefined, kind: "route-end" }],
    );
    setContextPlaces((current) => [
      { id: place.id, name: place.name, lat: place.lat, lng: place.lng, address: place.address ?? null },
      ...current.filter((entry) => entry.id !== place.id),
    ]);
    setFollowUser(false);
    setFocus(point);
    setDetent("peek");
  }, []);

  const openVoice = useCallback(() => {
    // This runs inside a tap, which is the only moment iOS will let us prime
    // the speech queue. Without it every later reply is silently dropped.
    voice.unlock();
    setVoiceOpen(true);
    setLastQuestion(null);
    setLiveReply("");

    if (!voice.supported) return;

    /*
     * Greet, then listen. Listening starts from onSpeechEnd so the greeting
     * is never transcribed as user input.
     */
    inputModeRef.current = "voice";
    voice.speak(GREETING);
  }, [voice]);

  const closeVoice = useCallback(() => {
    setVoiceOpen(false);
    voice.stop();
    voice.stopSpeaking();
  }, [voice]);

  /**
   * The orb: listening -> stop; anything else (speaking, idle, thinking) ->
   * stop talking and listen now. One tap always gets you a microphone.
   */
  const orbTap = useCallback(() => {
    voice.unlock();
    if (voice.listening) voice.stop();
    else voice.interrupt();
  }, [voice]);

  const openChat = useCallback(() => {
    setChatOpen(true);
    setDetent("full");
    setFocusSignal((value) => value + 1);
  }, []);

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

  /*
   * The community feed polls app-wide, not only on the Safety tab. An
   * emergency two streets away should reach the map whichever tab someone
   * happens to be on.
   */
  const community = useCommunityFeed(coarseLocation, true);

  const allMarkers = useMemo<MapMarker[]>(() => {
    const userMarker: MapMarker[] = location
      ? [{ id: "user", point: location, label: "You are here", kind: "user" }]
      : [];

    const ownAlertId = beacon.alert?.id ?? null;
    const alertMarkers: MapMarker[] = (community.feed?.activeAlerts ?? [])
      .filter((alert) => alert.id !== ownAlertId && alert.lastFix)
      .map((alert) => ({
        id: `alert-${alert.id}`,
        point: { lat: alert.lastFix!.lat, lng: alert.lastFix!.lng },
        label: "Emergency nearby",
        detail: alert.locationDescription ?? "Someone nearby activated SOS. Call 112 if you can help.",
        kind: "alert" as const,
      }));

    const incidentMarkers: MapMarker[] = (community.feed?.incidents ?? []).map(
      (incident) => ({
        id: `incident-${incident.id}`,
        point: incident.point,
        label: incident.kind.charAt(0).toUpperCase() + incident.kind.slice(1),
        detail:
          (incident.note ? `${incident.note} · ` : "") +
          (incident.confirmations > 0
            ? `${incident.confirmations} confirmed`
            : "Unconfirmed report"),
        kind: "incident" as const,
      }),
    );

    return [...userMarker, ...markers, ...incidentMarkers, ...alertMarkers];
  }, [location, markers, community.feed, beacon.alert]);

  const voiceState: VoiceState = busy
    ? "thinking"
    : voice.speaking
      ? "speaking"
      : voice.listening
        ? "listening"
        : "idle";

  const centre = location ?? DEFAULT_CITY.centre;

  // Navigation banner numbers.
  const nextStep =
    trip && progress && progress.nextStep !== null
      ? trip.route.steps[progress.nextStep]
      : trip?.route.steps[1] ?? trip?.route.steps[0];
  const tripSeconds = trip ? trip.route.trafficDurationS ?? trip.route.durationS : 0;
  const remainingM = progress ? progress.remainingM : trip?.route.distanceM ?? 0;
  const remainingS =
    trip && routeIndex && routeIndex.totalM > 0 ? tripSeconds * (remainingM / routeIndex.totalM) : tripSeconds;

  const assistantProps = {
    turns,
    busy,
    liveTrace,
    liveReply,
    liveCards,
    notice,
    voice,
    speakReplies,
    onToggleSpeakReplies: () => {
      setSpeakReplies((value) => {
        if (value) voice.stopSpeaking();
        return !value;
      });
    },
    onSend: (text: string) => void send(text, "text"),
    locationLabel,
    usage,
    onOpenVoice: openVoice,
    onDirections: (place: CardPlace) => void startTrip(place),
    onShowPlace: showPlace,
    focusSignal,
    tripActive: navigating,
    embedded: true,
  };

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <MapView
        center={centre}
        markers={allMarkers}
        routeGeometry={routeGeometry}
        routeTraffic={trip?.traffic.readings ?? null}
        roads={roadHighlights}
        focus={focus}
        fitPoints={fitPoints}
        dark={theme === "dark"}
        heading={heading}
        travelMode={travelMode}
        accuracyM={geo.accuracyM}
        followUser={followUser}
        navigating={navigating}
        trafficLayer={trafficOn && trafficAvailable === true}
        onUserPan={() => setFollowUser(false)}
      />

      {trip && (navigating || arrived) ? (
        <NavBanner
          destination={trip.destination.name}
          instruction={nextStep?.instruction ?? "Head to the route"}
          maneuver={{ type: nextStep?.type, modifier: nextStep?.modifier }}
          distanceText={
            progress?.distanceToNextM !== null && progress?.distanceToNextM !== undefined
              ? formatDistance(progress.distanceToNextM)
              : null
          }
          remainingText={`${formatDuration(remainingS)} · ${formatDistance(remainingM)}`}
          etaText={clockAfter(remainingS)}
          arrived={arrived}
          offRoute={offRoute}
          muted={navMuted}
          onToggleMute={() => {
            setNavMuted((value) => {
              if (!value) voice.stopSpeaking();
              return !value;
            });
          }}
          onEnd={endTrip}
        />
      ) : (
        <CategoryChips
          active={chipCategory}
          onSelect={(query, label) => void runCategory(query, label, false)}
        />
      )}

      {!navigating && !arrived && (
        <ModeSwitcher choice={modeChoice} detected={detectedMode} onChange={chooseMode} />
      )}

      {modeHint && !navigating && (
        <ModeSuggestion
          mode={modeHint}
          onAccept={() => chooseMode(modeHint === "still" ? "auto" : modeHint)}
          onDismiss={() => {
            dismissedHintRef.current = modeHint;
            setModeHint(null);
          }}
        />
      )}

      {trafficOn && !navigating && (
        <TrafficLegend available={trafficAvailable} onClose={() => setTrafficOn(false)} />
      )}

      <div
        style={{
          position: "absolute",
          top: "calc(var(--space-3) + env(safe-area-inset-top, 0px))",
          right: "var(--space-3)",
          zIndex: 550,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        <FloatingButton
          onClick={locate}
          title={followUser ? "Following you" : "Back to my location"}
          active={Boolean(location) && followUser}
        >
          {locating ? (
            <Loader2 size={18} style={{ animation: "fm-spin 0.8s linear infinite" }} />
          ) : (
            <Crosshair size={18} />
          )}
        </FloatingButton>

        <FloatingButton
          onClick={() => setTrafficOn((value) => !value)}
          title={trafficOn ? "Hide live traffic" : "Show live traffic"}
          active={trafficOn}
        >
          <TrafficCone size={18} />
        </FloatingButton>

        <SosPill live={beacon.alert !== null} onClick={() => setSosOpen(true)} />
      </div>

      <BottomSheet detent={detent} onDetentChange={setDetent} label="Find Me panel">
        {chatOpen ? (
          <Assistant
            {...assistantProps}
            onClose={() => {
              setChatOpen(false);
              setTab("home");
            }}
          />
        ) : tab === "home" ? (
          <HomePanel
            locationLabel={locationLabel}
            weather={weather}
            weatherLoading={weatherLoading}
            recents={recents}
            saved={saved}
            userLocation={location}
            onSearch={openChat}
            onVoice={openVoice}
            onCategory={(query, label) => void runCategory(query, label, true)}
            onOpenPlace={openPlace}
          />
        ) : tab === "explore" ? (
          <ExplorePanel
            userLocation={location}
            results={nearby}
            loading={nearbyLoading}
            activeCategory={activeCategory}
            onCategory={(category, label) => void runCategory(category, label, true)}
            onOpenPlace={openPlace}
          />
        ) : tab === "chat" ? (
          <Assistant {...assistantProps} />
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
          <SafetyCommunity
            location={location}
            locationLabel={locationLabel}
            beacon={beacon}
            feed={community.feed}
            feedLoading={community.loading}
            onRefresh={() => void community.refresh()}
            onSos={() => setSosOpen(true)}
            onShareLocation={shareLocation}
            onShowOnMap={(point) => {
              setFollowUser(false);
              setFocus(point);
              setDetent("peek");
            }}
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
          setChatOpen(next === "chat");
          setDetent(next === "chat" ? "full" : "half");
          if (next === "chat") setFocusSignal((value) => value + 1);
          if (next === "explore" && nearby.length === 0 && !nearbyLoading) {
            void runCategory("", "Nearby", true);
          }
        }}
        onVoice={openVoice}
        listening={voice.listening}
      />

      <SosSheet
        open={sosOpen}
        location={location}
        locationDescription={locationDescription}
        beacon={beacon}
        onClose={() => setSosOpen(false)}
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
        onToggleListening={orbTap}
        onAsk={(text) => {
          setLastQuestion(text);
          void send(text, "voice");
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------

/**
 * The always-visible SOS control.
 *
 * Red, says SOS in words, and when an alert is live it pulses and says LIVE
 * so the person can see from across the room that their position is still
 * going out.
 */
function SosPill({ live, onClick }: { live: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={live ? "SOS is live — tap to manage" : "Emergency SOS"}
      className={live ? "fm-sos-live" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 44,
        minWidth: 44,
        padding: "0 12px",
        borderRadius: "var(--radius-md)",
        border: "none",
        background: live
          ? "linear-gradient(160deg, #dc2626, #7f1d1d)"
          : "linear-gradient(160deg, #ef4444, #b91c1c)",
        color: "#fff",
        fontSize: 13,
        fontWeight: 800,
        letterSpacing: "0.06em",
        boxShadow: "0 8px 20px -6px rgb(239 68 68 / 0.7)",
      }}
    >
      <ShieldAlert size={17} strokeWidth={2.4} aria-hidden="true" />
      {live ? "LIVE" : "SOS"}
    </button>
  );
}

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
      aria-pressed={active}
      style={{
        display: "grid",
        placeItems: "center",
        width: 44,
        height: 44,
        borderRadius: "var(--radius-md)",
        background: active ? "var(--primary)" : "var(--glass-bg)",
        backdropFilter: "blur(var(--glass-blur))",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        border: "1px solid var(--glass-border)",
        boxShadow: "var(--shadow-md)",
        color: danger
          ? "var(--danger)"
          : active
            ? "var(--on-primary)"
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
