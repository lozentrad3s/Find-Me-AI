/**
 * Offline agent — the assistant without a language model.
 *
 * This exists so the entire product is usable and testable before anyone has
 * an API key. It runs the *same tools* through the *same event stream* as the
 * real agent, so the UI, the voice loop, the map wiring and the tool trace are
 * all exercised identically. Only intent detection and phrasing differ:
 * regexes instead of a model, templates instead of generated prose.
 *
 * Two things it is deliberately not:
 *
 * - It is not a fallback the product should ship on. It handles the phrasings
 *   in the patterns below and nothing else, and it cannot hold a conversation.
 *   Every reply says so.
 * - It is not a pretend AI. It identifies itself as offline mode in the first
 *   reply of a session. A user who thinks they are talking to an assistant and
 *   is actually talking to a regex will conclude the assistant is stupid, and
 *   they will be right.
 *
 * The honest framing matters here for the same reason it matters everywhere
 * else in this codebase: a system that overstates what it knows is the failure
 * mode this product cannot afford.
 */

import { TOOLS_BY_NAME, type ToolContext } from "./tools";
import type { AgentEvent, ChatMessage } from "./agent";

/** Category words -> the term the search tools understand. */
const CATEGORY_PATTERNS: Array<[RegExp, string, string]> = [
  [/\b(fuel|petrol|filling station|gas station|diesel)\b/i, "fuel", "filling station"],
  [/\b(pharmac|chemist|drug ?store)\w*/i, "pharmacy", "pharmacy"],
  [/\b(hospital|clinic|emergency room|doctor)\w*/i, "hospital", "hospital"],
  [/\b(restaurant|food|eat|hungry|bukka|canteen|lunch|dinner)\w*/i, "restaurant", "restaurant"],
  [/\b(hotel|guest ?house|lodge|accommodation|sleep)\w*/i, "hotel", "hotel"],
  [/\b(bank|atm|cash)\w*/i, "bank", "bank"],
  [/\b(market|marketplace)\w*/i, "market", "market"],
  [/\b(supermarket|groceries|provisions|shop)\w*/i, "supermarket", "supermarket"],
  [/\b(mechanic|vulcaniz|car repair|workshop)\w*/i, "mechanic", "mechanic"],
  [/\b(police)\b/i, "police station", "police station"],
  [/\b(school|university|college)\w*/i, "school", "school"],
];

const WEATHER_RE =
  /\b(weather|rain|raining|forecast|hot|cold|temperature|humid|storm|sunny|cloud)\w*/i;
