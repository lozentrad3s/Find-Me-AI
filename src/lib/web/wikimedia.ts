/**
 * Wikipedia and Wikimedia — what a place is, and what it looks like. Free.
 *
 * This is the "web search" half of a place lookup. It is deliberately narrow:
 * an encyclopaedia summary and freely licensed photos, from sources that need
 * no key, allow reuse with attribution, and do not vary by who is asking.
 *
 * WHAT IT WILL NOT FIND
 *
 * Wikipedia covers districts, landmarks, big hotels and public buildings. It
 * does not cover the guest house behind the mosque, and that is most of what
 * people search for here. So "no photos found" is the common answer for a
 * small business, and it is reported as exactly that — never filled with a
 * photo of somewhere else that happens to share a word with the name.
 *
 * Photos of a *specific* small business would need Google Places Photos,
 * which requires a billing account. That is a cost decision, so it is left to
 * a provider seam rather than wired in here.
 *
 * Location search on Wikimedia Commons ("photos near this point") was tried
 * and rejected: around Maitama it returned photos of people at a meetup, not
 * of the place. Photos are only taken from an article about the place itself,
 * or from the place's own Wikidata entry.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { throttledFetchJson } from "@/lib/net/throttle";
import { tokenSimilarity } from "@/lib/text/similarity";

const WIKIPEDIA = "https://en.wikipedia.org";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const MIN_INTERVAL_MS = 100;
/** Encyclopaedia pages and photos change slowly; a day is conservative. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Decoration on an answer, never worth holding the answer up for. */
const TIMEOUT_MS = 4_000;
/** A same-named article further than this from the place is a different place. */
const MAX_ARTICLE_DISTANCE_M = 40_000;

export interface WebImage {
  /** ~500px thumbnail, safe to show in a card. */
  thumb: string;
  /** The file's own page, which carries author and licence — the credit link. */
  pageUrl: string;
  /** Human-readable file name, for alt text. */
  title: string;
  source: "wikipedia" | "wikidata";
}

export interface WebSummary {
  title: string;
  /** The article's lead, trimmed to a few sentences. */
  extract: string;
  url: string;
  coordinates: LatLng | null;
}

export interface WebLookup {
  summary: WebSummary | null;
  images: WebImage[];
  /** Plain statement for the model when something was not found. */
  note: string | null;
}

export interface PlaceWebQuery {
  name: string;
  /** District or city, used to disambiguate the search. */
  area?: string | null;
  /** Where the place is, so a same-named article elsewhere is rejected. */
  near?: LatLng | null;
  /** From OSM's `wikidata` tag, when the place carries one. */
  wikidata?: string | null;
  /** From OSM's `wikipedia` tag, e.g. "en:Transcorp Hilton Abuja". */
  wikipedia?: string | null;
}

interface SummaryResponse {
  type?: string;
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  coordinates?: { lat: number; lon: number };
}

interface MediaListResponse {
  items?: Array<{
    title?: string;
    type?: string;
    srcset?: Array<{ src: string }>;
  }>;
}

interface SearchResponse {
  query?: { search?: Array<{ title: string }> };
}

interface ClaimsResponse {
  claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> };
}

interface EntityResponse {
  entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
}

async function getJson<T>(url: string): Promise<T | null> {
  return throttledFetchJson<T>(url, {
    minIntervalMs: MIN_INTERVAL_MS,
    ttlMs: TTL_MS,
    timeoutMs: TIMEOUT_MS,
  }).catch(() => null);
}

function slug(title: string): string {
  return encodeURIComponent(title.trim().replace(/ /g, "_"));
}

/**
 * First few sentences — a card, not the article.
 *
 * Sentences that are only coordinates ("Its geographical coordinates is
 * 9° 4' 14" N…", straight from the Wuse article) are dropped: they are
 * meaningless read aloud, and the map already shows where the place is.
 */
function trimExtract(text: string, sentences = 3): string {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+/g);
  if (!parts) return text.trim();
  return parts
    .filter((sentence) => !/coordinates|°|′|″/i.test(sentence))
    .slice(0, sentences)
    .join(" ")
    .trim();
}

export async function wikipediaSummary(title: string): Promise<WebSummary | null> {
  if (!title.trim()) return null;

  const data = await getJson<SummaryResponse>(
    `${WIKIPEDIA}/api/rest_v1/page/summary/${slug(title)}`,
  );

  if (!data?.title || !data.extract || data.type === "disambiguation") return null;

  return {
    title: data.title,
    extract: trimExtract(data.extract),
    url: data.content_urls?.desktop?.page ?? `${WIKIPEDIA}/wiki/${slug(data.title)}`,
    coordinates: data.coordinates
      ? { lat: data.coordinates.lat, lng: data.coordinates.lon }
      : null,
  };
}

export async function searchWikipedia(query: string, limit = 5): Promise<string[]> {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit),
    format: "json",
  });
  const data = await getJson<SearchResponse>(`${WIKIPEDIA}/w/api.php?${params}`);
  return (data?.query?.search ?? []).map((result) => result.title);
}

/** Logos, flags, locator maps and icons are in every article and show nothing. */
const SKIP_IMAGE =
  /\.svg$|logo|flag|coat[_ ]of[_ ]arms|seal|locator|location[_ ]map|\bmap\b|icon|signature|emblem/i;

