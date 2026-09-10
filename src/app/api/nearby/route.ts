/**
 * GET /api/nearby?lat=..&lng=..&category=..&radius=..
 *
 * Category browse for the Explore tab.
 *
 * Deliberately independent of the assistant. Browsing by category needs no
 * language understanding at all, so making it go through the AI would add
 * latency, add cost, and — most importantly — make a core part of the product
 * stop working the moment there is no API key or the model is rate-limited.
 * Explore works on an empty .env.
 */

import { buildProviders } from "@/lib/providers/registry";
import { distanceMetres } from "@/lib/geo/distance";
import { DEFAULT_CITY } from "@/lib/geo/cities";

export const runtime = "nodejs";

const MAX_RADIUS_M = 10_000;
const DEFAULT_RADIUS_M = 2_500;

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const lat = Number.parseFloat(searchParams.get("lat") ?? "");
  const lng = Number.parseFloat(searchParams.get("lng") ?? "");

  const centre =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : DEFAULT_CITY.centre;

  const category = (searchParams.get("category") ?? "").trim();

  const requested = Number.parseInt(searchParams.get("radius") ?? "", 10);
  const radiusM = Number.isFinite(requested)
    ? Math.min(MAX_RADIUS_M, Math.max(200, requested))
    : DEFAULT_RADIUS_M;

  try {
    const providers = buildProviders();

    /*
     * Widen once before giving up.
     *
     * Abuja is spread out and POI density varies enormously by district —
     * a pharmacy search around Maitama found nothing at 2.5km while Garki
     * found two. "Nothing nearby" is a much worse answer than "the nearest is
     * 4km away", and the user can judge whether that is too far far better
     * than an arbitrary radius can.
     */
    let results = await providers.places.nearbySearch({
      center: centre,
      radiusM,
      keyword: category || undefined,
      maxResults: 20,
    });

    let usedRadiusM = radiusM;

    if (results.length === 0 && radiusM < MAX_RADIUS_M) {
      usedRadiusM = Math.min(MAX_RADIUS_M, radiusM * 2.5);
      results = await providers.places.nearbySearch({
        center: centre,
        radiusM: usedRadiusM,
        keyword: category || undefined,
        maxResults: 20,
      });
    }

    const places = results
      .map((place) => ({
        name: place.name,
        address: place.formattedAddress || null,
        point: place.point,
        distanceM: Math.round(distanceMetres(centre, place.point)),
        types: place.types,
      }))
      // Nearest first is what a list of nearby things is for.
      .sort((a, b) => a.distanceM - b.distanceM);

    return Response.json({
      centre,
      radiusM: usedRadiusM,
      widened: usedRadiusM !== radiusM,
      category: category || null,
      count: places.length,
      places,
      // Said explicitly so the UI can distinguish "nothing there" from
      // "nothing mapped", which are very different messages to show a user.
      note:
        places.length === 0
          ? "No results. OpenStreetMap coverage is uneven in Nigeria, so this may mean the category is unmapped here rather than absent."
          : null,
    });
  } catch (error) {
    console.error("Nearby search failed:", error);
    return Response.json(
      { error: "Search failed. Try again." },
      { status: 502 },
    );
  }
}
