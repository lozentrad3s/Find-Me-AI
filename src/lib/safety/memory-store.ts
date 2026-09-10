/**
 * In-memory safety store — development, and the honest fallback in production.
 *
 * WHY THIS EXISTS AND WHY IT REPORTS ITSELF AS NOT DURABLE
 *
 * The whole safety feature has to be buildable and testable before anyone has
 * a database, or it never gets built. This store makes that possible: every
 * route, the tracking page, the community feed and the responder view all work
 * against it on localhost with no configuration at all.
 *
 * What it must never do is pass for the real thing. On Vercel each request may
 * land on a different instance and instances recycle without warning, so an
 * alert written here can be gone from the next request — the tracking link
 * would 404 while someone is in trouble. `durable` is false, and every surface
 * that opens an alert reads that flag and tells the user plainly. The fix is
 * Supabase credentials, not a cleverer cache.
 */

import { randomUUID, randomBytes } from "node:crypto";

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import {
  ALERT_MAX_AGE_MS,
  INCIDENT_MAX_AGE_MS,
  type DispatchChannel,
  type FileIncidentInput,
  type IncidentReport,
  type LocationFix,
  type OpenAlertInput,
  type SafetyStore,
  type SosAlert,
} from "./types";

/**
 * Cap the trail so a long alert cannot grow without bound.
 *
 * At one fix every five seconds this is a little over two hours of history,
 * and the *oldest* fixes are dropped rather than the newest — where someone is
 * now matters more than where they were two hours ago.
 */
const MAX_TRAIL = 1_500;

/*
 * On globalThis, not at module level.
 *
 * Found by testing: Next.js compiles each route as its own entry, so a plain
 * module-level Map is a DIFFERENT Map in `/api/sos` than in
 * `/api/sos/[id]/ping`. An alert opened by one route was invisible to the
 * next, and every position update came back "alert is not active" — the
 * tracking link would have frozen on its first fix. Hanging the maps off
 * globalThis shares them across every route in the process.
 *
 * It does not share them across processes, which is the limit this store can
 * never get past: on Vercel the open and the ping can land on different
 * instances. That is why `durable` is false and why Supabase is required
 * before this goes in front of anyone who needs it.
 */
const shared = globalThis as typeof globalThis & {
  __findMeSafety?: {
    alerts: Map<string, SosAlert>;
    incidents: Map<string, IncidentReport>;
    confirmers: Map<string, Set<string>>;
  };
};

shared.__findMeSafety ??= {
  alerts: new Map(),
  incidents: new Map(),
  confirmers: new Map(),
};
// An instance created before `confirmers` existed (hot reload) lacks it.
shared.__findMeSafety.confirmers ??= new Map();

const alerts = shared.__findMeSafety.alerts;
const incidents = shared.__findMeSafety.incidents;
/**
 * Who has confirmed each report, by reporter hash.
 *
 * Kept apart from the report itself so it can never leak through
 * `PublicIncident`, which is the report minus only `reporterHash`.
 */
const confirmers = shared.__findMeSafety.confirmers;

export function newAlertToken(): string {
  // 32 hex characters. The tracking link is the credential, so this needs to
  // be unguessable, not merely unique.
  return randomBytes(16).toString("hex");
}

export class MemorySafetyStore implements SafetyStore {
  readonly durable = false;
  readonly name = "memory";

  async openAlert(input: OpenAlertInput): Promise<SosAlert> {
    const now = Date.now();
    const alert: SosAlert = {
      id: randomUUID(),
      token: newAlertToken(),
      kind: input.kind,
      status: "active",
      note: input.note,
      openedAt: now,
      resolvedAt: null,
      lastFix: input.fix,
      trail: input.fix ? [input.fix] : [],
      locationDescription: input.locationDescription,
      dispatch: [],
      durable: false,
    };

    alerts.set(alert.id, alert);
    sweep();
    return alert;
  }

  async getAlert(id: string): Promise<SosAlert | null> {
    sweep();
    return alerts.get(id) ?? null;
  }

  async appendFix(id: string, fix: LocationFix): Promise<SosAlert | null> {
    const alert = alerts.get(id);
    if (!alert || alert.status !== "active") return null;

    alert.trail.push(fix);
    if (alert.trail.length > MAX_TRAIL) {
      alert.trail.splice(0, alert.trail.length - MAX_TRAIL);
    }
    alert.lastFix = fix;
    return alert;
  }

  async resolveAlert(id: string): Promise<SosAlert | null> {
    const alert = alerts.get(id);
    if (!alert) return null;

    alert.status = "resolved";
    alert.resolvedAt = Date.now();
    return alert;
  }

  async recordDispatch(id: string, channels: DispatchChannel[]): Promise<void> {
    const alert = alerts.get(id);
    if (alert) alert.dispatch = channels;
  }

  async activeAlertsNear(point: LatLng, radiusM: number): Promise<SosAlert[]> {
    sweep();
    return [...alerts.values()]
      .filter(
        (alert) =>
          alert.status === "active" &&
          alert.lastFix !== null &&
          distanceMetres(point, alert.lastFix) <= radiusM,
      )
      .sort((a, b) => b.openedAt - a.openedAt);
  }

  async fileIncident(input: FileIncidentInput): Promise<IncidentReport> {
    const report: IncidentReport = {
      id: randomUUID(),
      kind: input.kind,
      point: input.point,
      area: input.area,
      note: input.note,
      at: Date.now(),
      confirmations: 0,
      reporterHash: input.reporterHash,
      fromAlertId: input.fromAlertId ?? null,
    };

    incidents.set(report.id, report);
    sweep();
    return report;
  }

  async incidentsNear(
    point: LatLng,
    radiusM: number,
    sinceMs: number,
  ): Promise<IncidentReport[]> {
    sweep();
    return [...incidents.values()]
      .filter(
        (report) =>
          report.at >= sinceMs && distanceMetres(point, report.point) <= radiusM,
      )
      .sort((a, b) => b.at - a.at);
  }

  async confirmIncident(
    id: string,
    reporterHash: string,
  ): Promise<IncidentReport | null> {
    const report = incidents.get(id);
    if (!report) return null;

    // You cannot corroborate your own report. Without this, one device could
    // manufacture a "confirmed" incident, which is precisely the abuse that
    // would make the community map untrustworthy.
    if (report.reporterHash === reporterHash) return report;

    /*
     * One confirmation per device.
     *
     * Found by testing: this used to increment on every call, so one phone
     * tapping "I saw this too" five times turned a single rumour into a
     * "confirmed by 5" hazard. The Supabase store enforces this with a unique
     * constraint; this is the same rule for the store that has no database.
     */
    let seen = confirmers.get(id);
    if (!seen) {
      seen = new Set();
      confirmers.set(id, seen);
    }
    if (seen.has(reporterHash)) return report;

    seen.add(reporterHash);
    report.confirmations = seen.size;
    return report;
  }
}

/** Drop what has aged out. Cheap enough to run on every access at this size. */
function sweep(): void {
  const now = Date.now();

  for (const [id, alert] of alerts) {
    if (alert.status === "active" && now - alert.openedAt > ALERT_MAX_AGE_MS) {
      alert.status = "expired";
    }
    // Keep resolved alerts briefly so the tracking page can say "stood down"
    // instead of 404ing on someone who is still watching the link.
    if (alert.status !== "active" && now - alert.openedAt > ALERT_MAX_AGE_MS * 2) {
      alerts.delete(id);
    }
  }

  for (const [id, report] of incidents) {
    if (now - report.at > INCIDENT_MAX_AGE_MS) {
      incidents.delete(id);
      confirmers.delete(id);
    }
  }
}