function prettyFileTitle(file: string): string {
  return file
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_/g, " ");
}

export async function wikipediaImages(title: string, max = 6): Promise<WebImage[]> {
  const data = await getJson<MediaListResponse>(
    `${WIKIPEDIA}/api/rest_v1/page/media-list/${slug(title)}`,
  );

  return (data?.items ?? [])
    .filter(
      (item) =>
        item.type === "image" &&
        item.title &&
        !SKIP_IMAGE.test(item.title) &&
        (item.srcset?.length ?? 0) > 0,
    )
    .slice(0, max)
    .map((item) => {
      const src = item.srcset![0]!.src;
      return {
        thumb: src.startsWith("//") ? `https:${src}` : src,
        pageUrl: `${WIKIPEDIA}/wiki/${slug(item.title!)}`,
        title: prettyFileTitle(item.title!),
        source: "wikipedia" as const,
      };
    });
}

/** A resized Commons image by file name. Redirects to the real thumbnail. */
export function commonsThumb(file: string, width = 640): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${slug(file.replace(/^File:/i, ""))}?width=${width}`;
}

export async function wikidataImages(qid: string): Promise<WebImage[]> {
  if (!/^Q\d+$/.test(qid)) return [];

  const params = new URLSearchParams({
    action: "wbgetclaims",
    entity: qid,
    property: "P18",
    format: "json",
  });
  const data = await getJson<ClaimsResponse>(`${WIKIDATA}?${params}`);

  return (data?.claims?.P18 ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((file): file is string => typeof file === "string" && !SKIP_IMAGE.test(file))
    .slice(0, 3)
    .map((file) => ({
      thumb: commonsThumb(file),
      pageUrl: `https://commons.wikimedia.org/wiki/File:${slug(file)}`,
      title: prettyFileTitle(file),
      source: "wikidata" as const,
    }));
}

async function wikidataEnwikiTitle(qid: string): Promise<string | null> {
  if (!/^Q\d+$/.test(qid)) return null;

  const params = new URLSearchParams({
    action: "wbgetentities",
    ids: qid,
    props: "sitelinks",
    sitefilter: "enwiki",
    format: "json",
  });
  const data = await getJson<EntityResponse>(`${WIKIDATA}?${params}`);
  return data?.entities?.[qid]?.sitelinks?.enwiki?.title ?? null;
}

/**
 * Is this article about the place we mean?
 *
 * Name similarity alone is not enough — Abuja shares street and district names
 * with half the country. So a summary with coordinates must be near the place,
 * and one without must at least be about somewhere in Nigeria.
 */
function isSamePlace(summary: WebSummary, name: string, near?: LatLng | null): boolean {
  if (tokenSimilarity(summary.title, name) < 0.6) return false;

  if (near && summary.coordinates) {
    return distanceMetres(near, summary.coordinates) <= MAX_ARTICLE_DISTANCE_M;
  }

  return /abuja|nigeria|federal capital/i.test(summary.extract);
}

async function findSummaryByName(
  name: string,
  area?: string | null,
  near?: LatLng | null,
): Promise<WebSummary | null> {
  const direct = await wikipediaSummary(name);
  if (direct && isSamePlace(direct, name, near)) return direct;

  const titles = await searchWikipedia(`${name} ${area ?? "Abuja"}`, 5);

  for (const title of titles) {
    if (tokenSimilarity(title, name) < 0.7) continue;
    const summary = await wikipediaSummary(title);
    if (summary && isSamePlace(summary, name, near)) return summary;
  }

  return null;
}

/**
 * Description and photos for a named place, or an honest "nothing found".
 *
 * Direct links from the map data (OSM `wikidata`/`wikipedia` tags) are tried
 * first because they are about exactly this feature; a name search is the
 * fallback and has to pass `isSamePlace`.
 */
export async function lookupPlaceOnWeb(query: PlaceWebQuery): Promise<WebLookup> {
  const name = query.name.trim();
  if (!name) return { summary: null, images: [], note: "No place name to look up." };

  let title: string | null = query.wikipedia
    ? query.wikipedia.replace(/^[a-z]{2,3}:/i, "")
    : null;

  const [wikidataPhotos, wikidataTitle] = query.wikidata
    ? await Promise.all([
        wikidataImages(query.wikidata),
        title ? Promise.resolve(null) : wikidataEnwikiTitle(query.wikidata),
      ])
    : [[] as WebImage[], null];

  title = title ?? wikidataTitle;

  let summary = title ? await wikipediaSummary(title) : null;
  if (!summary) summary = await findSummaryByName(name, query.area, query.near);

  const articlePhotos = summary ? await wikipediaImages(summary.title) : [];

  const seen = new Set<string>();
  const images = [...wikidataPhotos, ...articlePhotos].filter((image) => {
    const key = image.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    summary,
    images: images.slice(0, 6),
    note:
      !summary && images.length === 0
        ? `Nothing about "${name}" was found on Wikipedia or Wikimedia. That is normal for smaller businesses — it does not mean the place is not there.`
        : images.length === 0
          ? "No freely licensed photos of this place were found."
          : null,
  };
}
