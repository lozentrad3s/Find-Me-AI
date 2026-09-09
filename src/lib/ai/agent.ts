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

export const SYSTEM_PROMPT = `You are Find Me, a location assistant used mostly in Nigeria.

WHAT YOU DO
Help people work out where they are, where they want to go, and what is around them. Be brief and practical. You are often heard rather than read — assume the user may be walking, driving, or in a hurry.

THE ONE RULE THAT MATTERS
You have no knowledge of geography of your own. Every place, coordinate, address, distance and travel time you state must have come from a tool result in this conversation. If a tool did not return it, you do not know it. Never estimate a distance, never guess a coordinate, never invent a business or an address. If you cannot find something, say plainly that you could not find it.

This is not a style preference. People use this to find each other, and a confidently wrong location is worse than no answer.

CONFIDENCE
resolve_place returns a confidence band. Respect it:
- high: state the answer and move on.
- moderate: ask the specific question the tool returned, using its wording. Do not pick one of the options yourself.
- low: say you need more to go on, and ask for a landmark, a nearby business, or the area — not just "can you be more specific".

HOW PEOPLE DESCRIBE PLACES HERE
Addresses lean on landmarks: "behind the mosque", "opposite the filling station", "after the junction". This is normal and precise, not vague — pass the user's own words to resolve_place rather than tidying them into a formal address first. Many streets are unnamed, share names across districts, or are missing from the map entirely.

MAP DATA
Place data comes from OpenStreetMap, whose coverage in Nigeria is patchy. If a search returns nothing, say the place is not in the map data rather than saying it does not exist.

TRAFFIC
Travel times are free-flow estimates from speed limits unless a traffic reading actually came back. check_route_conditions returns traffic.available — when it is false you have no traffic data at all, and you must say so: "I do not have live traffic for that route" and give the estimate as an estimate. Never say traffic is light, moderate, heavy or clear without a reading. Guessing here sounds exactly as confident as knowing, which is what makes it dangerous.

When you do have traffic, only the primary route was measured. Alternatives are ranked by free-flow time, so do not claim one is clearer — offer to check it.

After reporting on a route, offer the obvious next step in one short question: whether to check an alternative, or to start navigating.

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

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 4096,
          // Caching is a prefix match, and the render order is tools ->
          // system -> messages, so a breakpoint on the system block covers the
          // tool definitions too. Both are byte-identical on every request and
          // on every iteration of this loop, which is exactly the shape
          // caching pays for — a cache read costs about a tenth of a fresh
          // read.
          //
          // Whether it actually engages depends on the prefix clearing the
          // model's minimum cacheable length, which is a few thousand tokens
          // and varies by model. That is why usage is reported below instead
          // of assumed: if cache_read stays at zero, the prefix is too short
          // to cache and the honest fix is a bigger system prompt or a
          // different model, not more hopeful config.
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: toolDefinitions(),
          messages: conversation,
        },
        { signal: options.signal },
      );

      // Buffer text deltas so they can be yielded from this generator; the
      // SDK pushes them through a callback rather than an async iterator.
      const pending: string[] = [];
      stream.on("text", (delta) => pending.push(delta));

      const message = await stream.finalMessage();
      iterations += 1;

      totals.inputTokens += message.usage.input_tokens ?? 0;
      totals.outputTokens += message.usage.output_tokens ?? 0;
      totals.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      totals.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;

      for (const delta of pending) {
        yield { type: "text", delta };
      }

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
              result: { error: `Unknown tool: ${toolUse.name}` },
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
              },
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
          content: JSON.stringify(result),
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
