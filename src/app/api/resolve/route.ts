/**
 * POST /api/resolve
 *
 * The resolution engine as an HTTP endpoint. This is the seam the React Native
 * app will call at V0.4, and the same shape the Resolution API would sell to
 * logistics customers (Part IX) — which is why it takes a phrase and context
 * and returns the full reasoning, not just a point. A caller that cannot see
 * the confidence band cannot use this safely.
 *
 * All Places and Geocoding traffic is server-side here by construction
 * (Part V, decision 1). No provider key ever reaches the client.
 */

import { NextResponse } from "next/server";

import { buildProviders } from "@/lib/providers/registry";
import { resolvePlace } from "@/lib/resolution/pipeline";
import type { ResolutionContext } from "@/lib/resolution/types";

export const runtime = "nodejs";

interface ResolveBody {
  phrase?: unknown;
  city?: unknown;
  lat?: unknown;
  lng?: unknown;
}

const MAX_PHRASE_LENGTH = 300;

export async function POST(request: Request): Promise<NextResponse> {
  let body: ResolveBody;

  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";

  if (!phrase) {
    return NextResponse.json(
      { error: "A 'phrase' string is required." },
      { status: 400 },
    );
  }

  if (phrase.length > MAX_PHRASE_LENGTH) {
    return NextResponse.json(
      { error: `'phrase' must be ${MAX_PHRASE_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  const context: ResolutionContext = {};

  if (typeof body.city === "string" && body.city.trim()) {
    context.city = body.city.trim();
  }

  // Both or neither — a half-supplied coordinate is a bug in the caller, and
  // silently ignoring it would produce quietly wrong distance weighting.
  const lat = toFiniteNumber(body.lat);
  const lng = toFiniteNumber(body.lng);

  if ((lat === null) !== (lng === null)) {
    return NextResponse.json(
      { error: "Supply both 'lat' and 'lng', or neither." },
      { status: 400 },
    );
  }

  if (lat !== null && lng !== null) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json(
        { error: "'lat' must be within ±90 and 'lng' within ±180." },
        { status: 400 },
      );
    }
    context.currentLocation = { lat, lng };
  }

  try {
    const providers = buildProviders();
    const result = await resolvePlace(phrase, providers, { context });
    return NextResponse.json(result);
  } catch (error) {
    // Provider outages must not leak keys or stack traces to the caller.
    console.error("Resolution failed:", error);
    return NextResponse.json(
      { error: "Resolution failed. Try again." },
      { status: 502 },
    );
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
