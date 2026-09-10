/**
 * Gemini agent — the assistant on Google's models.
 *
 * Exists because Gemini's free tier needs no card, which makes the full
 * conversational product testable without billing set up. It emits the same
 * `AgentEvent` stream as the Claude agent, so the UI, the voice loop, the tool
 * trace and the map wiring are identical and neither path is second-class.
 *
 * WHY generateContent AND NOT THE INTERACTIONS API
 *
 * The Interactions API is the newer surface and its server-held history is
 * genuinely attractive on a request-quota free tier — follow-ups would send
 * only the new tool results instead of resending the conversation. It was
 * tried first and abandoned: the initial call worked and returned a
 * `function_call` step, but posting the `function_result` back with
 * `previous_interaction_id` never returned. It did not error; it hung past
 * 45 seconds, which is worse than failing, because a voice user is left
 * listening to silence.
 *
 * `generateContent` is stateless, well documented, and completes. Resending
 * history costs tokens the free tier does not meter, so the trade is nearly
 * free here.
 */

import { GoogleGenAI } from "@google/genai";

import { AGENT_TOOLS, TOOLS_BY_NAME, type ToolContext } from "./tools";
import type { AgentEvent, ChatMessage } from "./agent";
import { SYSTEM_PROMPT } from "./agent";

/** Free-tier friendly and fast enough for a voice loop. */
/*
 * gemini-3.7-flash, not 3.8.
 *
 * Measured against the live free tier: 3.8-flash is capped at TWENTY requests
 * per day per project (quotaId GenerateRequestsPerDayPerProjectPerModel-
 * FreeTier), which a single debugging session exhausts and which no real user
 * could live with. 3.7 and 3.6 flash answer normally on the same key.
 *
 * Worth re-checking if answers look weak — but a better model you cannot call
 * is worse than a good one you can.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";

/** Same ceiling as the Claude agent: cost and latency, not capability. */
const MAX_ITERATIONS = 6;

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
  id?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface RunGeminiOptions {
  messages: ChatMessage[];
  context: ToolContext;
  apiKey: string;
  model?: string;
  /**
   * Let Gemini ground answers on Google Search.
   *
   * Off by default. Grounding genuinely helps — Google's Nigeria place data is
   * far better than OpenStreetMap's, and it is the only realistic source for
   * the things OSM simply does not carry, like a photo of a building or a
   * description of what it looks like. But it also routes around this
   * project's own resolution engine, which is the thing being measured, so
   * turning it on silently would make the harness numbers meaningless.
   *
   * Enable deliberately. Note that Google's terms do not allow mixing search
   * grounding with custom function declarations on every model, so when this
   * is on the custom tools are still sent and the model chooses.
   */
  grounding?: boolean;
}

export async function* runGeminiAgent(
  options: RunGeminiOptions,
): AsyncGenerator<AgentEvent> {
  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_GEMINI_MODEL;

  const tools = buildTools(options);

  const contents: GeminiContent[] = options.messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = (await callModel(client, {
        model,
        contents,
        tools,
        // Gemini has a real system field on this surface, unlike Interactions.
        systemInstruction: SYSTEM_PROMPT,
      })) as {
        text?: string;
        functionCalls?: GeminiFunctionCall[];
        candidates?: Array<{ content?: GeminiContent }>;
      };

      const calls = (response.functionCalls ?? []).filter(
        (call): call is GeminiFunctionCall & { name: string } =>
          typeof call.name === "string",
      );

      if (calls.length === 0) {
        const text = response.text?.trim();
        if (text) yield { type: "text", delta: text };
        yield { type: "done" };
        return;
      }

      // Prose alongside a tool call is usually "let me check" — worth showing
      // to someone waiting on a voice reply.
      const preamble = response.text?.trim();
      if (preamble) yield { type: "text", delta: `${preamble}\n` };

      const results = await Promise.all(
        calls.map(async (call) => {
          const tool = TOOLS_BY_NAME.get(call.name);

          if (!tool) {
            return { call, result: { error: `Unknown tool: ${call.name}` } };
          }

          try {
            const result = await tool.execute(
              (call.args ?? {}) as Record<string, unknown>,
              options.context,
            );
            return { call, result };
          } catch (error) {
            return {
              call,
              result: {
                error: error instanceof Error ? error.message : "Tool failed.",
              },
            };
          }
        }),
      );

      for (const { call, result } of results) {
        yield { type: "tool_call", name: call.name, input: call.args ?? {} };
        yield { type: "tool_result", name: call.name, result };
      }

      /*
       * Echo the model's turn back verbatim, not a reconstruction of it.
       *
       * Gemini 3.x attaches a `thoughtSignature` to functionCall parts and
       * requires it back on the next request. Rebuilding the part from the
       * parsed `functionCalls` array drops that signature, and the API
       * rejects the follow-up outright:
       *
       *   400 "Function call is missing a thought_signature in functionCall
       *        parts. This is required for tools to work correctly"
       *
       * Passing `candidates[0].content` straight through preserves the
       * signature and any thought parts alongside it. Falling back to a
       * reconstruction only if the shape is unexpected.
       */
      const modelTurn = response.candidates?.[0]?.content;

      contents.push(
        modelTurn?.parts
          ? { role: "model", parts: modelTurn.parts }
          : { role: "model", parts: calls.map((call) => ({ functionCall: call })) },
      );
      contents.push({
        role: "user",
        parts: results.map(({ call, result }) => ({
          functionResponse: {
            name: call.name,
            // Must be an object; a bare string is rejected.
            response: (typeof result === "object" && result !== null
              ? result
              : { value: result }) as Record<string, unknown>,
          },
        })),
      });
    }

    yield {
      type: "error",
      message: `Stopped after ${MAX_ITERATIONS} tool calls without reaching an answer.`,
    };
  } catch (error) {
    yield { type: "error", message: describeError(error) };
  }
}

/**
 * The SDK's public `generateContent` is not in the exported type surface for
 * this shape, so the call is made through a narrow local type rather than
 * spreading `any` through the loop above.
 */
async function callModel(
  client: GoogleGenAI,
  params: {
    model: string;
    contents: GeminiContent[];
    tools: unknown[];
    systemInstruction: string;
  },
): Promise<unknown> {
  const models = client.models as unknown as {
    generateContent(input: Record<string, unknown>): Promise<unknown>;
  };

  return models.generateContent({
    model: params.model,
    contents: params.contents,
    config: {
      tools: params.tools,
      systemInstruction: params.systemInstruction,
    },
  });
}

function buildTools(options: RunGeminiOptions): unknown[] {
  const functionDeclarations = AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // `parametersJsonSchema` takes a plain JSON Schema; `parameters` expects
    // Google's own Schema type and rejects ours.
    parametersJsonSchema: tool.input_schema,
  }));

  const tools: unknown[] = [{ functionDeclarations }];

  if (options.grounding) tools.push({ googleSearch: {} });

  return tools;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // The three failures a Gemini key actually hits, named plainly rather than
  // handed back as a raw stack.
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return "Gemini free-tier limit reached — it resets after a minute. Try again shortly.";
  }
  if (/API key|401|403|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
    return "The Gemini API key was rejected. Check GEMINI_API_KEY in .env.local.";
  }
  if (/404|NOT_FOUND/i.test(message)) {
    return "That Gemini model is not available to this key. Try GEMINI_CHAT_MODEL=gemini-2.5-flash.";
  }

  return `Gemini error: ${message.slice(0, 200)}`;
}
