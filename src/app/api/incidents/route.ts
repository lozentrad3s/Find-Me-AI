/**
 * /api/incidents — the community security feed.
 *
 * GET  ?lat&lng[&radius] — what has been reported around a point.
 * POST                   — file a report.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a neighbourhood watch board with coordinates. People report what they
 * saw — a robbery at a junction, a roadblock, flooding on a route — and other
 * people nearby see it and can confirm it.
 *
 * It is NOT verified intelligence, and the API never presents it as such.
 * Every report carries its confirmation count so the UI can grade its own
 * confidence, and a single unconfirmed report is rendered as exactly what it
 * is: one person's claim. This matters more here than almost anywhere else in
 * the product — a false "kidnapping reported" pin on a map can start a panic,
 * or worse, get someone accused.
 *
 * Reports are anonymous to readers. The reporter hash exists only to stop one
 * device confirming its own report or filing the same thing ten times, and it
 * never leaves the server.
 */

import { safetyStore } from "@/lib/safety/store";
import { reporterHash } from "@/lib/safety/reporter";
import { parsePoint } from "@/lib/safety/parse";
import {
  COMMUNITY_RADIUS_M,
  INCIDENT_MAX_AGE_MS,
  type IncidentKind,
  type IncidentReport,
  type PublicIncident,
} from "@/lib/safety/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INCIDENT_KINDS: IncidentKind[] = [
  "robbery",
  "kidnapping",
  "accident",
  "fire",
  "flood",
  "roadblock",
  "unrest",
  "suspicious",
  "other",
];

const MAX_NOTE = 400;
/** Beyond this a "nearby" feed stops being about your neighbourhood. */
const MAX_RADIUS_M = 25_000;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return Response.json({ error: "lat and lng are required." }, { status: 400 });
  }

  const radiusM = clamp(
    Number(params.get("radius")) || COMMUNITY_RADIUS_M,
    200,
    MAX_RADIUS_M,
  );

  const store = safetyStore();
  const since = Date.now() - INCIDENT_MAX_AGE_MS;

  const [reports, alerts] = await Promise.all([
    store.incidentsNear({ lat, lng }, radiusM, since).catch(() => []),
    store.activeAlertsNear({ lat, lng }, radiusM).catch(() => []),
  ]);

  return Response.json(
    {
      incidents: reports.map(toPublic),
      /*
       * Live SOS alerts ride in the same response as reports.
       *
       * They are the reason the feed exists — someone in trouble right now is
       * the thing a neighbour most needs to see — but they are a separate
       * array rather than another incident kind, because they are live and
       * moving and the UI must render them differently from a static pin.
       * No token here: this is the neighbour's view, which shows that an
       * emergency is happening and roughly where, not a private tracking feed.
       */
      activeAlerts: alerts.map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        openedAt: alert.openedAt,
        lastFix: alert.lastFix,
        locationDescription: alert.locationDescription,
      })),
      radiusM,
      durable: store.durable,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const point = parsePoint(body.point ?? body);
  if (!point) {
    return Response.json(
      { error: "A valid point is required." },
      { status: 400 },
    );
  }

  const kind = INCIDENT_KINDS.includes(body.kind as IncidentKind)
    ? (body.kind as IncidentKind)
    : "other";

  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : "";
  const area = typeof body.area === "string" ? body.area.slice(0, 120) : null;

  const report = await safetyStore()
    .fileIncident({
      kind,
      point,
      area,
      note,
      reporterHash: reporterHash(request, body.deviceId),
      fromAlertId: typeof body.fromAlertId === "string" ? body.fromAlertId : null,
    })
    .catch(() => null);

  if (!report) {
    return Response.json(
      { error: "The report could not be saved." },
      { status: 503 },
    );
  }

  return Response.json({ incident: toPublic(report) }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPublic(report: IncidentReport): PublicIncident {
  const { reporterHash: _hidden, ...rest } = report;
  return rest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
