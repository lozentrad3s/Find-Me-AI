"use client";

/**
 * The live tracking client.
 *
 * Design rules, all of them driven by who opens this page:
 *
 * - The status line comes FIRST, above the map. Someone opening this on a
 *   phone while running to their car needs "moving, 2 minutes ago" before
 *   they need cartography.
 * - Staleness is stated in plain words. A map with a pin on it looks equally
 *   confident whether the fix is four seconds or forty minutes old, and the
 *   difference is the whole meaning of the page.
 * - It degrades to coordinates. If tiles will not load on a weak connection,
 *   the numbers are still on screen and can be read aloud down a phone line —
 *   which is how a location actually reaches a Nigerian responder today.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Copy,
  Loader2,
  MapPin,
  Navigation,
  Phone,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import type { LatLng } from "@/lib/geo/distance";
import type { DispatchChannel, LocationFix } from "@/lib/safety/types";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div style={{ width: "100%", height: "100%", background: "var(--surface-sunken)" }} />
  ),
});

interface AlertView {
  id: string;
  kind: string;
  status: "active" | "resolved" | "expired";
  note: string;
  openedAt: number;
  resolvedAt: number | null;
  lastFix: LocationFix | null;
  trail: LocationFix[];
  locationDescription: string | null;
  durable: boolean;
  dispatch: DispatchChannel[];
}

/**
 * Poll interval.
 *
 * Five seconds. Fast enough that a car does not jump a block between updates,
 * slow enough not to flatten the battery of the phone doing the watching —
 * which may be the one that later has to make a call.
 */
const POLL_MS = 5_000;

/** Past this, the position on screen is history, not a location. */
const STALE_MS = 90_000;

