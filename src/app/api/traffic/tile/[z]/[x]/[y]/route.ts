/**
 * GET /api/traffic/tile/{z}/{x}/{y} — live traffic flow tiles, via the server.
 *
 * TomTom draws congestion onto transparent map tiles: green where traffic
 * flows freely, amber where it slows, red where it queues. Leaflet overlays
 * them on the base map, which is what gives the Google-Maps-style coloured
 * roads.
 *
 * Proxied rather than requested from the browser because the tile URL carries
 * the API key, and "no provider key ever reaches a client" (README). Two
 * guards keep strangers from spending the free tier through this proxy:
 * tiles outside Nigeria are refused, and every tile is cached at the edge for
 * two minutes, so a busy area costs one TomTom request per tile per two
 * minutes however many people are looking.
 */

export const runtime = "nodejs";

/** Nigeria's bounding box, with a margin. */
const BOUNDS = { south: 3.5, north: 14.5, west: 2.0, east: 15.0 };
const STYLES = new Set(["relative0", "relative0-dark"]);

/** A 1x1 transparent PNG, served where there is no tile, so nothing looks broken. */
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function empty(maxAge: number): Response {
  return new Response(new Uint8Array(EMPTY_PNG), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
}

/** Latitude of the north edge of tile row y at zoom z (Web Mercator). */
function tileLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function tileLng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ z: string; x: string; y: string }> },
): Promise<Response> {
  const key = process.env.TOMTOM_API_KEY?.trim();
  if (!key) return empty(300);

  const raw = await params;
  const z = Number.parseInt(raw.z, 10);
  const x = Number.parseInt(raw.x, 10);
  const y = Number.parseInt(raw.y.replace(/\.png$/, ""), 10);

  if (![z, x, y].every(Number.isInteger) || z < 5 || z > 20) return empty(3600);
  const max = 2 ** z;
  if (x < 0 || y < 0 || x >= max || y >= max) return empty(3600);

  const north = tileLat(y, z);
  const south = tileLat(y + 1, z);
  const west = tileLng(x, z);
  const east = tileLng(x + 1, z);

  const outside =
    south > BOUNDS.north || north < BOUNDS.south || west > BOUNDS.east || east < BOUNDS.west;
  if (outside) return empty(86_400);

  const requested = new URL(request.url).searchParams.get("style") ?? "relative0";
  const style = STYLES.has(requested) ? requested : "relative0";

  const upstream = `https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`;

  try {
    const response = await fetch(upstream, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) return empty(60);

    const bytes = await response.arrayBuffer();
    return new Response(bytes, {
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "image/png",
        // Traffic changes minute to minute; two minutes at the edge is the
        // trade between freshness and the free tier.
        "Cache-Control": "public, max-age=60, s-maxage=120, stale-while-revalidate=60",
      },
    });
  } catch {
    return empty(30);
  }
}
