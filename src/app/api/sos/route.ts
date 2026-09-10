/**
 * POST /api/sos — open an emergency alert.
 *
 * The one endpoint in this app that must work when everything else is broken.
 * It touches no model, no geocoder and no routing service: an emergency path
 * that depends on Nominatim's rate limiter or a Gemini quota is not an
 * emergency path. Everything it needs arrives in the request body.
 *
 * It also never returns an error for a *partial* failure. If the store is
 * in-memory, or no agency is connected, or the network to a partner times
 * out, the alert still opens and the response says exactly which channels
 * worked. A 500 here would leave someone staring at a failed button.
 */

import { safetyStore } from "@/lib/safety/store";
import { parseFix } from "@/lib/safety/parse";
import { dispatchAlert, dispatchSummary } from "@/lib/safety/dispatch";
import { COMMUNITY_RADIUS_M, type AlertKind } from "@/lib/safety/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALERT_KINDS: AlertKind[] = [
  "unspecified",
  "medical",
  "crime",
  "accident",
  "fire",
  "lost",
  "harassment",
];

const MAX_NOTE = 500;

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const kind = ALERT_KINDS.includes(body.kind as AlertKind)
    ? (body.kind as AlertKind)
    : "unspecified";

  const fix = parseFix(body.fix);
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : "";
  const locationDescription =
    typeof body.locationDescription === "string"
      ? body.locationDescription.slice(0, MAX_NOTE)
      : null;

  const store = safetyStore();

  let alert;
  try {
    alert = await store.openAlert({ kind, note, fix, locationDescription });
  } catch (error) {
    /*
     * The durable store failed. Do NOT fail the request — fall back to memory
     * so the person still gets a tracking link and a community entry, and say
     * so in the response. A degraded alert beats no alert.
     */
    const { MemorySafetyStore } = await import("@/lib/safety/memory-store");
    alert = await new MemorySafetyStore().openAlert({
      kind,
      note,
      fix,
      locationDescription,
    });
    alert.dispatch = [
      {
        id: "store",
        label: "Alert database",
        status: "unavailable",
        detail: `The alert database rejected this alert (${
          error instanceof Error ? error.message : "unknown error"
        }). Your alert is running in memory only and may not survive. Call 112.`,
      },
    ];
  }

  // How many people would actually see this. Counted, not claimed — the
  // dispatch summary reports zero honestly when nobody is nearby.
  let witnessesNotified = 0;
  if (fix) {
    try {
      const nearby = await store.activeAlertsNear(fix, COMMUNITY_RADIUS_M);
      // Everyone with an active alert nearby, minus this one.
      witnessesNotified = Math.max(0, nearby.length - 1);
    } catch {
      witnessesNotified = 0;
    }
  }

  const trackUrl = `${originOf(request)}/track/${alert.id}?t=${alert.token}`;

  const channels = await dispatchAlert({
    alert,
    trackUrl,
    witnessesNotified,
  });

  const dispatch = [...alert.dispatch, ...channels];
  await store.recordDispatch(alert.id, dispatch).catch(() => undefined);

  return Response.json({
    id: alert.id,
    token: alert.token,
    trackUrl,
    openedAt: alert.openedAt,
    durable: store.durable,
    dispatch,
    summary: dispatchSummary(dispatch),
  });
}

/**
 * The absolute origin this request arrived on.
 *
 * The tracking link is sent to someone else's phone, so a relative URL is
 * useless. `x-forwarded-*` is what Vercel sets; `request.url` is the fallback
 * for localhost.
 */
function originOf(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}
