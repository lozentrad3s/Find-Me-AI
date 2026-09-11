/**
 * POST /api/route — plan a trip directly, without the assistant.
 *
 * The "Directions" button on a place card, and rerouting when someone leaves
 * the route, both know exactly where to go. Sending that through a language
 * model would add seconds and spend quota to produce a result that is already
 * fully determined, so this runs the same trip planner the assistant's
 * plan_trip tool uses and returns the plan plus a spoken summary.
 *
 * Body: { from: {lat,lng}, to: {lat,lng}, name?: string, mode?: "driving"|"walking"|"cycling" }
 */

import { planTrip } from "@/lib/trip/plan";
import { phraseTrip } from "@/lib/ai/templates";
import { NoTrafficProvider } from "@/lib/traffic/types";
import { TomTomTrafficProvider } from "@/lib/traffic/tomtom";
import type { TravelMode } from "@/lib/routing/osrm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readPoint(value: unknown): { lat: number; lng: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const from = readPoint(body.from);
  const to = readPoint(body.to);
  if (!from || !to) {
    return Response.json({ error: "'from' and 'to' must be {lat, lng}." }, { status: 400 });
  }

  const mode: TravelMode =
    body.mode === "walking" || body.mode === "cycling" || body.mode === "driving"
      ? body.mode
      : "driving";

  const key = process.env.TOMTOM_API_KEY?.trim();

  const plan = await planTrip({
    origin: from,
    destination: to,
    destinationName: typeof body.name === "string" ? body.name.slice(0, 120) : null,
    mode,
    traffic: key ? new TomTomTrafficProvider(key) : new NoTrafficProvider(),
  });

  if ("error" in plan) {
    return Response.json({ error: plan.error }, { status: 502 });
  }

  return Response.json(
    { plan, summary: phraseTrip(plan) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
