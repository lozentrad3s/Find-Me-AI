/**
 * POST /api/chat — the assistant, streamed as server-sent events.
 *
 * Streaming rather than a single JSON response because the loop can take
 * several seconds: Nominatim is rate-limited to roughly one call per second,
 * so a question needing resolve_place then plan_trip genuinely takes a while.
 * Showing which tool is running turns that wait into visible progress instead
 * of an apparently frozen app.
 *
 * THE FAST PATH
 *
 * The request is read before any model sees it (`classifyIntent`). When it is
 * one of the common, unambiguous kinds — weather, "closest restaurant",
 * traffic on a road, "take me there" — the right tools run immediately, their
 * results stream to the map, and the model is called once, only to phrase the
 * answer. That removes a whole model round trip from the commonest questions,
 * and it means the answer still arrives, as a plain templated sentence, when
 * the model is rate-limited or down.
 *
 * The API key stays server-side. It is never sent to the browser.
 */

import { buildProviders, selectAssistant } from "@/lib/providers/registry";
import { runAgent, type AgentEvent, type ChatMessage } from "@/lib/ai/agent";
import { runOfflineAgent } from "@/lib/ai/offline-agent";
import { runGeminiAgent } from "@/lib/ai/gemini-agent";
import { NoTrafficProvider } from "@/lib/traffic/types";
import { TomTomTrafficProvider } from "@/lib/traffic/tomtom";
import { classifyIntent, type ContextPlace, type Intent } from "@/lib/ai/intent";
import {
  TOOLS_BY_NAME,
  areaCentre,
  resultForModel,
  type ToolContext,
} from "@/lib/ai/tools";
import { lookupOsmExtras } from "@/lib/providers/osm/nominatim";
import { lookupPlaceOnWeb, wikidataImages, type WebLookup } from "@/lib/web/wikimedia";
import {
  SMALLTALK_REPLY,
  phraseArea,
  phraseNearby,
  phrasePlace,
  phraseRoadTraffic,
  phraseTrip,
  phraseWeather,
  phraseWhereAmI,
} from "@/lib/ai/templates";
import type { TripPlan } from "@/lib/trip/plan";

export const runtime = "nodejs";
/** Streaming responses must not be statically cached. */
export const dynamic = "force-dynamic";

interface ChatBody {
  messages?: unknown;
  lat?: unknown;
  lng?: unknown;
  city?: unknown;
  travelMode?: unknown;
  modeSource?: unknown;
  accuracyM?: unknown;
  places?: unknown;
}

const MAX_MESSAGES = 40;
const MAX_CONTENT_LENGTH = 4000;
const MAX_CONTEXT_PLACES = 12;
/** Enough for the model to read a result; a runaway result gets cut. */
const MAX_FETCHED_CHARS = 6_000;

interface Fetched {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
}

type Emit = (event: AgentEvent | Record<string, unknown>) => void;

