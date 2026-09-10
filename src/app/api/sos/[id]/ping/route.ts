/**
 * POST /api/sos/[id]/ping — a position update on an active alert.
 *
 * This is the "our system pays close attention to their location" half. While
 * an alert is active the client posts a fix every few seconds and each one
 * lands here, extending the trail a responder follows.
 *
 * Kept as small as it can possibly be. It runs on a phone that may be moving
 * through poor coverage, so the request body is a handful of numbers and the
 * response is a single flag — anything larger is bytes that might not make it.
 */

import { safetyStore } from "@/lib/safety/store";
import { parseFix } from "@/lib/safety/parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const fix = parseFix(body.fix ?? body);
  if (!fix) {
    return Response.json({ error: "A valid fix is required." }, { status: 400 });
  }

  const alert = await safetyStore()
    .appendFix(id, fix)
    .catch(() => null);

  /*
   * 410, not 404, when the alert is gone or stood down.
   *
   * The client uses this to stop pinging. A 404 would be ambiguous with a
   * routing problem and the phone would keep transmitting a position for an
   * emergency that is over — draining a battery that may matter later.
   */
  if (!alert) {
    return Response.json({ error: "Alert is not active." }, { status: 410 });
  }

  return Response.json(
    { ok: true, status: alert.status, fixes: alert.trail.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