export default function TrackView({
  alertId,
  token,
}: {
  alertId: string;
  token: string;
}) {
  const [alert, setAlert] = useState<AlertView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  // Re-renders the "how long ago" line even when no new fix has arrived, which
  // is exactly the case where the age matters most.
  const [now, setNow] = useState(() => Date.now());

  const stopped = useRef(false);

  const poll = useCallback(async () => {
    if (stopped.current) return;

    try {
      const response = await fetch(
        `/api/sos/${encodeURIComponent(alertId)}?t=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );

      if (response.status === 404) {
        stopped.current = true;
        setError(
          "This tracking link is not valid. It may have expired, or the link may be incomplete — check you copied the whole thing.",
        );
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as AlertView;
      setAlert(data);
      setError(null);

      // Stop polling once it is over. Nothing further will change, and a page
      // left open overnight should not keep hitting the server.
      if (data.status !== "active") stopped.current = true;
    } catch {
      // A single failed poll is usually a passing network blip, and blanking
      // the map for it would be worse than showing the last known position.
      // The staleness line already tells the truth about how old it is.
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [alertId, token]);

  useEffect(() => {
    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(interval);
      clearInterval(clock);
    };
  }, [poll]);

  const point: LatLng | null = alert?.lastFix
    ? { lat: alert.lastFix.lat, lng: alert.lastFix.lng }
    : null;

  const trail = useMemo(
    () => (alert?.trail ?? []).map((fix) => ({ lat: fix.lat, lng: fix.lng })),
    [alert?.trail],
  );

  const ageMs = alert?.lastFix ? now - alert.lastFix.at : null;
  const stale = ageMs !== null && ageMs > STALE_MS;

  if (loading) {
    return (
      <main style={S.centre}>
        <Loader2 size={26} style={{ animation: "fm-spin 0.8s linear infinite" }} />
        <p style={{ color: "var(--fg-muted)" }}>Finding them…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main style={S.centre}>
        <ShieldAlert size={30} color="var(--danger)" />
        <p style={{ maxWidth: 380, textAlign: "center", lineHeight: 1.6 }}>{error}</p>
        <a href="tel:112" style={{ ...S.action, ...S.actionPrimary, maxWidth: 320 }}>
          <Phone size={18} /> Call 112
        </a>
      </main>
    );
  }

  const active = alert?.status === "active";

  return (
    <main style={S.page}>
      {/* --- Status, above the map on purpose ------------------------------ */}
      <header style={{ ...S.header, background: active ? "var(--danger)" : "#0f766e" }}>
        <div style={S.headerRow}>
          {active ? <ShieldAlert size={22} /> : <ShieldCheck size={22} />}
          <div>
            <div style={S.headerTitle}>
              {active ? "Emergency in progress" : "Stood down"}
            </div>
            <div style={S.headerSub}>
              {active
                ? stale
                  ? `Last seen ${formatAge(ageMs)} ago — their phone has stopped reporting.`
                  : alert?.lastFix
                    ? `Live · updated ${formatAge(ageMs)} ago`
                    : "No location — their phone did not share a position."
                : "They marked themselves safe."}
            </div>
          </div>
        </div>

        {alert?.note && <p style={S.note}>“{alert.note}”</p>}
      </header>

      {/* --- Map ----------------------------------------------------------- */}
      <div style={S.mapWrap}>
        {point ? (
          <MapView
            center={point}
            zoom={16}
            focus={point}
            followUser
            markers={[
              {
                id: "person",
                point,
                label: active ? "Emergency" : "Last position",
                detail: alert?.locationDescription ?? undefined,
                kind: "user",
              },
            ]}
            heading={alert?.lastFix?.heading ?? null}
            travelMode={travelModeFrom(alert?.lastFix?.speedMps ?? null)}
            accuracyM={alert?.lastFix?.accuracyM ?? null}
            trail={trail}
          />
        ) : (
          <div style={{ ...S.centre, height: "100%" }}>
            <MapPin size={26} color="var(--fg-subtle)" />
            <p style={{ color: "var(--fg-muted)", textAlign: "center", maxWidth: 320 }}>
              No position was shared. Location permission may have been refused
              on their phone.
            </p>
          </div>
        )}
      </div>

      {/* --- What you can do ----------------------------------------------- */}
      <section style={S.footer}>
        {alert?.locationDescription && (
          <p style={S.description}>
            <MapPin size={15} style={{ flexShrink: 0, marginTop: 2 }} />
            {alert.locationDescription}
          </p>
        )}

        {point && (
          <div style={S.coordRow}>
            <code style={S.coords}>
              {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
            </code>
            <button
              type="button"
              style={S.iconButton}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(`${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`)
                  .then(() => setCopied(true))
                  .catch(() => undefined);
              }}
              title="Copy coordinates"
            >
              <Copy size={15} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        <div style={S.actions}>
          <a href="tel:112" style={{ ...S.action, ...S.actionPrimary }}>
            <Phone size={17} /> Call 112
          </a>
          {point && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`}
              target="_blank"
              rel="noreferrer"
              style={S.action}
            >
              <Navigation size={17} /> Directions
            </a>
          )}
        </div>

        {/*
          The honesty block. Whoever is reading this is deciding whether
          somebody else is already handling it, and getting that wrong is the
          worst outcome this feature can produce.
        */}
        {active && (
          <p style={S.honest}>
            {agencyReached(alert?.dispatch)
              ? "A connected security service has this alert and this live location."
              : "No security agency has been notified automatically — Nigerian services take phone calls, and nobody has made one unless you do. If this is serious, call 112 now."}
            {alert && !alert.durable && (
              <>
                {" "}
                This alert is running without a database behind it, so this link
                may stop working without warning.
              </>
            )}
          </p>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agencyReached(dispatch: DispatchChannel[] | undefined): boolean {
  return (dispatch ?? []).some(
    (channel) => channel.id.startsWith("partner-") && channel.status === "sent",
  );
}

/** Same speed bands the movement tracker uses, so the icon agrees with the app. */
function travelModeFrom(speedMps: number | null): "foot" | "bike" | "car" | "still" {
  if (speedMps === null || speedMps < 0.6) return "still";
  if (speedMps <= 2.2) return "foot";
  if (speedMps <= 7) return "bike";
  return "car";
}

function formatAge(ms: number | null): string {
  if (ms === null) return "unknown";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

// ---------------------------------------------------------------------------
// Styles
//
// Inline rather than a module, because this page must render correctly even if
// the app's stylesheet fails to load on a poor connection. The tokens still
// resolve when globals.css is present and fall back to literals when it is not.
// ---------------------------------------------------------------------------

const S: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    background: "var(--bg, #f6f9ff)",
    color: "var(--fg, #111827)",
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    height: "100dvh",
    padding: 24,
    background: "var(--bg, #f6f9ff)",
    color: "var(--fg, #111827)",
  },
  header: {
    color: "#fff",
    padding: "16px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  headerRow: { display: "flex", alignItems: "center", gap: 12 },
  headerTitle: { fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" },
  headerSub: { fontSize: 13, opacity: 0.92, marginTop: 2 },
  note: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    background: "rgb(0 0 0 / 0.16)",
    padding: "8px 10px",
    borderRadius: 10,
  },
  mapWrap: { flex: 1, minHeight: 220, position: "relative" },
  footer: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    background: "var(--surface, #fff)",
    borderTop: "1px solid var(--border, #dbe4f0)",
  },
  description: {
    margin: 0,
    display: "flex",
    gap: 8,
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--fg-muted, #6b7280)",
  },
  coordRow: { display: "flex", alignItems: "center", gap: 10 },
  coords: {
    flex: 1,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 14,
    background: "var(--surface-sunken, #eef3fb)",
    padding: "10px 12px",
    borderRadius: 10,
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid var(--border, #dbe4f0)",
    background: "var(--surface, #fff)",
    color: "inherit",
    font: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  actions: { display: "flex", gap: 10 },
  action: {
    flex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "13px 14px",
    borderRadius: 12,
    border: "1px solid var(--border, #dbe4f0)",
    background: "var(--surface, #fff)",
    color: "inherit",
    fontSize: 15,
    fontWeight: 600,
    textDecoration: "none",
  },
  actionPrimary: {
    background: "var(--danger, #dc2626)",
    borderColor: "transparent",
    color: "#fff",
  },
  honest: {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: "var(--fg-muted, #6b7280)",
  },
};
