/**
 * Safety domain — SOS alerts and community incident reports.
 *
 * This is the one part of the product where being wrong is not an inconvenience.
 * Two rules shape every type here:
 *
 * 1. NOTHING CLAIMS A DELIVERY IT DID NOT MAKE. Every dispatch channel carries
 *    an explicit status and a reason. "Sent" means a request succeeded. If an
 *    SMS gateway is not configured, the channel reports `unavailable` with the
 *    reason, and the UI shows that to the person in trouble. A safety screen
 *    that implies help is coming when it is not is worse than no screen.
 *
 * 2. DURABILITY IS PART OF THE DATA. An alert held in a serverless process's
 *    memory disappears when that instance recycles — which can be seconds. The
 *    store reports whether it is durable, and an alert that is not durable says
 *    so on the screen rather than looking identical to one that is.
 */

import type { LatLng } from "@/lib/geo/distance";

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/** One position report on an active alert. */
export interface LocationFix {
  lat: number;
  lng: number;
  /** GPS accuracy radius in metres, when the device reported one. */
  accuracyM: number | null;
  /** Degrees clockwise from north, when derived from movement. */
  heading: number | null;
  /** Metres per second, when derived from movement. */
  speedMps: number | null;
  /** Epoch milliseconds. */
  at: number;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertStatus = "active" | "resolved" | "expired";

/**
 * What kind of trouble, in the words a Nigerian caller would use.
 *
 * This is not decoration. A dispatcher triages on category, and "medical" and
 * "armed robbery" produce different responses from different units. Kept short
 * because someone selecting this is under stress.
 */
export type AlertKind =
  | "unspecified"
  | "medical"
  | "crime"
  | "accident"
  | "fire"
  | "lost"
  | "harassment";

export interface SosAlert {
  id: string;
  /**
   * Unguessable token that grants read access to this alert's live position.
   *
   * The tracking link is the product: you send it to your brother and he
   * watches you move. That means the link IS the credential, so it must be
   * long, random, and revoked when the alert resolves.
   */
  token: string;
  kind: AlertKind;
  status: AlertStatus;
  /** Free text the person typed or dictated. May be empty — often will be. */
  note: string;
  /** Epoch milliseconds. */
  openedAt: number;
  resolvedAt: number | null;
  /** Most recent position. Null when location permission was refused. */
  lastFix: LocationFix | null;
  /** Position history, oldest first — the trail a responder follows. */
  trail: LocationFix[];
  /** Human-readable position from the surroundings scan, when available. */
  locationDescription: string | null;
  /** What was attempted, and what actually happened. */
  dispatch: DispatchChannel[];
  /** Set when the alert was opened without a durable store behind it. */
  durable: boolean;
}

/** What the caller supplies to open an alert. */
export interface OpenAlertInput {
  kind: AlertKind;
  note: string;
  fix: LocationFix | null;
  locationDescription: string | null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * `sent` — a request went out and succeeded.
 * `manual` — it works, but the person has to press the button (dialling 112).
 * `unavailable` — it cannot happen right now, and `detail` says why.
 */
export type DispatchStatus = "sent" | "manual" | "unavailable";

export interface DispatchChannel {
  id: string;
  /** What this reaches, in plain words. */
  label: string;
  status: DispatchStatus;
  /** Why it is in that state. Shown to the user verbatim when not `sent`. */
  detail: string;
  /** A `tel:` or `sms:` URI for `manual` channels. */
  action?: string;
}

// ---------------------------------------------------------------------------
// Community reports
// ---------------------------------------------------------------------------

export type IncidentKind =
  | "robbery"
  | "kidnapping"
  | "accident"
  | "fire"
  | "flood"
  | "roadblock"
  | "unrest"
  | "suspicious"
  | "other";

export interface IncidentReport {
  id: string;
  kind: IncidentKind;
  point: LatLng;
  /** Neighbourhood name from reverse geocoding, for display and for search. */
  area: string | null;
  note: string;
  /** Epoch milliseconds. */
  at: number;
  /**
   * How many other people confirmed this.
   *
   * A single anonymous report is a rumour. Confirmations are what turn it into
   * something worth routing around, and the UI grades its own confidence on
   * this rather than presenting every report as equally true.
   */
  confirmations: number;
  /**
   * Opaque per-device identifier, hashed.
   *
   * Present so one device cannot confirm its own report or spam ten identical
   * ones, and for nothing else. It is never returned to clients.
   */
  reporterHash: string;
  /** Set when a report came from an SOS alert rather than a manual filing. */
  fromAlertId: string | null;
}

export interface FileIncidentInput {
  kind: IncidentKind;
  point: LatLng;
  area: string | null;
  note: string;
  reporterHash: string;
  fromAlertId?: string | null;
}

/** What clients receive — `reporterHash` deliberately absent. */
export type PublicIncident = Omit<IncidentReport, "reporterHash">;

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

export interface SafetyStore {
  /**
   * False for the in-memory store.
   *
   * Serverless instances recycle without warning, so an in-memory alert can
   * vanish mid-emergency. Callers surface this rather than hiding it.
   */
  readonly durable: boolean;
  /** For diagnostics and the health endpoint. */
  readonly name: string;

  openAlert(input: OpenAlertInput): Promise<SosAlert>;
  getAlert(id: string): Promise<SosAlert | null>;
  appendFix(id: string, fix: LocationFix): Promise<SosAlert | null>;
  resolveAlert(id: string): Promise<SosAlert | null>;
  recordDispatch(id: string, channels: DispatchChannel[]): Promise<void>;
  /** Active alerts within `radiusM` of a point — the responder view. */
  activeAlertsNear(point: LatLng, radiusM: number): Promise<SosAlert[]>;

  fileIncident(input: FileIncidentInput): Promise<IncidentReport>;
  incidentsNear(
    point: LatLng,
    radiusM: number,
    sinceMs: number,
  ): Promise<IncidentReport[]>;
  confirmIncident(id: string, reporterHash: string): Promise<IncidentReport | null>;
}

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/**
 * An alert nobody stood down goes stale rather than staying "active" forever.
 *
 * Six hours: long enough to cover a genuine ordeal, short enough that a
 * forgotten alert does not sit on the community map for days telling people
 * there is an emergency at a bus stop where there is not.
 */
export const ALERT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a community report stays on the map.
 *
 * Twelve hours. A roadblock this morning is worth knowing about; a robbery
 * reported last Tuesday is history, not a live hazard, and leaving it up makes
 * the map look alarming in a way that stops being informative.
 */
export const INCIDENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Default radius for "what is happening around me". */
export const COMMUNITY_RADIUS_M = 5_000;
