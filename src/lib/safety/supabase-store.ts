/**
 * Durable safety store, on Supabase.
 *
 * Talks to PostgREST directly over `fetch` rather than pulling in
 * `@supabase/supabase-js`. The client library is good, but everything needed
 * here is four verbs against three tables, and a safety path is the last place
 * to add a dependency whose failure modes are not fully understood. Straight
 * HTTP also means the error a route logs is the error Postgres actually
 * returned.
 *
 * Uses the SERVICE ROLE key, so it must only ever run in a route handler.
 * Nothing in this file may be imported from a client component.
 *
 * Schema lives in supabase/migrations/0002_safety.sql. If the migration has
 * not been applied, every call here fails — which the caller turns into a
 * visible "not durable" state rather than a silent one.
 */

import { randomBytes } from "node:crypto";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import {
  ALERT_MAX_AGE_MS,
  type DispatchChannel,
  type FileIncidentInput,
  type IncidentReport,
  type LocationFix,
  type OpenAlertInput,
  type SafetyStore,
  type SosAlert,
} from "./types";

/** Same reasoning as the memory store: newest fixes matter most. */
const MAX_TRAIL = 1_500;

interface AlertRow {
  id: string;
  token: string;
  kind: string;
  status: string;
  note: string | null;
  opened_at: string;
  resolved_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_accuracy_m: number | null;
  last_heading: number | null;
  last_speed_mps: number | null;
  last_fix_at: string | null;
  location_description: string | null;
  dispatch: DispatchChannel[] | null;
  trail: LocationFix[] | null;
}

interface IncidentRow {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  area: string | null;
  note: string | null;
  at: string;
  confirmations: number;
  reporter_hash: string;
  from_alert_id: string | null;
}

