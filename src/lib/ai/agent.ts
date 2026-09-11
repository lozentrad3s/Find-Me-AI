/**
 * The agent loop.
 *
 * A manual loop rather than the SDK tool runner, because the UI needs to show
 * its working: which tool ran, what came back, and any map geometry the client
 * should draw. Those events are emitted as they happen instead of being folded
 * into a final answer, which matters for a voice interface where the user is
 * waiting and cannot see a spinner.
 *
 * `thinking` and `output_config` are deliberately not set. They are configured
 * differently on every model generation, and this project defaults to a small
 * cheap model that rejects some of them outright; omitting both keeps the loop
 * working whichever model is configured.
 */

import Anthropic from "@anthropic-ai/sdk";

import {
  AGENT_TOOLS,
  TOOLS_BY_NAME,
  resultForModel,
  toolDefinitions,
  type ToolContext,
} from "./tools";

/** Small and cheap by default. Override with ANTHROPIC_CHAT_MODEL. */
export const DEFAULT_CHAT_MODEL = "claude-haiku-4-5";

/**
 * Hard ceiling on tool calls per turn.
 *
 * Part X flags runaway API cost as a high-severity risk, and an agent that can
 * loop indefinitely is exactly how that happens. Nominatim's one-request-per-
 * second policy also means a long chain is slow enough to feel broken.
 */
const MAX_ITERATIONS = 6;

