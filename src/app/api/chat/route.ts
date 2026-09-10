/**
 * POST /api/chat — the assistant, streamed as server-sent events.
 *
 * Streaming rather than a single JSON response because the loop can take
 * several seconds: Nominatim is rate-limited to roughly one call per second,
 * so a question needing resolve_place then calculate_route genuinely takes a
 * while. Showing which tool is running turns that wait into visible progress
 * instead of an apparently frozen app.
 *
 * The API key stays server-side. It is never sent to the browser.
 */

import { buildProviders } from "@/lib/providers/registry";
import { runAgent, type ChatMessage } from "@/lib/ai/agent";
import { runOfflineAgent } from "@/lib/ai/offline-agent";
import { NoTrafficProvider } from "@/lib/traffic/types";
import { TomTomTrafficProvider } from "@/lib/traffic/tomtom";

export const runtime = "nodejs";
/** Streaming responses must not be statically cached. */
export const dynamic = "force-dynamic";

interface ChatBody {
  messages?: unknown;
  lat?: unknown;
  lng?: unknown;
  city?: unknown;
}

const MAX_MESSAGES = 40;
const MAX_CONTENT_LENGTH = 4000;

export async function POST(request: Request): Promise<Response> {
  /*
   * No key is a degraded mode, not an error.
   *
   * Returning 503 here meant the entire conversational surface — chat, voice,
   * the tool trace, the map wiring driven by tool results — was untestable
   * until someone had billing set up. The offline agent runs the same tools
   * through the same event stream using keyword matching, so all of that can
   * be built and used now, and swapping in Claude changes one branch.
   *
   * It announces itself as offline in its first reply. A user who believes
   * they are talking to an assistant while actually talking to a regex will
   * conclude the assistant is bad, and they would be right.
   */
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

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

  // No key means no traffic data, and the tool says exactly that rather than
  // letting the model characterise congestion it never measured.
  const tomtomKey = process.env.TOMTOM_API_KEY?.trim();
  const traffic = tomtomKey
    ? new TomTomTrafficProvider(tomtomKey)
    : new NoTrafficProvider();

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      const toolContext = {
        providers,
        traffic,
        currentLocation:
          lat !== null && lng !== null ? { lat, lng } : undefined,
        city: typeof body.city === "string" ? body.city : undefined,
      };

      try {
        const stream = apiKey
          ? runAgent({
              apiKey,
              messages,
              model: process.env.ANTHROPIC_CHAT_MODEL?.trim() || undefined,
              context: toolContext,
              signal: request.signal,
            })
          : runOfflineAgent({
              messages,
              context: toolContext,
              // Only the first exchange explains the mode; repeating it every
              // turn would bury the answers.
              announce: messages.length <= 1,
            });

        for await (const event of stream) {
          send(controller, event);
        }
      } catch (error) {
        // The client has no other way to learn the stream died mid-flight.
        send(controller, {
          type: "error",
          message:
            error instanceof Error ? error.message : "The assistant failed.",
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

  // The Messages API requires the conversation to open with a user turn.
  while (messages.length > 0 && messages[0]?.role !== "user") messages.shift();

  return messages.length > 0 ? messages : null;
}
