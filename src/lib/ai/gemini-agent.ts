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
 *
 * SPEED
 *
 * Two changes aimed at the first word arriving sooner. Responses are
 * streamed, so text reaches the screen (and the speech engine) while the rest
 * is generated. And the thinking level defaults to LOW: this is a phrasing
 * task over tool results, not a reasoning problem, and the default level
 * spends seconds thinking before every reply.
 */

import { GoogleGenAI } from "@google/genai";

import { AGENT_TOOLS, TOOLS_BY_NAME, resultForModel, type ToolContext } from "./tools";
import type { AgentEvent, ChatMessage } from "./agent";
import { SYSTEM_PROMPT } from "./agent";

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

/**
 * Models to fall back through when the daily quota is exhausted.
 *
 * The free tier meters roughly TWENTY requests per day *per model*, so a
 * single afternoon of testing exhausts one and the assistant simply stops
 * answering. Rotating on a 429 turns ~20 requests a day into ~60 across three
 * models, which is the difference between being able to test and not.
 *
 * This is a testing accommodation, not a production strategy. Sixty requests
 * a day cannot serve real users; that needs a paid Gemini plan or an
 * Anthropic key. It is here so the free tier is usable for development rather
 * than dying halfway through an afternoon.
 */
const FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.8-flash"];

/**
 * Failures that another model might not have.
 *
 * Quota is per-model, so a 429 on one says nothing about the next. So does a
 * 503: "this model is currently experiencing high demand" is a property of
 * that model at that moment, and Google returns it often enough on the free
 * tier that not rolling over leaves the assistant dead for minutes at a time.
 *
 * Everything else propagates. A malformed request fails identically on every
 * model, and retrying it three times only makes the user wait three times as
 * long for the same error.
 */
function isRetryableOnAnotherModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|RESOURCE_EXHAUSTED|quota|503|UNAVAILABLE|high demand|overloaded/i.test(
    message,
  );
}

/** Same ceiling as the Claude agent: cost and latency, not capability. */
const MAX_ITERATIONS = 6;

/** MINIMAL | LOW | MEDIUM | HIGH. Override with GEMINI_THINKING_LEVEL. */
const DEFAULT_THINKING_LEVEL = "LOW";

/**
 * Set once a model rejects the thinking setting, so later requests in this
 * process stop sending it instead of failing and retrying every time.
 */
let thinkingRejected = false;

interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
  id?: string;
}