export async function POST(request: Request): Promise<Response> {
  /*
   * No key is a degraded mode, not an error.
   *
   * The offline agent runs the same tools through the same event stream using
   * keyword matching, so the whole conversational surface works without a
   * model; swapping one in changes one branch. It announces itself as
   * offline in its first reply.
   */
  const assistant = selectAssistant();

  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const messages = parseMessages(body.messages);
  if (!messages) {
    return Response.json(
      { error: "'messages' must be a non-empty array of {role, content}." },
      { status: 400 },
    );
  }

  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;

  const providers = buildProviders();

  // No key means no traffic data, and the tools say exactly that rather than
  // letting the model characterise congestion it never measured.
  const tomtomKey = process.env.TOMTOM_API_KEY?.trim();
  const traffic = tomtomKey ? new TomTomTrafficProvider(tomtomKey) : new NoTrafficProvider();

  const places = parsePlaces(body.places);
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastAssistant =
    [...messages].reverse().find((m) => m.role === "assistant")?.content ?? null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (data) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const toolContext: ToolContext = {
        providers,
        traffic,
        currentLocation: lat !== null && lng !== null ? { lat, lng } : undefined,
        city: typeof body.city === "string" ? body.city : undefined,
        travelMode: parseTravelMode(body.travelMode),
        accuracyM:
          typeof body.accuracyM === "number" && Number.isFinite(body.accuracyM)
            ? body.accuracyM
            : null,
      };

      try {
        const intent = classifyIntent(lastUser, { places, lastAssistant });

        emit({
          type: "intent",
          kind: intent.kind,
          corrections: intent.corrections.map((c) => ({ heard: c.heard, name: c.name })),
        });

        const fetched = await runFastPath(intent, toolContext, emit);

        /*
         * Recognised requests are answered straight from their results.
         *
         * Measured on the free Gemini tier, the tools for "closest
         * restaurant" or "weather in Maitama" finish in two or three
         * seconds, and then the model took another five to thirty to
         * rephrase numbers that were already on the screen. Google Maps does
         * not make you wait for a sentence before showing the results, and
         * the free tier's few dozen calls a day are better spent on the
         * requests that genuinely need a model: open questions, ambiguous
         * places, follow-ups the classifier cannot read.
         *
         * FAST_REPLIES=off hands these back to the model for phrasing.
         */
        const answerDirectly =
          assistant === "offline" ||
          (process.env.FAST_REPLIES?.trim().toLowerCase() !== "off" &&
            fetched.length > 0 &&
            DIRECT_KINDS.has(intent.kind));

        if (answerDirectly) {
          const template = templateFor(intent, fetched);
          if (template) {
            if (assistant === "offline" && messages.length <= 1) {
              emit({
                type: "text",
                delta: "Offline mode — no AI key is set, so answers are built from the search results directly.\n\n",
              });
            }
            emit({ type: "text", delta: template });
            emit({ type: "done" });
            return;
          }
        }

        if (assistant === "offline") {
          for await (const event of runOfflineAgent({
            messages,
            context: toolContext,
            announce: messages.length <= 1,
          })) {
            emit(event);
          }
          return;
        }

        const extraSystem = buildContext(intent, places, fetched, toolContext, body.modeSource);

        const model =
          assistant === "claude"
            ? runAgent({
                apiKey: process.env.ANTHROPIC_API_KEY!.trim(),
                messages,
                model: process.env.ANTHROPIC_CHAT_MODEL?.trim() || undefined,
                context: toolContext,
                signal: request.signal,
                extraSystem,
              })
            : runGeminiAgent({
                apiKey: (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)!.trim(),
                messages,
                model: process.env.GEMINI_CHAT_MODEL?.trim() || undefined,
                context: toolContext,
                // Grounding routes around our own resolution engine, so it
                // is opt-in rather than a silent default.
                grounding: process.env.GEMINI_GROUNDING === "true",
                extraSystem,
              });

        /*
         * If the model fails after the tools already answered — quota, an
         * outage — the user still gets the answer, phrased from the data.
         * An error message on top of a map full of correct pins would be the
         * worst of both.
         */
        let spoke = false;
        let failure: string | null = null;

        for await (const event of model) {
          if (event.type === "text" && event.delta.trim()) spoke = true;
          if (event.type === "error" && fetched.length > 0 && !spoke) {
            failure = event.message;
            continue;
          }
          emit(event);
        }

        if (!spoke) {
          const template = templateFor(intent, fetched);
          if (template) emit({ type: "text", delta: template });
          else if (failure) emit({ type: "error", message: failure });
        }
      } catch (error) {
        // The client has no other way to learn the stream died mid-flight.
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "The assistant failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this, nginx and similar buffer the whole stream and the
      // progressive display silently stops working in deployment.
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Fast path
// ---------------------------------------------------------------------------

/**
 * Run the tools a recognised request needs, streaming their results.
 * Returns what was fetched, for the model to phrase. Unknown requests fetch
 * nothing and go to the model as before.
 */
async function runFastPath(
  intent: Intent,
  context: ToolContext,
  emit: Emit,
): Promise<Fetched[]> {
  const fetched: Fetched[] = [];

  const call = (name: string, input: Record<string, unknown>) => {
    emit({ type: "tool_call", name, input });
    return execute(name, input, context);
  };

  const finish = (name: string, input: Record<string, unknown>, result: unknown) => {
    emit({ type: "tool_result", name, result });
    fetched.push({ name, input, result });
    return result;
  };

  const run = async (name: string, input: Record<string, unknown>) =>
    finish(name, input, await call(name, input));

  switch (intent.kind) {
    case "where_am_i":
      await run("scan_surroundings", {});
      break;

    case "weather":
      await run("get_weather", intent.target ? { place: intent.target } : {});
      break;

    case "road_traffic":
      await run("check_road_traffic", { roads: intent.roads ?? [] });
      break;

    case "nearby":
      await run("search_nearby", {
        category: intent.category!.query,
        ...(intent.area ? { area: intent.area } : {}),
      });
      break;

    case "area_info": {
      // The words as heard, not the corrected name: the tool then reports the
      // correction, and the reply opens with "did you mean Maitama?".
      const heard = intent.corrections.find((c) => c.name === intent.target)?.heard;
      await run("explore_area", { name: heard ?? intent.target! });
      break;
    }

    case "place_lookup": {
      const target = intent.target!;
      const resolveInput = { phrase: target };
      const webInput = { name: target };

      // Map search and web search at the same time; photos are then topped
      // up from the place's own Wikidata entry if the name search found none.
      const [resolved, web] = await Promise.all([
        call("resolve_place", resolveInput),
        call("web_lookup", webInput),
      ]);
      finish("resolve_place", resolveInput, resolved);
      finish("web_lookup", webInput, await topUpPhotos(resolved, web as WebLookup & { name: string }));
      break;
    }

    case "directions":
      await directions(intent, context, run);
      break;

    default:
      break;
  }

  return fetched;
}

async function directions(
  intent: Intent,
  context: ToolContext,
  run: (name: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const trip = (lat: number, lng: number, name: string) =>
    run("plan_trip", { to_lat: lat, to_lng: lng, to_name: name });

  if (intent.place) {
    await trip(intent.place.lat, intent.place.lng, intent.place.name);
    return;
  }

  if (intent.category) {
    const found = (await run("search_nearby", { category: intent.category.query })) as {
      results?: Array<{ name: string; lat: number; lng: number }>;
    };
    const nearest = found.results?.[0];
    if (nearest) await trip(nearest.lat, nearest.lng, nearest.name);
    return;
  }

  if (!intent.target) return;

  // A district is a destination in its own right: route to its centre rather
  // than asking the resolver to pin a whole neighbourhood to one building.
  const district = intent.names.find(
    (name) => name.kind === "district" && intent.target!.toLowerCase().includes(name.name.toLowerCase()),
  );
  if (district) {
    const area = await areaCentre(district.name, context);
    if (area) {
      await trip(area.point.lat, area.point.lng, area.name);
      return;
    }
  }

  const resolved = (await run("resolve_place", { phrase: intent.target })) as {
    band?: string;
    question?: string | null;
    best?: { name: string; lat: number; lng: number } | null;
  };

  // Only a settled answer becomes a route. A moderate result carries a
  // question the user must answer first; routing to a guess is the one
  // failure a navigation product cannot recover from gracefully.
  if (resolved.best && (resolved.band === "high" || (resolved.band === "moderate" && !resolved.question))) {
    await trip(resolved.best.lat, resolved.best.lng, resolved.best.name);
  }
}

async function execute(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.execute(input, context);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Tool failed." };
  }
}

/**
 * Photos for a resolved place when the name search found none.
 *
 * "jabi lake mall" as typed rarely matches an article title, but the place
 * the resolver found may carry its own Wikidata link in OpenStreetMap — and
 * that is a photo of exactly this building, not of something with a similar
 * name.
 */
async function topUpPhotos(
  resolved: unknown,
  web: WebLookup & { name: string },
): Promise<WebLookup & { name: string }> {
  const best = (resolved as { best?: { name?: string; place_id?: string | null; lat?: number; lng?: number } | null })
    .best;
  if (!best || (web.summary && web.images.length > 0)) return web;

  // A better name to search by: the one the map actually has.
  if (!web.summary && best.name && best.name.toLowerCase() !== web.name.toLowerCase()) {
    const retry = await lookupPlaceOnWeb({
      name: best.name,
      near: typeof best.lat === "number" && typeof best.lng === "number" ? { lat: best.lat, lng: best.lng } : null,
    });
    if (retry.summary || retry.images.length > 0) return { ...retry, name: best.name };
  }

  if (!best.place_id) return web;
  const extras = (await lookupOsmExtras([best.place_id])).get(best.place_id);
  if (!extras?.wikidata) return web;

  const images = await wikidataImages(extras.wikidata);
  return images.length > 0 ? { ...web, images, note: web.summary ? null : web.note } : web;
}

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "weather":
      return `a weather question${intent.target ? ` about ${intent.target}` : " about where the user is"} — not a place search`;
    case "nearby":
      return `find the nearest ${intent.category?.label ?? "place"}${intent.area ? ` in ${intent.area}` : " near the user"}`;
    case "road_traffic":
      return `live traffic on ${intent.roads?.join(" and ") ?? "a road"}`;
    case "area_info":
      return `describe the area ${intent.target}`;
    case "place_lookup":
      return `find the place "${intent.target}" and show what it is`;
    case "directions":
      return intent.place
        ? `start a trip to ${intent.place.name}`
        : intent.category
          ? `start a trip to the nearest ${intent.category.label}`
          : `start a trip to "${intent.target}"`;
    case "where_am_i":
      return "tell the user where they are";
    case "smalltalk":
      return "conversation — answer briefly without tools";
    default:
      return "not recognised — read it carefully";
  }
}

