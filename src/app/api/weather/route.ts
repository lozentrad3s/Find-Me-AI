/**
 * GET /api/weather?lat=..&lng=..
 *
 * Proxied server-side for the same reason as every other provider: one place
 * to cache, one place to rate-limit, and no third-party endpoint baked into
 * the client where it cannot be changed without a redeploy.
 */

import { getWeather } from "@/lib/weather/open-meteo";
import { DEFAULT_CITY } from "@/lib/geo/cities";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const lat = Number.parseFloat(searchParams.get("lat") ?? "");
  const lng = Number.parseFloat(searchParams.get("lng") ?? "");

  // Falling back to the city centre rather than erroring: the home screen
  // shows weather before location permission is granted, and "Abuja is 27°"
  // is far more useful there than an empty card.
  const point =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : DEFAULT_CITY.centre;

  const report = await getWeather(point);

  if (!report) {
    return Response.json(
      { error: "Weather is unavailable right now." },
      { status: 503 },
    );
  }

  return Response.json(report, {
    headers: {
      // Conditions change slowly; let the browser hold onto this.
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
