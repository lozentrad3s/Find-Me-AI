/**
 * Per-host request throttling and response caching.
 *
 * This is not an optimisation, it is a licence condition. The Nominatim usage
 * policy caps you at one request per second and requires a User-Agent that
 * identifies the application; ignoring either gets the IP blocked, and there is
 * no appeal process worth relying on. Overpass has softer but real limits.
 *
 * The resolution pipeline fires several geocoder calls per phrase, so without a
 * queue in front of it a single search would breach the policy on its own.
 *
 * The cache is in-process and dies with the server. That is deliberate for now:
 * a persistent cache of OSM data is a licensing and staleness question worth
 * answering properly rather than accidentally.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();

/** One queue per host, so a slow Overpass call cannot delay Nominatim. */
const queues = new Map<string, Promise<unknown>>();
const lastCallAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ThrottledFetchOptions {
  /** Minimum gap between calls to this host, in ms. */
  minIntervalMs: number;
  /** Cache lifetime. Pass 0 to skip the cache. */
  ttlMs?: number;
  /** Key the cache on this instead of the URL (for POST bodies). */
  cacheKey?: string;
  init?: RequestInit;
  timeoutMs?: number;
}

/**
 * Every outbound call must identify the app. Nominatim rejects requests
 * without a meaningful User-Agent, and it is simply good manners on a service
 * run by volunteers.
 */
export const USER_AGENT =
  process.env.OSM_USER_AGENT?.trim() ||
  "FindMe/0.1 (location assistant; development)";

export async function throttledFetchJson<T>(
  url: string,
  options: ThrottledFetchOptions,
): Promise<T> {
  const { minIntervalMs, ttlMs = DEFAULT_TTL_MS, cacheKey, init, timeoutMs = 20_000 } =
    options;

  const key = cacheKey ?? url;

  if (ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    if (hit) cache.delete(key);
  }

  const host = new URL(url).host;

  // Chain onto this host's queue so calls serialise rather than burst.
  const previous = queues.get(host) ?? Promise.resolve();

  const run = previous.then(async () => {
    const since = Date.now() - (lastCallAt.get(host) ?? 0);
    if (since < minIntervalMs) await sleep(minIntervalMs - since);
    lastCallAt.set(host, Date.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(init?.headers ?? {}),
        },
      });

      if (!response.ok) {
        throw new Error(
          `${host} responded ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  });

  // Keep the chain alive even when a call fails, or one error would wedge the
  // host's queue permanently.
  queues.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );

  const value = await run;

  if (ttlMs > 0) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return value;
}

/** Exposed for tests and for the harness, which should start from cold. */
export function clearHttpCache(): void {
  cache.clear();
}
