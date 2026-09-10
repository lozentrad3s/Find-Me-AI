/**
 * POST /api/sos/[id]/resolve — stand down an alert.
 *
 * Requires the token, because standing down someone else's emergency is the
 * one write on this feature with a genuinely harmful abuse case: silence the
 * alert and the community map stops showing it and the tracking link goes
 * quiet. The person in trouble has the token; nobody else needs this.
 */

import { timingSafeEqual } from "node:crypto";

import { safetyStore } from "@/lib/safety/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let token = new URL(request.url).searchParams.get("t") ?? "";
  if (!token) {
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token === "string") token = body.token;
  }

  const store = safetyStore();
  const alert = await store.getAlert(id).catch(() => null);

  if (!alert || !tokensMatch(alert.token, token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const resolved = await store.resolveAlert(id).catch(() => null);

  return Response.json(
    { ok: true, status: resolved?.status ?? "resolved" },
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
