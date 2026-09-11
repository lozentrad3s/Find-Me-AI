/**
 * Web place search — for what the map data does not know.
 *
 * OpenStreetMap's Nigerian coverage is real but thin: a school, a clinic or a
 * new plaza can be missing entirely, and then the honest answer is "I could
 * not find it", which is exactly the answer users find useless. The web knows
 * these places — they have listings, directories, Facebook pages, news
 * mentions — so asking the web first turns a vague phrase into a precise one.
 *
 * THE RULE THIS MUST NOT BREAK
 *
 * The model never supplies a coordinate. It supplies a better SEARCH STRING:
 * the official name, and an address if it found one. Those go to the geocoder,
 * which is the only thing in this system allowed to turn words into a point.
 * A hallucinated street name produces a failed lookup; a hallucinated
 * coordinate produces a confident pin in a field, which is the failure this
 * product cannot afford.
 *
 * COST
 *
 * Google Search grounding runs through the Gemini key, and the free tier
 * allows roughly twenty requests per day per model. So this runs only when the
 * map could not answer confidently, walks the model ladder on quota errors,
 * and returns null rather than throwing when nothing is available — the caller
 * carries on with whatever the map found.
 */

import { GoogleGenAI } from "@google/genai";

export interface WebPlaceHit {
  /** Official name as written on listings, or null when nothing was found. */
  name: string | null;
  /** Street address, when the search actually produced one. */
  address: string | null;
  /** District or neighbourhood. */
  area: string | null;
  confidence: "high" | "medium" | "low";
  /** Why, when there is nothing useful to report. */
  note: string | null;
  /** Which model answered, for the health endpoint and debugging. */
  source: string;
  /** The searches that were actually run, so the answer is auditable. */
  searches: string[];
}

/** Same ladder as the assistant: quota is metered per model, per day. */
const MODELS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.8-flash"];

/** A place lookup already costs a second or two; this is the extra it may add. */
const TIMEOUT_MS = 7_000;

const INSTRUCTIONS = `You help a Nigerian map app turn a vague place description into a precise search string for a geocoder.

Search the web for the place, near the location given.

Rules:
- NEVER give coordinates, latitude or longitude. The app has its own geocoder.
- Never invent an address. If the search did not show one, address is null.
- Prefer the name as written on the place's own listing or signage.
- If several places share the name, pick the one nearest the stated location and say so in "note".
- If you cannot find it, set name, address and area to null and explain in "note".

Reply with JSON only, no prose, no code fences:
{"name": string|null, "address": string|null, "area": string|null, "confidence": "high"|"medium"|"low", "note": string|null}`;

interface GenResponse {
  text?: string;
  candidates?: Array<{ groundingMetadata?: { webSearchQueries?: string[] } }>;
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|RESOURCE_EXHAUSTED|quota|503|UNAVAILABLE|overloaded/i.test(message);
}

/** Models return JSON with occasional code fences or a stray sentence. */
function parseJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Is web place search switched on and usable? */
export function webPlaceSearchAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WEB_PLACE_SEARCH?.trim().toLowerCase() === "off") return false;
  return Boolean((env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim());
}

/**
 * Ask the web what this place is actually called, and roughly where.
 *
 * Returns null when search is unavailable (no key, switched off, or every
 * model out of quota) — never throws, because this is an enhancement to a
 * lookup that must still work without it.
 */
export async function searchPlaceOnWeb(
  phrase: string,
  options: { near?: string | null; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<WebPlaceHit | null> {
  const env = options.env ?? process.env;
  if (!webPlaceSearchAvailable(env)) return null;

  const query = phrase.trim();
  if (!query) return null;

  const client = new GoogleGenAI({
    apiKey: (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)!.trim(),
  });
  const models = client.models as unknown as {
    generateContent(input: Record<string, unknown>): Promise<GenResponse>;
  };

  const preferred = env.GEMINI_SEARCH_MODEL?.trim() || MODELS[0]!;
  const ladder: string[] = [preferred, ...MODELS.filter((model) => model !== preferred)];
  const where = options.near?.trim() || "Abuja, Nigeria";

  for (const model of ladder) {
    try {
      const response = await withTimeout(
        models.generateContent({
          model,
          contents: `${INSTRUCTIONS}\n\nPlace: "${query}"\nNear: ${where}`,
          config: { tools: [{ googleSearch: {} }] },
        }),
        options.timeoutMs ?? TIMEOUT_MS,
      );

      const parsed = parseJson(response.text ?? "");
      if (!parsed) continue;

      const confidence = asString(parsed.confidence)?.toLowerCase();

      return {
        name: asString(parsed.name),
        address: asString(parsed.address),
        area: asString(parsed.area),
        confidence:
          confidence === "high" || confidence === "medium" || confidence === "low"
            ? confidence
            : "low",
        note: asString(parsed.note),
        source: model,
        searches: response.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [],
      };
    } catch (error) {
      // Quota is per model: try the next one. Anything else fails the same way
      // on every model, so stop and let the map-only answer stand.
      if (!isQuotaError(error)) return null;
    }
  }

  return null;
}

/**
 * The search string to hand the geocoder.
 *
 * Address first when there is one — a street address geocodes far more
 * precisely than a business name — then the name, then the area, so the
 * fallback degrades gracefully rather than all at once.
 */
export function searchStringFor(hit: WebPlaceHit, city = "Abuja"): string | null {
  const parts = [hit.address ?? hit.name, hit.address && hit.name ? null : hit.area, city];
  const query = parts.filter(Boolean).join(", ").trim();
  return query && (hit.address || hit.name) ? query : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Web place search timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