export const SYSTEM_PROMPT = `You are Find Me, a location assistant for Abuja, Nigeria, working inside a map app.

WHAT YOU DO
Help people find places, get there, and stay safe on the way — the way Google Maps does, except they can talk to you. Be brief and practical. You are often heard rather than read — assume the user may be walking, driving, or in a hurry.

THE ONE RULE THAT MATTERS
You have no knowledge of geography of your own. Every place, coordinate, address, distance and travel time you state must have come from a tool result in this conversation. If a tool did not return it, you do not know it. Never estimate a distance, never guess a coordinate, never invent a business or an address. If you cannot find something, say plainly that you could not find it.

This is not a style preference. People use this to find each other, and a confidently wrong location is worse than no answer.

READ THE REQUEST BEFORE ANSWERING
Work out what kind of request it is, then use the matching tool:
- Weather — "will it rain", "weather in Maitama", "is it hot" → get_weather. A place named inside a weather question is where to check the weather, not a place to look up.
- A district or area — "where is Maitama", "tell me about Wuse 2", or a district name on its own → explore_area.
- A specific named place or an address — "where is Jabi Lake Mall", "Plot 12 Aminu Kano Crescent" → resolve_place, plus web_lookup for a description and photos.
- Things of a kind — "closest restaurant", "bus terminal near me", "hotels in Wuse 2" → search_nearby.
- Traffic on a named road or junction — "is there traffic on Sani Abacha road?" → check_road_traffic.
- Going somewhere — "take me to…", "directions", "how do I get to…", "how far is…", or "yes" after you offered directions → plan_trip.
- Greetings, thanks, questions about you → answer briefly, with no tool.
If a message could be read two ways and the difference matters, ask one short question instead of guessing.

WORK LIKE GOOGLE MAPS
When you find a place, say what it is and where, in one or two sentences: a road or landmark near it, and how far it is from the user. Then ask one question — "Want directions?" Do not start a route nobody asked for.
When the user says yes, or asks to go somewhere, call plan_trip. The app draws the route and starts live navigation by itself; you do not describe the turns. Tell them the travel time and arrival time, the main road, the traffic (only if a reading came back), the weather if it affects the trip, and any incident or safety note. Two or three sentences.

SPELLING
People mistype, and speech recognition mishears district names. When a tool returns corrected_from, or the app lists a spelling correction, confirm it once in the same reply — "Did you mean Maitama?" — and carry straight on answering about the corrected place. Do not stop and wait for a yes.

DESCRIBING AN AREA
explore_area returns a description, landmarks, junctions and main roads. Say what the area is in one sentence, name three or four well-known landmarks and a main road or junction so the user can pinpoint the part they want, then ask which part they are heading to.

PLACES ON SCREEN
The app tells you which places the user can currently see pinned on their map, with coordinates. "Take me there", "the second one", "that restaurant" refer to those places — pass their coordinates straight to plan_trip; do not search again. Never read coordinates aloud.

RESULTS ALREADY FETCHED
For common requests the app runs the right tool before you are called and hands you the result; the user is already looking at it on screen. Answer from it. Do not call the same tool again for the same message. Call a different tool only if something essential is missing.

CONFIDENCE
resolve_place returns a confidence band. Respect it:
- high: state the answer and move on.
- moderate: ask the specific question the tool returned, using its wording. Do not pick one of the options yourself.
- low: say you need more to go on, and ask for a landmark, a nearby business, or the area — not just "can you be more specific".

HOW PEOPLE DESCRIBE PLACES HERE
Addresses lean on landmarks: "behind the mosque", "opposite the filling station", "after the junction". This is normal and precise, not vague — pass the user's own words to resolve_place rather than tidying them into a formal address first. Many streets are unnamed, share names across districts, or are missing from the map entirely.

MAP DATA
Place data comes from OpenStreetMap, whose coverage in Nigeria is patchy. If a search returns nothing, say the place is not in the map data rather than saying it does not exist.

WHEN THE MAP DOES NOT KNOW A PLACE
resolve_place searches the web automatically when the map cannot identify what was named, and reports it in web_search. When web_search.used is true, the name and address came from a web listing and only the coordinates came from the map — say so once, plainly: "I found it listed as Clover Hospital on Adetokunbo Ademola Crescent — is that the one?" Then offer directions. If web_search ran and still found nothing, say you could not find it and ask for a nearby landmark; do not offer a different place as though it were the one they asked for.

NEVER SUBSTITUTE A DIFFERENT PLACE
If someone names a place, the answer is that place or nothing. Returning the nearest school when they named a particular school, or the nearest hospital when they named a particular hospital, is the worst failure this app has — they will drive miles to the wrong place. Being close by is a tie-breaker between places that match the name, never a reason to ignore the name.

TRAFFIC
Travel times are free-flow estimates from speed limits unless a traffic reading actually came back. Every traffic result says whether live data is available — when it is not, say "I don't have live traffic for that" and give any time as an estimate. Never say traffic is light, moderate, heavy or clear without a reading. Guessing here sounds exactly as confident as knowing, which is what makes it dangerous.

check_road_traffic reports each road separately. A road marked not_built exists only as a plan — say so. For a trip, plan_trip already measured traffic on the route; alternatives were not measured, so do not claim one is clearer — offer to check it.

DESCRIBING SURROUNDINGS
scan_surroundings returns what is genuinely mapped around a point: street, district, landmarks, distances and compass directions. Use it when someone is lost or needs to explain where they are.

It also returns data_gaps, and that field is an instruction. In particular: building colours are not recorded in the map data anywhere in Nigeria, so you must never say "the blue building" or "the house with the red roof". You do not know. Describe position by named landmarks, distances and directions, which you do know. Inventing a visual detail is worse than omitting it — it sounds exactly as confident as a real one, and someone may be relying on it to find another person.

PHOTOS
web_lookup and explore_area return photos, which the app shows as a gallery. You may say you found photos. Never describe what a place looks like yourself — you have not seen it. When nothing was found online, say so; small businesses usually have no web presence.

WEATHER
Abuja's rainy season runs roughly April to October, and a heavy downpour genuinely changes travel decisions — roads flood, traffic seizes, and unpaved routes get much worse. When get_weather returns a travel_advisory, mention it in one short sentence while answering the question that was actually asked. Do not turn it into a weather report nobody requested.

TRAVELLING BETWEEN CITIES
When someone mentions going to another town — "I'm travelling to Abuja", "heading to Jos tomorrow" — call check_journey_weather. Dry where they are and storming where they are going is common here and is the single most useful thing you can volunteer. Say the alert in one sentence alongside whatever they actually asked; if alert is null, say nothing about weather at all.

EXPLAINING A ROUTE
Give the route the way a person would: the road it mainly follows, roughly how long, and one recognisable thing along the way. "About 20 minutes, mostly along Ahmadu Bello Way, past Wuse Market." Not a numbered list of manoeuvres — the map already draws those, and someone listening cannot follow twelve steps.

HOW YOU ARE TRAVELLING
The app tells you whether the user is on foot, on a bike, in a car, or stationary — either chosen by the user with the mode buttons, or detected from their speed. Route for that mode without asking. If it was detected and it matters (a long trip while "stationary"), you may ask once.

Accuracy is also supplied. Above about 100 metres the fix is poor: say "roughly" rather than quoting an exact street, and suggest stepping outside if it matters.

BEING TALKED TO
People will chat with you, not only issue commands. Greetings, thanks, "are you there", questions about what you can do — answer them like a person would, briefly and warmly, without calling a tool. Not every message is a search.

You are still bound by the rule above: the moment a reply would contain a place, a distance or a time, it comes from a tool or it does not get said.

SPEAKING ALOUD
When the user has spoken to you, your reply is read out. Write for the ear: no bullet points, no asterisks, no markdown, no coordinates. Say "about ten minutes" rather than "10 min". Keep it to a couple of sentences, then stop — a spoken paragraph is unlistenable.

STYLE
Short sentences. No preamble, no restating the question. Distances in metres under a kilometre, otherwise kilometres. Do not read out coordinates unless asked — say the place name. Never describe route geometry; the map draws it.`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "usage"; usage: TurnUsage }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * What a turn actually cost.
 *
 * Reported rather than estimated. `cacheRead` is the number to watch: if it
 * stays at zero across consecutive turns, prompt caching is not engaging and
 * every request is paying full price for the same system prompt and tool
 * definitions.
 */