function buildContext(
  intent: Intent,
  places: ContextPlace[],
  fetched: Fetched[],
  context: ToolContext,
  modeSource: unknown,
): string {
  const lines = ["CONTEXT FOR THIS MESSAGE"];

  const mode = context.travelMode ?? "still";
  const source = modeSource === "user" ? "chosen by the user" : "detected from GPS speed";
  lines.push(
    `Travel mode: ${mode === "foot" ? "on foot" : mode === "bike" ? "on a bike" : mode === "car" ? "in a car" : "stationary"} (${source}).`,
  );

  lines.push(
    context.currentLocation
      ? `The user's location is known${context.accuracyM ? `, accurate to about ${Math.round(context.accuracyM)} m` : ""}.`
      : "The user's location is NOT shared. For anything that needs it, ask them to tap the location button.",
  );

  if (places.length > 0) {
    lines.push(
      "PLACES ON SCREEN (pinned on the user's map, most recent first; use these coordinates for follow-ups and never read them aloud):",
    );
    places.forEach((place, index) => {
      lines.push(
        `${index + 1}. ${place.name} — lat ${place.lat.toFixed(5)}, lng ${place.lng.toFixed(5)}${
          place.address ? ` — ${place.address.slice(0, 80)}` : ""
        }`,
      );
    });
  }

  lines.push(`DETECTED REQUEST: ${describeIntent(intent)}.`);

  if (intent.corrections.length > 0) {
    lines.push(
      `SPELLING: ${intent.corrections
        .map((c) => `"${c.heard}" is almost certainly ${c.name}`)
        .join("; ")}. Confirm once ("Did you mean ${intent.corrections[0]!.name}?") and answer about the corrected name.`,
    );
  }

  if (fetched.length > 0) {
    lines.push(
      "RESULTS ALREADY FETCHED (already on the user's screen — answer from these; do not call these tools again for this message):",
    );
    for (const entry of fetched) {
      const forModel = resultForModel(TOOLS_BY_NAME.get(entry.name), entry.result);
      const json = JSON.stringify(forModel);
      lines.push(
        `[${entry.name}] ${json.length > MAX_FETCHED_CHARS ? `${json.slice(0, MAX_FETCHED_CHARS)}…` : json}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Requests whose fetched results fully answer them, so they are replied to
 * directly (see `answerDirectly`). Smalltalk and unrecognised requests always
 * go to the model; that is what it is for.
 */
const DIRECT_KINDS = new Set<Intent["kind"]>([
  "nearby",
  "road_traffic",
  "weather",
  "area_info",
  "where_am_i",
  "directions",
  "place_lookup",
]);

/** Tool errors are written for the model; say them the way a person would. */
function friendlyError(message: string): string {
  if (/no location available/i.test(message)) {
    return "I need your location for that. Tap the location button, then ask again.";
  }
  if (/no route could be calculated/i.test(message)) {
    return "I couldn't find a route there. The roads may not be mapped, or the routing service isn't answering. Try again in a moment.";
  }
  return message;
}

function templateFor(intent: Intent, fetched: Fetched[]): string | null {
  const get = (name: string) => fetched.find((entry) => entry.name === name)?.result;
  const errorOf = (result: unknown) =>
    typeof result === "object" && result !== null && "error" in result
      ? friendlyError(String((result as { error: unknown }).error))
      : null;

  const pick = (name: string, phrase: (result: unknown) => string): string | null => {
    const result = get(name);
    if (result === undefined) return null;
    return errorOf(result) ?? phrase(result);
  };

  switch (intent.kind) {
    case "smalltalk":
      return SMALLTALK_REPLY;
    case "where_am_i":
      return pick("scan_surroundings", phraseWhereAmI);
    case "weather":
      return pick("get_weather", phraseWeather);
    case "road_traffic":
      return pick("check_road_traffic", phraseRoadTraffic);
    case "nearby":
      return pick("search_nearby", (r) => phraseNearby(r, intent.category?.label ?? "place"));
    case "area_info":
      return pick("explore_area", phraseArea);
    case "place_lookup":
      return pick("resolve_place", (r) => phrasePlace(r, get("web_lookup") as WebLookup | undefined));
    case "directions":
      return (
        pick("plan_trip", (r) => phraseTrip(r as TripPlan)) ??
        pick("resolve_place", (r) => phrasePlace(r)) ??
        pick("search_nearby", (r) => phraseNearby(r, intent.category?.label ?? "place"))
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Narrows the client-supplied mode; anything unexpected becomes undefined. */
function parseTravelMode(
  value: unknown,
): "foot" | "bike" | "car" | "still" | undefined {
  return value === "foot" || value === "bike" || value === "car" || value === "still"
    ? value
    : undefined;
}

function parsePlaces(value: unknown): ContextPlace[] {
  if (!Array.isArray(value)) return [];

  const places: ContextPlace[] = [];
  for (const entry of value.slice(0, MAX_CONTEXT_PLACES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, lat, lng, address } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) continue;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    places.push({
      id: typeof id === "string" ? id : `${lat},${lng}`,
      name: name.trim().slice(0, 120),
      lat,
      lng,
      address: typeof address === "string" ? address.slice(0, 200) : null,
    });
  }
  return places;
}

function parseMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const messages: ChatMessage[] = [];

  for (const entry of value.slice(-MAX_MESSAGES)) {
    if (typeof entry !== "object" || entry === null) return null;

    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;

    const trimmed = content.trim();
    if (!trimmed) continue;

    messages.push({ role, content: trimmed.slice(0, MAX_CONTENT_LENGTH) });
  }

  // Both model APIs require the conversation to open with a user turn.
  while (messages.length > 0 && messages[0]?.role !== "user") messages.shift();

  return messages.length > 0 ? messages : null;
}
