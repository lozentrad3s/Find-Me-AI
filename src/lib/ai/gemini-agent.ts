/**
 * Gemini agent — the assistant on Google's models.
 *
 * Exists because Gemini's free tier needs no card, which makes the full
 * conversational product testable today rather than after billing is set up.
 * It emits the same `AgentEvent` stream as the Claude agent, so the UI, the
 * voice loop, the tool trace and the map wiring are all identical and neither
 * path is a second-class citizen.
 *
 * Uses the Interactions API, which is server-stateful: after the first call,
 * follow-ups carry `previous_interaction_id` and send only the new tool
 * results instead of resending the whole conversation. That is a real
 * advantage over resending history every turn on a free tier with request
 * quotas rather than token quotas.
 *
 * Google Search and Google Maps grounding are available as built-in tools and
 * are deliberately OFF by default — see GROUNDING below.
 */

import { GoogleGenAI } from "@google/genai";

import { AGENT_TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools";
import type { AgentEvent, ChatMessage } from "./agent";
import { SYSTEM_PROMPT } from "./agent";

/** Free-tier friendly and fast enough for a voice loop. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** Same ceiling as the Claude agent: cost and latency, not capability. */
const MAX_ITERATIONS = 6;

interface FunctionCallStep {
  type: "function_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface InteractionLike {
  id?: string;
  steps?: unknown[];
  output_text?: string;
}

/** Narrow an unknown step to a function call without trusting the SDK union. */
function isFunctionCall(step: unknown): step is FunctionCallStep {
  if (typeof step !== "object" || step === null) return false;
  const candidate = step as Record<string, unknown>;
  return (
    candidate.type === "function_call" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string"
  );
}

export interface RunGeminiOptions {
  messages: ChatMessage[];
  context: ToolContext;
  apiKey: string;
  model?: string;
  /**
   * Let Gemini ground answers on Google Search and Google Maps.
   *
   * Off by default, and the default is the considered position rather than
   * caution for its own sake. Grounding would genuinely help — Google's
   * Nigeria place data is far better than OpenStreetMap's — but it routes
   * around this product's own resolution engine, which is the thing being
   * built and measured. Turning it on quietly would make the harness numbers
   * meaningless and hide whether the engine is improving.
   *
   * Enable it deliberately, for a comparison, not as a default.
   */
  grounding?: boolean;
}

export async function* runGeminiAgent(
  options: RunGeminiOptions,
): AsyncGenerator<AgentEvent> {
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_GEMINI_MODEL;

  const tools = buildTools(options);

  // Gemini has no dedicated system field on this surface, so the instructions
  // ride at the front of the first user turn.
  const history = options.messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");

  const opening = `${SYSTEM_PROMPT}\n\n---\n\n${history}\n\nAssistant:`;

  let previousId: string | undefined;
  let pendingInput: unknown = opening;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const interaction = (await client.interactions.create({
        model,
        input: pendingInput,
        tools,
        ...(previousId ? { previous_interaction_id: previousId } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as InteractionLike;

      previousId = interaction.id;

      const calls = (interaction.steps ?? []).filter(isFunctionCall);

      if (calls.length === 0) {
        const text = interaction.output_text?.trim();
        if (text) yield { type: "text", delta: text };
        yield { type: "done" };
        return;
      }

      // Any prose Gemini produced alongside the tool calls is worth showing —
      // it is usually "let me check that for you", which is exactly the
      // reassurance a waiting voice user needs.
      const preamble = interaction.output_text?.trim();
      if (preamble) yield { type: "text", delta: `${preamble}\n` };

      const results = await Promise.all(
        calls.map(async (call) => {
          const tool = TOOLS_BY_NAME.get(call.name);

          if (!tool) {
            return {
              call,
              result: { error: `Unknown tool: ${call.name}` },
              isError: true,
            };
          }

          try {
            const result = await tool.execute(
              (call.arguments ?? {}) as Record<string, unknown>,
              options.context,
            );
            return { call, result, isError: false };
          } catch (error) {
            return {
              call,
              result: {
                error: error instanceof Error ? error.message : "Tool failed.",
              },
              isError: true,
            };
          }
        }),
      );

      for (const { call, result } of results) {
        yield { type: "tool_call", name: call.name, input: call.arguments };
        yield { type: "tool_result", name: call.name, result };
      }

      // Only the new results go back; the server still holds the history.
      pendingInput = results.map(({ call, result, isError }) => ({
        type: "function_result" as const,
        call_id: call.id,
        name: call.name,
        result: JSON.stringify(result),
        ...(isError ? { is_error: true } : {}),
      }));
    }

    yield {
      type: "error",
      message: `Stopped after ${MAX_ITERATIONS} tool calls without reaching an answer.`,
    };
  } catch (error) {
    yield { type: "error", message: describeError(error) };
  }
}

function buildTools(options: RunGeminiOptions): unknown[] {
  const functions = AGENT_TOOLS.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));

  if (!options.grounding) return functions;

  const location = options.context.currentLocation;

  return [
    ...functions,
    { type: "google_search" as const },
    {
      type: "google_maps" as const,
      ...(location ? { latitude: location.lat, longitude: location.lng } : {}),
    },
  ];
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // The two failures a new Gemini key actually hits, named plainly rather than
  // handed back as a raw stack.
  if (/API key|401|403|PERMISSION_DENIED/i.test(message)) {
    return "The Gemini API key was rejected. Check GEMINI_API_KEY in your environment.";
  }
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return "Gemini free-tier quota reached. Wait a minute and try again, or switch models.";
  }

  return `Gemini error: ${message}`;
}
