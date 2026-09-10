"use client";

/**
 * Safety — the community security board.
 *
 * Three things on one screen, in the order that matters:
 *
 * 1. SOS, big and red and first. Nothing on this tab may compete with it.
 * 2. Live emergencies near you. Someone in trouble two streets away is the
 *    single most important thing a neighbour can be shown.
 * 3. Reports — what people nearby have seen in the last twelve hours, and a
 *    way to add one.
 *
 * HOW MUCH TO TRUST A REPORT, SAID OUT LOUD
 *
 * Every report shows how many other people confirmed it, and an unconfirmed
 * one is labelled as exactly that: one person's claim. On a security board a
 * false "kidnapping reported here" pin can start a panic or get an innocent
 * person accused, so the UI grades its own certainty rather than rendering
 * every pin with equal authority.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  Shield,
  ShieldAlert,
  Siren,
  TriangleAlert,
  Users,
  Waves,
  X,
} from "lucide-react";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import type { IncidentKind, PublicIncident } from "@/lib/safety/types";
import type { SosBeacon } from "@/lib/safety/useSosBeacon";
import styles from "./Safety.module.css";

export interface NearbyAlert {
  id: string;
  kind: string;
  openedAt: number;
  lastFix: { lat: number; lng: number } | null;
  locationDescription: string | null;
}

export interface CommunityFeed {
  incidents: PublicIncident[];
  activeAlerts: NearbyAlert[];
  radiusM: number;
  durable: boolean;
}

const INCIDENT_LABEL: Record<IncidentKind, string> = {
  robbery: "Robbery",
  kidnapping: "Kidnapping",
  accident: "Accident",
  fire: "Fire",
  flood: "Flooding",
  roadblock: "Roadblock",
  unrest: "Unrest",
  suspicious: "Suspicious activity",
  other: "Other",
};

/** Order in the report form: most common and most urgent first. */
const REPORT_KINDS: IncidentKind[] = [
  "robbery",
  "accident",
  "roadblock",
  "suspicious",
  "kidnapping",
  "fire",
  "flood",
  "unrest",
  "other",
];

/**
 * A stable per-browser id, sent with reports and confirmations.
 *
 * Only ever hashed server-side, and only used to stop one device confirming
 * its own report. Not an account, not tracking, and not sent anywhere else.
 */
function deviceId(): string {
  try {
    const existing = localStorage.getItem("findme.device");
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem("findme.device", fresh);
    return fresh;
  } catch {
    return "";
  }
}