export class SupabaseSafetyStore implements SafetyStore {
  readonly durable = true;
  readonly name = "supabase";

  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
  ) {}

  // --- HTTP -----------------------------------------------------------------

  private async request<T>(
    path: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
    };
    if (init.prefer) headers.Prefer = init.prefer;

    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
      // A safety write must not be served from a cache, ever.
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Supabase ${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 300)}`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // --- Alerts ---------------------------------------------------------------

  async openAlert(input: OpenAlertInput): Promise<SosAlert> {
    const token = randomBytes(16).toString("hex");

    const rows = await this.request<AlertRow[]>("sos_alerts", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({
        token,
        kind: input.kind,
        status: "active",
        note: input.note,
        last_lat: input.fix?.lat ?? null,
        last_lng: input.fix?.lng ?? null,
        last_accuracy_m: input.fix?.accuracyM ?? null,
        last_heading: input.fix?.heading ?? null,
        last_speed_mps: input.fix?.speedMps ?? null,
        last_fix_at: input.fix ? new Date(input.fix.at).toISOString() : null,
        location_description: input.locationDescription,
        dispatch: [],
        trail: input.fix ? [input.fix] : [],
      }),
    });

    const row = rows[0];
    if (!row) throw new Error("Supabase returned no row when opening an alert.");
    return toAlert(row);
  }

  async getAlert(id: string): Promise<SosAlert | null> {
    const rows = await this.request<AlertRow[]>(
      `sos_alerts?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    );
    const row = rows[0];
    if (!row) return null;

    const alert = toAlert(row);
    // Age out on read rather than needing a scheduled job — a stale "active"
    // alert on the community map is a false emergency.
    if (
      alert.status === "active" &&
      Date.now() - alert.openedAt > ALERT_MAX_AGE_MS
    ) {
      alert.status = "expired";
    }
    return alert;
  }

  async appendFix(id: string, fix: LocationFix): Promise<SosAlert | null> {
    const current = await this.getAlert(id);
    if (!current || current.status !== "active") return null;

    /*
     * Read-modify-write on the trail array.
     *
     * Two pings racing could lose a fix. That is acceptable here and a
     * separate fixes table is not: position reports are highly redundant by
     * design — another arrives seconds later — and `last_*` (which is what a
     * responder actually watches) is a plain column update that cannot be
     * lost the same way. Trading a possible gap in history for a much simpler
     * read path on the tracking page is the right side of that trade.
     */
    const trail = [...current.trail, fix].slice(-MAX_TRAIL);

    const rows = await this.request<AlertRow[]>(
      `sos_alerts?id=eq.${encodeURIComponent(id)}&status=eq.active`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify({
          last_lat: fix.lat,
          last_lng: fix.lng,
          last_accuracy_m: fix.accuracyM,
          last_heading: fix.heading,
          last_speed_mps: fix.speedMps,
          last_fix_at: new Date(fix.at).toISOString(),
          trail,
        }),
      },
    );

    const row = rows[0];
    return row ? toAlert(row) : null;
  }

  async resolveAlert(id: string): Promise<SosAlert | null> {
    const rows = await this.request<AlertRow[]>(
      `sos_alerts?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify({
          status: "resolved",
          resolved_at: new Date().toISOString(),
        }),
      },
    );

    const row = rows[0];
    return row ? toAlert(row) : null;
  }

  async recordDispatch(id: string, channels: DispatchChannel[]): Promise<void> {
    await this.request<AlertRow[]>(`sos_alerts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ dispatch: channels }),
    });
  }

  async activeAlertsNear(point: LatLng, radiusM: number): Promise<SosAlert[]> {
    /*
     * Bounding box in SQL, exact distance in JS.
     *
     * PostGIS would do this properly, but it is an extension the user may not
     * have enabled and this feature must work on a default Supabase project.
     * A degree box is a cheap prefilter; the count that survives it at these
     * radii is small enough that the precise pass costs nothing.
     */
    const box = boundingBox(point, radiusM);
    const since = new Date(Date.now() - ALERT_MAX_AGE_MS).toISOString();

    const rows = await this.request<AlertRow[]>(
      `sos_alerts?status=eq.active&opened_at=gte.${since}` +
        `&last_lat=gte.${box.minLat}&last_lat=lte.${box.maxLat}` +
        `&last_lng=gte.${box.minLng}&last_lng=lte.${box.maxLng}` +
        `&select=*&order=opened_at.desc&limit=100`,
    );

    return rows
      .map(toAlert)
      .filter(
        (alert) =>
          alert.lastFix !== null &&
          distanceMetres(point, alert.lastFix) <= radiusM,
      );
  }

  // --- Incidents ------------------------------------------------------------

  async fileIncident(input: FileIncidentInput): Promise<IncidentReport> {
    const rows = await this.request<IncidentRow[]>("incident_reports", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({
        kind: input.kind,
        lat: input.point.lat,
        lng: input.point.lng,
        area: input.area,
        note: input.note,
        reporter_hash: input.reporterHash,
        from_alert_id: input.fromAlertId ?? null,
        confirmations: 0,
      }),
    });

    const row = rows[0];
    if (!row) throw new Error("Supabase returned no row when filing an incident.");
    return toIncident(row);
  }

  async incidentsNear(
    point: LatLng,
    radiusM: number,
    sinceMs: number,
  ): Promise<IncidentReport[]> {
    const box = boundingBox(point, radiusM);

    const rows = await this.request<IncidentRow[]>(
      `incident_reports?at=gte.${new Date(sinceMs).toISOString()}` +
        `&lat=gte.${box.minLat}&lat=lte.${box.maxLat}` +
        `&lng=gte.${box.minLng}&lng=lte.${box.maxLng}` +
        `&select=*&order=at.desc&limit=200`,
    );

    return rows
      .map(toIncident)
      .filter((report) => distanceMetres(point, report.point) <= radiusM);
  }

  async confirmIncident(
    id: string,
    reporterHash: string,
  ): Promise<IncidentReport | null> {
    /*
     * A database function, not a read-then-increment from here.
     *
     * "How many people confirmed this" is the only number that separates a
     * rumour from a hazard worth routing around, so it has to be hard to
     * inflate. `confirm_incident` enforces both rules where they cannot be
     * raced: one confirmation per device (unique constraint) and never your
     * own report (checked in the same transaction). Doing it in TypeScript
     * would let two taps a millisecond apart both pass the check.
     */
    const rows = await this.request<IncidentRow[]>("rpc/confirm_incident", {
      method: "POST",
      body: JSON.stringify({ p_id: id, p_hash: reporterHash }),
    });

    const row = Array.isArray(rows) ? rows[0] : (rows as IncidentRow | undefined);
    return row ? toIncident(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toAlert(row: AlertRow): SosAlert {
  const lastFix: LocationFix | null =
    row.last_lat !== null && row.last_lng !== null
      ? {
          lat: row.last_lat,
          lng: row.last_lng,
          accuracyM: row.last_accuracy_m,
          heading: row.last_heading,
          speedMps: row.last_speed_mps,
          at: row.last_fix_at ? Date.parse(row.last_fix_at) : Date.parse(row.opened_at),
        }
      : null;

  return {
    id: row.id,
    token: row.token,
    kind: (row.kind as SosAlert["kind"]) ?? "unspecified",
    status: (row.status as SosAlert["status"]) ?? "active",
    note: row.note ?? "",
    openedAt: Date.parse(row.opened_at),
    resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : null,
    lastFix,
    trail: row.trail ?? [],
    locationDescription: row.location_description,
    dispatch: row.dispatch ?? [],
    durable: true,
  };
}

function toIncident(row: IncidentRow): IncidentReport {
  return {
    id: row.id,
    kind: (row.kind as IncidentReport["kind"]) ?? "other",
    point: { lat: row.lat, lng: row.lng },
    area: row.area,
    note: row.note ?? "",
    at: Date.parse(row.at),
    confirmations: row.confirmations ?? 0,
    reporterHash: row.reporter_hash,
    fromAlertId: row.from_alert_id,
  };
}

/** Degree box that certainly contains the circle. Prefilter only. */
function boundingBox(point: LatLng, radiusM: number) {
  const latDelta = radiusM / 111_320;
  // Longitude degrees shrink with latitude; the guard keeps this finite near
  // the poles, which Nigeria is not, but the code should not depend on that.
  const lngDelta =
    radiusM / (111_320 * Math.max(0.01, Math.cos((point.lat * Math.PI) / 180)));

  return {
    minLat: point.lat - latDelta,
    maxLat: point.lat + latDelta,
    minLng: point.lng - lngDelta,
    maxLng: point.lng + lngDelta,
  };
}
