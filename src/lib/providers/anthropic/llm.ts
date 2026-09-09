/**
 * Claude-backed implementation of the parse step.
 *
 * Structured outputs, not free text: the response is constrained to the schema
 * below, which has no coordinate field anywhere in it. That is Part III, 3.2
 * enforced by the API rather than by asking nicely in a prompt — the model is
 * not able to return a lat/lng even if a user tries to talk it into one.
 *
 * Effort is set to "low" deliberately. This is a bounded extraction task on a
 * short string sitting in the latency path of every search, and low effort is
 * the documented setting for simple tasks. Raise it if harness scores show the
 * parser missing structure on hard phrases — that is a measurable question,
 * not a guess.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { LlmProvider } from "@/lib/providers/types";
import type { ParsedPlace, RelationType } from "@/lib/resolution/types";

const RELATION_TYPES = [
  "behind",
  "beside",
  "opposite",
  "in_front_of",
  "near",
  "after",
  "before",
  "inside",
  "along",
  "between",
] as const satisfies readonly RelationType[];

const ParsedPlaceSchema = z.object({
  placeType: z
    .string()
    .nullable()
    .describe('Category word only, e.g. "guest house", "filling station", "bank". Null if none.'),
  placeName: z
    .string()
    .nullable()
    .describe('Proper name only, e.g. "Bluewiz", "Crunchies". Null if the user gave no name.'),
  street: z
    .string()
    .nullable()
    .describe('Street including its type, e.g. "Buhari Street". Null if none.'),
  area: z
    .string()
    .nullable()
    .describe('Neighbourhood or district, e.g. "Wuse 2", "Rayfield". Null if none.'),
  city: z.string().nullable().describe('City, e.g. "Jos", "Abuja". Null if not stated or implied.'),
  houseNumber: z.string().nullable().describe("House, plot or building number. Null if none."),
  landmarkRelations: z
    .array(
      z.object({
        type: z.enum(RELATION_TYPES),
        anchor: z
          .string()
          .describe('The landmark itself, without the relation word. "the mosque" -> "mosque".'),
      }),
    )
    .describe("Spatial relations to landmarks. Empty array if none were given."),
  ambiguityNotes: z
    .array(z.string())
    .describe(
      "Short notes on what is underspecified and would need a follow-up question. Empty array if the description is complete.",
    ),
});

const SYSTEM_PROMPT = `You extract structure from the way people describe places in Nigeria.

You are given one phrase. Break it into its components. You are NOT searching for the place, and you are NOT identifying it — a separate system does that against real map data.

Absolute rule: never output a coordinate, a latitude, a longitude, or a full postal address you inferred rather than read. You only restate, in structured form, what the phrase actually says. If a component was not stated, it is null. Do not fill gaps with plausible guesses — a confident wrong area name is worse than a null, because it silently filters out the correct answer downstream.

Guidance specific to this domain:
- Nigerian addresses lean on landmarks. "behind the mosque", "opposite the filling station" and "after the junction" are the real address, not decoration. Capture every one.
- Strip the relation word from the anchor: "behind the mosque" gives anchor "mosque".
- Do not fold a street into an anchor. In "the mosque on Buhari Street", the anchor is "mosque" and the street is "Buhari Street".
- A generic anchor ("the bank", "the mosque") is still worth capturing, but note in ambiguityNotes that it names a category rather than a specific place.
- Duplicate street names across a city are common. If the phrase gives a street but no area, say so in ambiguityNotes.
- Keep the user's spelling of proper names. Do not correct or expand them.`;

/**
 * Which models accept `output_config.effort`.
 *
 * Haiku 4.5 and older models return a 400 when it is present, so sending it
 * unconditionally would break the cheap-model configuration that this project
 * defaults to.
 */
export function supportsEffort(model: string): boolean {
  if (model.startsWith("claude-haiku")) return false;
  return (
    model.startsWith("claude-opus") ||
    model.startsWith("claude-sonnet-5") ||
    model.startsWith("claude-fable") ||
    model.startsWith("claude-sonnet-4-6")
  );
}

/** Token counters, accumulated across every parse this provider has served. */
export interface ParseUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name: string;
  private readonly client: Anthropic;

  /**
   * Running total, so the harness can report what a corpus run actually cost
   * per model rather than estimating from token counts it never saw.
   */
  readonly usage: ParseUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };

  constructor(
    apiKey: string,
    private readonly model: string = "claude-opus-5",
  ) {
    this.client = new Anthropic({ apiKey });
    this.name = `anthropic:${model}`;
  }

  async parsePlacePhrase(
    phrase: string,
    hints: { city?: string; knownAreas?: string[] },
  ): Promise<ParsedPlace> {
    const contextLines: string[] = [];
    if (hints.city) {
      contextLines.push(`The user appears to be in or asking about ${hints.city}.`);
    }
    if (hints.knownAreas?.length) {
      contextLines.push(
        `Known areas in that city: ${hints.knownAreas.join(", ")}. Use one of these for "area" only if the phrase actually refers to it.`,
      );
    }

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      output_config: {
        // `effort` is rejected outright by Haiku 4.5 and the other pre-4.6
        // models, so it is only sent where it is actually supported. Low is
        // the right level regardless: this is a bounded extraction on a short
        // string, sitting in the latency path of every single search.
        ...(supportsEffort(this.model) ? { effort: "low" as const } : {}),
        format: zodOutputFormat(ParsedPlaceSchema),
      },
      messages: [
        {
          role: "user",
          content: [contextLines.join("\n"), `Phrase: ${phrase}`]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    this.usage.calls += 1;
    this.usage.inputTokens += response.usage.input_tokens ?? 0;
    this.usage.outputTokens += response.usage.output_tokens ?? 0;
    this.usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    const parsed = response.parsed_output;

    // A refusal or a schema-validation miss must not crash a search. Degrade to
    // an empty parse; the pipeline still has the raw phrase to text-search on.
    if (!parsed) {
      return {
        placeType: null,
        placeName: null,
        street: null,
        area: null,
        city: hints.city ?? null,
        houseNumber: null,
        landmarkRelations: [],
        ambiguityNotes: [
          response.stop_reason === "refusal"
            ? "Parser declined this phrase; falling back to raw text search."
            : "Parser returned no structured output; falling back to raw text search.",
        ],
      };
    }

    return {
      ...parsed,
      city: parsed.city ?? hints.city ?? null,
    };
  }
}