export default function SafetyCommunity({
  location,
  locationLabel,
  beacon,
  feed,
  feedLoading,
  onRefresh,
  onSos,
  onShareLocation,
  onShowOnMap,
}: {
  location: LatLng | null;
  locationLabel: string;
  beacon: SosBeacon;
  feed: CommunityFeed | null;
  feedLoading: boolean;
  onRefresh: () => void;
  onSos: () => void;
  onShareLocation: () => void;
  onShowOnMap: (point: LatLng, label: string) => void;
}) {
  const [reporting, setReporting] = useState(false);

  const ownAlertId = beacon.alert?.id ?? null;
  // Your own alert is in the feed too; showing it back to you as a stranger's
  // emergency would be confusing at the worst possible moment.
  const othersAlerts = (feed?.activeAlerts ?? []).filter((a) => a.id !== ownAlertId);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Safety</h1>
          <p className={styles.sub}>Your community, watching out for each other.</p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          title="Refresh"
          disabled={feedLoading}
        >
          <RefreshCw
            size={16}
            style={feedLoading ? { animation: "fm-spin 0.8s linear infinite" } : undefined}
          />
          <span className="sr-only">Refresh</span>
        </button>
      </div>

      {/* --- 1. SOS ------------------------------------------------------- */}
      {beacon.alert ? (
        <button type="button" className={styles.liveBanner} onClick={onSos}>
          <span className={styles.liveDot} aria-hidden="true" />
          <span>
            <strong>Your SOS is live</strong>
            <span className={styles.liveMeta}>
              Location sent {beacon.pingsSent} {beacon.pingsSent === 1 ? "time" : "times"} ·
              tap to manage
            </span>
          </span>
        </button>
      ) : (
        <button type="button" className={styles.sos} onClick={onSos}>
          <ShieldAlert size={24} strokeWidth={2.4} aria-hidden="true" />
          <span>
            <span className={styles.sosLabel}>SOS</span>
            <span className={styles.sosHint}>Hold to alert · shares your live location</span>
          </span>
        </button>
      )}

      <div className={styles.quickRow}>
        <a href="tel:112" className={styles.quick}>
          <Siren size={16} aria-hidden="true" /> 112
        </a>
        <a href="tel:199" className={styles.quick}>
          <Shield size={16} aria-hidden="true" /> Police 199
        </a>
        <button type="button" className={styles.quick} onClick={onShareLocation}>
          <Share2 size={16} aria-hidden="true" /> Share location
        </button>
      </div>

      {/* --- 2. Live emergencies nearby ---------------------------------- */}
      {othersAlerts.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>
            <span className={styles.liveDot} aria-hidden="true" />
            Emergencies near you
          </h2>
          <div className={styles.list}>
            {othersAlerts.map((alert) => (
              <button
                key={alert.id}
                type="button"
                className={styles.alertRow}
                onClick={() =>
                  alert.lastFix && onShowOnMap(alert.lastFix, "Emergency")
                }
              >
                <span className={styles.alertIcon}>
                  <ShieldAlert size={16} />
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>
                    {alert.kind === "unspecified" ? "SOS" : `SOS · ${alert.kind}`}
                  </span>
                  <span className={styles.rowMeta}>
                    {alert.locationDescription ?? "Location shared"} ·{" "}
                    {ago(alert.openedAt)}
                  </span>
                </span>
                {location && alert.lastFix && (
                  <span className={styles.rowDistance}>
                    {distanceText(distanceMetres(location, alert.lastFix))}
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className={styles.note}>
            If you are close and it is safe, you can help — but call 112 first.
            Do not put yourself in danger.
          </p>
        </section>
      )}

      {/* --- 3. Reports -------------------------------------------------- */}
      <section>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            <Users size={14} aria-hidden="true" /> Reported nearby
          </h2>
          {!reporting && (
            <button
              type="button"
              className={styles.reportButton}
              onClick={() => setReporting(true)}
              disabled={!location}
              title={location ? "Report something" : "Needs your location"}
            >
              <Plus size={14} /> Report
            </button>
          )}
        </div>

        {reporting && location && (
          <ReportForm
            location={location}
            area={locationLabel}
            onDone={() => {
              setReporting(false);
              onRefresh();
            }}
            onCancel={() => setReporting(false)}
          />
        )}

        {!location ? (
          <p className={styles.empty}>
            Turn on location to see what has been reported around you.
          </p>
        ) : feedLoading && !feed ? (
          <p className={styles.empty}>
            <Loader2 size={14} style={{ animation: "fm-spin 0.8s linear infinite" }} />
            Checking your area…
          </p>
        ) : feed && feed.incidents.length === 0 ? (
          <p className={styles.empty}>
            Nothing reported within {Math.round(feed.radiusM / 1000)} km in the
            last 12 hours.
          </p>
        ) : (
          <div className={styles.list}>
            {(feed?.incidents ?? []).map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                location={location}
                onShowOnMap={onShowOnMap}
                onConfirmed={onRefresh}
              />
            ))}
          </div>
        )}
      </section>

      {/*
        The honesty block, kept short. The SOS sheet carries the long version;
        here it only needs to stop anyone believing the police read this feed.
      */}
      <p className={styles.advisory}>
        <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <span>
          Reports come from Find Me users and are not verified. No security
          agency receives them yet — for anything urgent, call 112.
          {feed && !feed.durable && (
            <> The report database is not configured, so reports here may disappear.</>
          )}
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function IncidentRow({
  incident,
  location,
  onShowOnMap,
  onConfirmed,
}: {
  incident: PublicIncident;
  location: LatLng | null;
  onShowOnMap: (point: LatLng, label: string) => void;
  onConfirmed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const confirm = async () => {
    setConfirming(true);
    try {
      const response = await fetch(`/api/incidents/${incident.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceId() }),
      });
      if (response.ok) {
        setConfirmed(true);
        onConfirmed();
      }
    } finally {
      setConfirming(false);
    }
  };

  const label = INCIDENT_LABEL[incident.kind] ?? "Report";
  const trust =
    incident.confirmations >= 3
      ? { text: `Confirmed by ${incident.confirmations}`, level: "high" }
      : incident.confirmations > 0
        ? { text: `${incident.confirmations} confirmed`, level: "some" }
        : { text: "Unconfirmed · one report", level: "none" };

  return (
    <div className={styles.incident}>
      <button
        type="button"
        className={styles.incidentMain}
        onClick={() => onShowOnMap(incident.point, label)}
      >
        <span className={styles.incidentIcon} data-kind={incident.kind}>
          {iconFor(incident.kind)}
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowName}>{label}</span>
          <span className={styles.rowMeta}>
            {incident.area ? `${incident.area} · ` : ""}
            {ago(incident.at)}
          </span>
          {incident.note && <span className={styles.incidentNote}>{incident.note}</span>}
          <span className={styles.trust} data-level={trust.level}>
            {trust.text}
          </span>
        </span>
        {location && (
          <span className={styles.rowDistance}>
            {distanceText(distanceMetres(location, incident.point))}
          </span>
        )}
      </button>

      <button
        type="button"
        className={styles.confirm}
        onClick={() => void confirm()}
        disabled={confirming || confirmed}
      >
        {confirmed ? <Check size={13} /> : null}
        {confirmed ? "Thanks" : "I saw this too"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReportForm({
  location,
  area,
  onDone,
  onCancel,
}: {
  location: LatLng;
  area: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<IncidentKind | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!kind) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          note,
          point: location,
          area: area && area !== "Locating…" ? area : null,
          deviceId: deviceId(),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onDone();
    } catch {
      setError("Could not send the report. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }, [area, kind, location, note, onDone]);

  return (
    <div className={styles.form}>
      <div className={styles.formHead}>
        <strong>What did you see?</strong>
        <button type="button" className={styles.iconButton} onClick={onCancel} title="Cancel">
          <X size={15} />
          <span className="sr-only">Cancel</span>
        </button>
      </div>

      <div className={styles.kindGrid}>
        {REPORT_KINDS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={styles.kind}
            data-selected={kind === entry}
            onClick={() => setKind(entry)}
          >
            {iconFor(entry)}
            {INCIDENT_LABEL[entry]}
          </button>
        ))}
      </div>

      <textarea
        className={styles.textarea}
        placeholder="Optional: what happened, which direction, anything that helps (no names)"
        value={note}
        maxLength={400}
        rows={2}
        onChange={(event) => setNote(event.target.value)}
      />

      <p className={styles.formNote}>
        Pinned at your current location. Reports are anonymous and expire after
        12 hours. Please only report what you saw yourself.
      </p>

      {error && <p className={styles.formError}>{error}</p>}

      <button
        type="button"
        className={styles.submit}
        onClick={() => void submit()}
        disabled={!kind || sending}
      >
        {sending ? (
          <Loader2 size={15} style={{ animation: "fm-spin 0.8s linear infinite" }} />
        ) : null}
        {sending ? "Sending…" : "Post report"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function iconFor(kind: IncidentKind) {
  switch (kind) {
    case "fire":
      return <Flame size={15} aria-hidden="true" />;
    case "flood":
      return <Waves size={15} aria-hidden="true" />;
    case "robbery":
    case "kidnapping":
    case "unrest":
      return <ShieldAlert size={15} aria-hidden="true" />;
    default:
      return <TriangleAlert size={15} aria-hidden="true" />;
  }
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function distanceText(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Fetch the feed. Exported so the page owns polling and the map can use it. */
export async function fetchCommunityFeed(point: LatLng): Promise<CommunityFeed | null> {
  try {
    const response = await fetch(
      `/api/incidents?lat=${point.lat}&lng=${point.lng}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    return (await response.json()) as CommunityFeed;
  } catch {
    return null;
  }
}

/** Poll the feed while `enabled`. Emergencies nearby should not wait on a refresh tap. */
export function useCommunityFeed(point: LatLng | null, enabled: boolean) {
  const [feed, setFeed] = useState<CommunityFeed | null>(null);
  const [loading, setLoading] = useState(false);

  // Coarsen the point so a GPS jitter of a few metres does not refetch.
  const key = point ? `${point.lat.toFixed(3)},${point.lng.toFixed(3)}` : null;

  const refresh = useCallback(async () => {
    if (!point) return;
    setLoading(true);
    const next = await fetchCommunityFeed(point);
    if (next) setFeed(next);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!enabled || !key) return;
    void refresh();
    // Thirty seconds: live alerts nearby must surface without a manual
    // refresh, but a board of reports does not need to be hammered.
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [enabled, key, refresh]);

  return { feed, loading, refresh };
}
