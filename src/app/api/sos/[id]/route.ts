/**
 * GET /api/sos/[id]?t=<token> — read an active alert.
 *
 * This is what the tracking page polls, and it is the only endpoint anyone
 * other than the person in trouble ever calls. It is unauthenticated by
 * design: the whole point is that you send the link to your brother and he
 * opens it, and requiring him to make an account first would make the feature
 * useless at the moment it matters.
 *
 * The token is therefore the credential, and this route treats it like one:
 * constant-time comparison, no information leaked on a bad token beyond 404,
 * and nothing in the response that is not needed to follow someone on a map.
 */

import { timingSafeEqual } from "node:crypto";

import { safetyStore } from "@/lib/safety/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("t") ?? "";

  const alert = await safetyStore()
    .getAlert(id)
    .catch(() => null);

  /*
   * Same 404 for "no such alert" and "wrong token".
   *
   * Distinguishing them would let someone confirm that a given alert id
   * exists — which, for a feature whose users are people in danger, is not a
   * detail worth leaking to anyone holding a guessed id.
   */
  if (!alert || !tokensMatch(alert.token, token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  return Response.json(
    {
      id: alert.id,
      kind: alert.kind,
      status: alert.status,
      note: alert.note,
      openedAt: alert.openedAt,
      resolvedAt: alert.resolvedAt,
      lastFix: alert.lastFix,
      trail: alert.trail,
      locationDescription: alert.locationDescription,
      durable: alert.durable,
      // Whoever is watching should see what was and was not dispatched, so
      // they know whether to start calling people themselves.
      dispatch: alert.dispatch,
    },
    // Never cached. A cached emergency position is a wrong emergency position.
    { headers: { "Cache-Control": "no-store" } },
  );
}

function tokensMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}