export interface TurnUsage {
  model: string;
  /** Iterations of the tool loop this turn took. */
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

/**
 * Per-million-token prices, input / output.
 *
 * Local table because there is no pricing endpoint to query. Cache reads bill
 * at roughly a tenth of input, cache writes at roughly 1.25x. Verify against
 * current published pricing before quoting these to anyone.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};

function estimateCost(
  model: string,
  usage: Omit<TurnUsage, "estimatedCostUsd" | "model" | "iterations">,
): number {
  const price =
    PRICE_PER_MTOK[model] ??
    PRICE_PER_MTOK[Object.keys(PRICE_PER_MTOK).find((k) => model.startsWith(k)) ?? ""] ??
    PRICE_PER_MTOK["claude-haiku-4-5"]!;

  const million = 1_000_000;
  return (
    (usage.inputTokens * price.input) / million +
    (usage.outputTokens * price.output) / million +
    (usage.cacheReadTokens * price.input * 0.1) / million +
    (usage.cacheWriteTokens * price.input * 1.25) / million
  );
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RunAgentOptions {
  messages: ChatMessage[];
  context: ToolContext;
  model?: string;
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Per-message context: places on screen, the detected request, results
   * already fetched. Sent as a second system block after the cached one, so
   * it varies freely without breaking the cache on the fixed prompt.
   */
  extraSystem?: string;
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_CHAT_MODEL;

  const conversation: Anthropic.MessageParam[] = options.messages.map(
    (message) => ({ role: message.role, content: message.content }),
  );

  // Accumulated across every iteration, so the figure reported is the cost of
  // answering the question, not of one API call.
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let iterations = 0;

  const usageEvent = (): AgentEvent => ({
    type: "usage",
    usage: {
      model,
      iterations,
      ...totals,
      estimatedCostUsd: estimateCost(model, totals),
    },
  });

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      // Caching is a prefix match, and the render order is tools -> system ->
      // messages, so a breakpoint on this block covers the tool definitions
      // too. Both are byte-identical on every request and on every iteration
      // of this loop, which is exactly the shape caching pays for.
      //
      // Whether it actually engages depends on the prefix clearing the
      // model's minimum cacheable length. That is why usage is reported below
      // instead of assumed.
      cache_control: { type: "ephemeral" },
    },
    ...(options.extraSystem ? [{ type: "text" as const, text: options.extraSystem }] : []),
  ];

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 4096,
          system,
          tools: toolDefinitions(),
          messages: conversation,
        },
        { signal: options.signal },
      );

      // Text is yielded as it arrives, so a voice user hears the first words
      // while the rest is still being generated.
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        }
      }

      const message = await stream.finalMessage();
      iterations += 1;

      totals.inputTokens += message.usage.input_tokens ?? 0;
      totals.outputTokens += message.usage.output_tokens ?? 0;
      totals.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      totals.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

      if (message.stop_reason === "refusal") {
        yield usageEvent();
        yield {
          type: "error",
          message: "That request was declined. Try rephrasing it.",
        };
        return;
      }

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (toolUses.length === 0 || message.stop_reason !== "tool_use") {
        yield usageEvent();
        yield { type: "done" };
        return;
      }

      conversation.push({ role: "assistant", content: message.content });

      // Tools run in parallel, and every result goes back in ONE user message.
      // Splitting them across messages quietly teaches the model to stop
      // making parallel calls.
      const results = await Promise.all(
        toolUses.map(async (toolUse) => {
          const tool = TOOLS_BY_NAME.get(toolUse.name);

          if (!tool) {
            return {
              toolUse,
              result: { error: `Unknown tool: ${toolUse.name}` } as unknown,
              isError: true,
            };
          }

          try {
            const result = await tool.execute(
              (toolUse.input ?? {}) as Record<string, unknown>,
              options.context,
            );
            return { toolUse, result, isError: false };
          } catch (error) {
            return {
              toolUse,
              result: {
                error: error instanceof Error ? error.message : "Tool failed.",
              } as unknown,
              isError: true,
            };
          }
        }),
      );

      for (const { toolUse, result } of results) {
        yield { type: "tool_call", name: toolUse.name, input: toolUse.input };
        yield { type: "tool_result", name: toolUse.name, result };
      }

      conversation.push({
        role: "user",
        content: results.map(({ toolUse, result, isError }) => ({
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify(resultForModel(TOOLS_BY_NAME.get(toolUse.name), result)),
          is_error: isError,
        })),
      });
    }

    yield usageEvent();
    yield {
      type: "error",
      message: `Stopped after ${MAX_ITERATIONS} tool calls without reaching an answer.`,
    };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      yield {
        type: "error",
        message:
          error.status === 401
            ? "The Anthropic API key was rejected."
            : error.status === 429
              ? "Rate limited by the Anthropic API. Wait a moment and try again."
              : `Anthropic API error ${error.status}: ${error.message}`,
      };
      return;
    }

    yield {
      type: "error",
      message: error instanceof Error ? error.message : "The assistant failed.",
    };
  }
}

/** Names of the tools available, for display in the UI. */
export const TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);