const WHERE_AM_I_RE =
  /\b(where am i|my location|where i am|current location|i'?m lost|i am lost|locate me)\b/i;
const TRAFFIC_RE = /\b(traffic|congestion|jam|busy|hold ?up|go ?slow)\w*/i;
const NEARBY_RE =
  /\b(near|nearest|nearby|around|close to me|closest|around me|find me a|find a|any)\b/i;
const ROUTE_RE =
  /\b(take me|navigate|directions|how do i get|route to|drive to|go to|get to)\b/i;

export interface OfflineAgentOptions {
  messages: ChatMessage[];
  context: ToolContext;
  /** True on the first exchange of a session, which explains the mode once. */
  announce: boolean;
}

export async function* runOfflineAgent(
  options: OfflineAgentOptions,
): AsyncGenerator<AgentEvent> {
  const last = options.messages[options.messages.length - 1];
  const phrase = last?.content.trim() ?? "";

  if (!phrase) {
    yield { type: "done" };
    return;
  }

  if (options.announce) {
    yield {
      type: "text",
      delta:
        "Offline mode — no AI key is set, so I'm matching keywords rather than understanding you. Search, the map and weather all work normally.\n\n",
    };
  }

  try {
    for await (const event of route(phrase, options.context)) {
      yield event;
    }
  } catch (error) {
    yield {
      type: "error",
      message:
        error instanceof Error ? error.message : "Offline lookup failed.",
    };
  }

  yield { type: "done" };
}

async function* route(
  phrase: string,
  context: ToolContext,
): AsyncGenerator<AgentEvent> {
  // Order matters: "is there traffic to Wuse" mentions a destination but is a
  // traffic question, and "where am I" must not be read as a place search.
  if (WHERE_AM_I_RE.test(phrase)) {
    // scan_surroundings rather than where_am_i: a raw address is far less
    // useful than "you're on Gana Street, the filling station is 80m north".
    // Landmarks are how people here actually establish where they are.
    yield* runTool("scan_surroundings", {}, context, (result) => {
      const data = result as {
        spoken_description?: string;
        address?: string | null;
      };
      return (
        data.spoken_description ??
        (data.address ? `You're at ${data.address}.` : "I could not work out where you are.")
      );
    });
    return;
  }

  if (WEATHER_RE.test(phrase)) {
    yield* runTool("get_weather", {}, context, (result) => {
      const data = result as {
        current?: { temperature_c?: number; conditions?: string };
        forecast?: Array<{ day: string; conditions: string; rain_chance_pct: number }>;
        travel_advisory?: string | null;
      };

      if (!data.current) return "Weather is unavailable right now.";

      const parts = [
        `It's ${data.current.temperature_c}° and ${(data.current.conditions ?? "").toLowerCase()}.`,
      ];

      const tomorrow = data.forecast?.[1];
      if (tomorrow) {
        parts.push(
          `${tomorrow.day}: ${tomorrow.conditions.toLowerCase()}, ${tomorrow.rain_chance_pct}% chance of rain.`,
        );
      }

      if (data.travel_advisory) parts.push(data.travel_advisory);

      return parts.join(" ");
    });
    return;
  }

  const category = matchCategory(phrase);

  if (category && (NEARBY_RE.test(phrase) || !ROUTE_RE.test(phrase))) {
    yield* runTool(
      "search_nearby",
      { category: category.query },
      context,
      (result) => {
        const data = result as {
          results?: Array<{ name: string; distance_m: number }>;
          note?: string;
        };
        const found = data.results ?? [];

        if (found.length === 0) {
          return `I couldn't find a ${category.label} nearby in the map data. OpenStreetMap coverage is uneven here, so it may be unmapped rather than absent.`;
        }

        const nearest = found[0]!;
        const others = found.length - 1;

        return (
          `Nearest ${category.label}: ${nearest.name}, ${formatMetres(nearest.distance_m)} away.` +
          (others > 0 ? ` ${others} more shown on the map.` : "")
        );
      },
    );
    return;
  }

  if (TRAFFIC_RE.test(phrase)) {
    // Traffic needs a destination, and extracting one reliably is exactly the
    // job a model does and a regex does not. Say so rather than guessing.
    yield {
      type: "text",
      delta:
        "I can check traffic, but working out your destination from that sentence needs the AI. Add an ANTHROPIC_API_KEY and ask again — or search the destination first and I'll route to it.",
    };
    return;
  }

  // Anything left is treated as a place description, which is the product's
  // core job and the one thing that works fully without a model.
  const target = stripLeadIn(phrase);

  yield* runTool("resolve_place", { phrase: target }, context, (result) => {
    const data = result as {
      band?: string;
      best?: { name?: string; address?: string } | null;
      question?: string | null;
      driver_instruction?: string | null;
    };

    if (data.band === "low" || !data.best) {
      return `I couldn't pin that down. Try adding a landmark or the area — "${target}, in Wuse" or "near the filling station".`;
    }

    if (data.band === "moderate" && data.question) {
      return `${data.question}`;
    }

    const lines = [`Found it: ${data.best.name}.`];
    if (data.best.address) lines.push(data.best.address);
    if (data.driver_instruction) lines.push(`\n${data.driver_instruction}`);

    return lines.join(" ");
  });
}

/**
 * Run one tool and emit the same call/result/text events the real agent does,
 * so the UI cannot tell the difference structurally.
 */
async function* runTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
  phrase: (result: unknown) => string,
): AsyncGenerator<AgentEvent> {
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool) {
    yield { type: "error", message: `Tool ${name} is not registered.` };
    return;
  }

  yield { type: "tool_call", name, input };

  const result = await tool.execute(input, context);

  yield { type: "tool_result", name, result };

  if (typeof result === "object" && result !== null && "error" in result) {
    yield { type: "text", delta: String((result as { error: string }).error) };
    return;
  }

  yield { type: "text", delta: phrase(result) };
}

function matchCategory(phrase: string): { query: string; label: string } | null {
  for (const [pattern, query, label] of CATEGORY_PATTERNS) {
    if (pattern.test(phrase)) return { query, label };
  }
  return null;
}

/** Remove the conversational wrapper so the resolver sees the place itself. */
function stripLeadIn(phrase: string): string {
  return phrase
    .replace(
      /^\s*(please\s+)?(can you\s+)?(take me to|navigate to|directions to|how do i get to|show me|find|go to|drive to|get to|where is)\s+/i,
      "",
    )
    .replace(/\?+$/, "")
    .trim();
}

function formatMetres(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