interface GeminiPart {
  text?: string;
  /** Internal reasoning, when the model chooses to include it. Never shown. */
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

interface CollectedTurn {
  parts: GeminiPart[];
  calls: Array<GeminiFunctionCall & { name: string }>;
  text: string;
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
   * far better than OpenStreetMap's — but it also routes around this
   * project's own resolution engine, which is the thing being measured, so
   * turning it on silently would make the harness numbers meaningless.
   */
  grounding?: boolean;
  /** Per-message context appended to the system instruction. */
  extraSystem?: string;
}

export async function* runGeminiAgent(
  options: RunGeminiOptions,
): AsyncGenerator<AgentEvent> {
  const client = new GoogleGenAI({ apiKey: options.apiKey });

  // Start on the configured model, then the rest of the ladder minus it.
  const preferred = options.model ?? DEFAULT_GEMINI_MODEL;
  const ladder = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  let modelIndex = 0;
  let model = ladder[0]!;

  const tools = buildTools(options);
  const systemInstruction = options.extraSystem
    ? `${SYSTEM_PROMPT}\n\n${options.extraSystem}`
    : SYSTEM_PROMPT;

  const contents: GeminiContent[] = options.messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let turn: CollectedTurn | null = null;

      /*
       * Try the current model; on a quota error move down the ladder and
       * retry the same turn — but only if nothing was shown yet. Once text
       * has reached the user, switching models mid-sentence would repeat it.
       */
      for (;;) {
        let emitted = false;
        try {
          const stream = streamTurn(client, {
            model,
            contents,
            tools,
            systemInstruction,
          });

          let step = await stream.next();
          while (!step.done) {
            emitted = true;
            yield { type: "text", delta: step.value };
            step = await stream.next();
          }
          turn = step.value;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (!emitted && !thinkingRejected && /thinking/i.test(message)) {
            thinkingRejected = true;
            continue;
          }

          if (emitted || !isRetryableOnAnotherModel(error) || modelIndex >= ladder.length - 1) {
            throw error;
          }
          modelIndex += 1;
          model = ladder[modelIndex]!;
        }
      }

      if (!turn || turn.calls.length === 0) {
        yield { type: "done" };
        return;
      }

      // Prose alongside a tool call is usually "let me check"; keep it on its
      // own line so the real answer does not run into it.
      if (turn.text.trim()) yield { type: "text", delta: "\n" };

      const results = await Promise.all(
        turn.calls.map(async (call) => {
          const tool = TOOLS_BY_NAME.get(call.name);

          if (!tool) {
            return { call, result: { error: `Unknown tool: ${call.name}` } as unknown };
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
              } as unknown,
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
       * parsed calls drops that signature, and the API rejects the follow-up:
       *
       *   400 "Function call is missing a thought_signature in functionCall
       *        parts. This is required for tools to work correctly"
       *
       * Streaming splits text across chunks, so adjacent plain text parts are
       * rejoined; anything carrying a signature is passed through untouched.
       */
      contents.push({ role: "model", parts: mergeTextParts(turn.parts) });
      contents.push({
        role: "user",
        parts: results.map(({ call, result }) => {
          const forModel = resultForModel(TOOLS_BY_NAME.get(call.name), result);
          return {
            functionResponse: {
              name: call.name,
              // Must be an object; a bare string is rejected.
              response: (typeof forModel === "object" && forModel !== null
                ? forModel
                : { value: forModel }) as Record<string, unknown>,
            },
          };
        }),
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
 * One streamed model turn: yields visible text as it arrives, returns every
 * part (for the echo) and every function call once the stream ends.
 *
 * The SDK's `generateContentStream` is not in the exported type surface for
 * this shape, so the call goes through a narrow local type rather than
 * spreading `any` through the loop above.
 */
async function* streamTurn(
  client: GoogleGenAI,
  params: {
    model: string;
    contents: GeminiContent[];
    tools: unknown[];
    systemInstruction: string;
  },
): AsyncGenerator<string, CollectedTurn> {
  const models = client.models as unknown as {
    generateContentStream(input: Record<string, unknown>): Promise<AsyncIterable<GeminiChunk>>;
  };

  const level = (process.env.GEMINI_THINKING_LEVEL?.trim() || DEFAULT_THINKING_LEVEL).toUpperCase();

  const stream = await models.generateContentStream({
    model: params.model,
    contents: params.contents,
    config: {
      tools: params.tools,
      systemInstruction: params.systemInstruction,
      ...(thinkingRejected || level === "DEFAULT"
        ? {}
        : { thinkingConfig: { thinkingLevel: level } }),
    },
  });

  const collected: CollectedTurn = { parts: [], calls: [], text: "" };

  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      collected.parts.push(part);

      if (part.functionCall && typeof part.functionCall.name === "string") {
        collected.calls.push(part.functionCall as GeminiFunctionCall & { name: string });
      } else if (typeof part.text === "string" && part.text && !part.thought) {
        collected.text += part.text;
        yield part.text;
      }
    }
  }

  return collected;
}

/** Join consecutive plain text parts; leave signed and non-text parts alone. */
function mergeTextParts(parts: GeminiPart[]): GeminiPart[] {
  const merged: GeminiPart[] = [];

  for (const part of parts) {
    const previous = merged[merged.length - 1];
    const plain = (p: GeminiPart | undefined) =>
      p !== undefined &&
      typeof p.text === "string" &&
      !p.functionCall &&
      !p.thoughtSignature &&
      !p.thought;

    if (plain(part) && plain(previous)) {
      previous!.text = `${previous!.text}${part.text}`;
    } else {
      merged.push({ ...part });
    }
  }

  return merged.length > 0 ? merged : [{ text: "" }];
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

  // The failures a Gemini key actually hits, named plainly rather than handed
  // back as a raw stack.
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return "Gemini's free-tier daily limit is reached on every model right now. It resets tomorrow, or add a paid plan.";
  }
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(message)) {
    return "Gemini is overloaded on every model right now. Try again in a moment.";
  }
  if (/API key|401|403|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
    return "The Gemini API key was rejected. Check GEMINI_API_KEY.";
  }
  if (/404|NOT_FOUND/i.test(message)) {
    return "That Gemini model is not available to this key. Try GEMINI_CHAT_MODEL=gemini-2.5-flash.";
  }

  return `Gemini error: ${message.slice(0, 200)}`;
}
