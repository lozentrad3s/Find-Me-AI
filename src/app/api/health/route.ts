/**
 * GET /api/health — does this deployment actually work?
 *
 * Every external dependency here is free and unauthenticated, which is what
 * makes the project cheap to run and also what makes it fragile in ways a
 * local machine never reveals. Two specific risks only appear once this is
 * behind a cloud IP:
 *
 * 1. Nominatim's usage policy blocks abusive clients by IP, and cloud
 *    provider ranges are heavily abused by other people. A serverless
 *    deployment can be blocked on arrival, through no fault of its own.
 * 2. The throttle and cache in `lib/net/throttle.ts` are in-process. On
 *    serverless each concurrent invocation is a separate process with its own
 *    empty cache and its own idea of when it last called — so the one request
 *    per second Nominatim allows is enforced per instance, not globally.
 *
 * Rather than reason about that, this endpoint measures it: hit it right after
 * deploying and it says exactly which providers answer from production and how
 * fast. It is the difference between "the app seems broken" and "Nominatim is
 * returning 403 from this IP".
 */

import { buildProviders, selectAssistant } from "@/lib/providers/registry";
import { getWeather } from "@/lib/weather/open-meteo";
import { computeRoute } from "@/lib/routing/osrm";
import { DEFAULT_CITY } from "@/lib/geo/cities";
import { safetyStore } from "@/lib/safety/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function timed(
  name: string,
  run: () => Promise<string>,
): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      detail: error instanceof Error ? error.message : "failed",
    };
  }
}

export async function GET(): Promise<Response> {
  const providers = buildProviders();
  const centre = DEFAULT_CITY.centre;

  // Sequential on purpose. Firing these in parallel would breach the very
  // rate limit this endpoint exists to check.
  const checks: Check[] = [];

  checks.push(
    await timed("nominatim:search", async () => {
      const results = await providers.places.textSearch({
        query: "Transcorp Hilton Abuja",
        maxResults: 3,
      });
      if (results.length === 0) throw new Error("no results (possible IP block)");
      return `${results.length} results, top: ${results[0]?.name}`;
    }),
  );

  checks.push(
    await timed("nominatim:reverse", async () => {
      const results = await providers.geocoding.reverse(centre);
      if (results.length === 0) throw new Error("no results");
      return results[0]?.formattedAddress.slice(0, 60) ?? "";
    }),
  );

  checks.push(
    await timed("overpass:nearby", async () => {
      const results = await providers.places.nearbySearch({
        center: centre,
        radiusM: 2000,
        keyword: "pharmacy",
        maxResults: 5,
      });
      return `${results.length} results`;
    }),
  );

  checks.push(
    await timed("osrm:route", async () => {
      const route = await computeRoute(centre, { lat: 9.0855, lng: 7.4903 });
      if (!route) throw new Error("no route");
      return `${(route.distanceM / 1000).toFixed(1)}km`;
    }),
  );

  checks.push(
    await timed("open-meteo:weather", async () => {
      const report = await getWeather(centre);
      if (!report) throw new Error("no data");
      return `${Math.round(report.current.temperatureC)}C ${report.current.description}`;
    }),
  );

  /*
   * The safety store is checked, not just named.
   *
   * A Supabase URL and key can both be set while the migration was never
   * applied, in which case every SOS write fails and silently falls back to
   * memory. Reading the table here turns that into a red line on deploy day
   * instead of a discovery during someone's emergency.
   */
  const safety = safetyStore();
  checks.push(
    await timed("safety:store", async () => {
      await safety.incidentsNear(centre, 1000, Date.now() - 60_000);
      return safety.durable
        ? "supabase (durable)"
        : "memory only — alerts will not survive a restart; set Supabase credentials";
    }),
  );

  const configured = {
    places: providers.places.name,
    geocoding: providers.geocoding.name,
    llm: providers.llm.name,
    assistant: selectAssistant(),
    grounding: process.env.GEMINI_GROUNDING === "true",
    traffic: process.env.TOMTOM_API_KEY?.trim() ? "tomtom" : "none (reports unknown)",
    region: process.env.VERCEL_REGION ?? "local",
    safetyStore: safety.name,
    safetyDurable: safety.durable,
    securityPartners: (() => {
      try {
        const parsed = JSON.parse(process.env.SECURITY_PARTNERS ?? "[]") as unknown;
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    })(),
    smsGateway: Boolean(process.env.SMS_GATEWAY_URL?.trim()),
  };

  const failed = checks.filter((check) => !check.ok);

  return Response.json(
    {
      // Degraded rather than down: the map, saved places and the shell all
      // work even when a provider is unreachable.
      status: failed.length === 0 ? "ok" : failed.length === checks.length ? "down" : "degraded",
      configured,
      checks,
      notes: providers.notes,
      hint:
        failed.some((check) => check.name.startsWith("nominatim"))
          ? "Nominatim failing from this host usually means the IP is blocked or rate-limited. Cloud provider ranges are commonly blocked. Set a real contact in OSM_USER_AGENT, or move geocoding to a paid provider before public launch."
          : null,
    },
    {
      status: failed.length === checks.length ? 503 : 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
