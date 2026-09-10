/**
 * Gemini-backed implementation of the parse step.
 *
 * Structured output via `response_format`, so the model is constrained to a
 * schema that has no coordinate field anywhere in it. That is Part III, 3.2
 * enforced by the API rather than by asking nicely — the model cannot return
 * a lat/lng even if a user tries to talk it into one, exactly as with the
 * Claude provider.
 */

import { GoogleGenAI } from "@google/genai";

import type { LlmProvider } from "@/lib/providers/types";
import type { ParsedPlace, RelationType } from "@/lib/resolution/types";

const RELATION_TYPES: RelationType[] = [
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
];

/**
 * JSON Schema for a parsed place. Note the absence of any coordinate field —
 * that omission is the point, not an oversight.
 */
const PARSED_PLACE_SCHEMA = {
  type: "object",
  properties: {
    placeType: {
      type: ["string", "null"],
      description: 'Category word only: "guest house", "filling station", "bank". Null if none.',
    },
    placeName: {
      type: ["string", "null"],
      description: 'Proper name only: "Bluewiz", "Crunchies". Null if the user gave no name.',
    },
    street: {
      type: ["string", "null"],
      description: 'Street including its type: "Buhari Street". Null if none.',
    },
    area: {
      type: ["string", "null"],
      description: 'Neighbourhood or district: "Wuse 2", "Maitama". Null if none.',
    },
    city: { type: ["string", "null"], description: 'City: "Abuja". Null if not stated.' },
    houseNumber: { type: ["string", "null"], description: "House or plot number. Null if none." },
    landmarkRelations: {
      type: "array",
      description: "Spatial relations to landmarks. Empty array if none were given.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: RELATION_TYPES },
          anchor: {
            type: "string",
            description: 'The landmark without the relation word. "the mosque" -> "mosque".',
          },
        },
        required: ["type", "anchor"],
      },
    },
    ambiguityNotes: {
      type: "array",
      items: { type: "string" },
      description: "Short notes on what is underspecified. Empty array if complete.",
    },
  },
  required: [
    "placeType",
    "placeName",
    "street",
    "area",
    "city",
    "houseNumber",
    "landmarkRelations",
    "ambiguityNotes",
  ],
} as const;

const INSTRUCTIONS = `You extract structure from the way people describe places in Nigeria.

Break the phrase into components. You are NOT searching for the place and NOT identifying it — a separate system does that against real map data.

Absolute rule: never output a coordinate, latitude, longitude, or an address you inferred rather than read. Restate only what the phrase actually says. If a component was not stated, it is null. Do not fill gaps with plausible guesses — a confident wrong area name is worse than a null, because it silently filters out the correct answer downstream.

Domain notes:
- Nigerian addresses lean on landmarks. "behind the mosque", "opposite the filling station", "after the junction" are the real address, not decoration. Capture every one.
- Strip the relation word from the anchor: "behind the mosque" gives anchor "mosque".
- Do not fold a street into an anchor. In "the mosque on Buhari Street", anchor is "mosque" and street is "Buhari Street".
- Duplicate street names across a city are common. If a street is given with no area, note it in ambiguityNotes.
- Keep the user's spelling of proper names.`;

export class GeminiLlmProvider implements LlmProvider {
  readonly name: string;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string = "gemini-3.8-flash",
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.name = `gemini:${model}`;
  }

  async parsePlacePhrase(
    phrase: string,
    hints: { city?: string; knownAreas?: string[] },
  ): Promise<ParsedPlace> {
    const context: string[] = [];
    if (hints.city) context.push(`The user is asking about ${hints.city}.`);
    if (hints.knownAreas?.length) {
      context.push(
        `Known areas: ${hints.knownAreas.join(", ")}. Use one for "area" only if the phrase refers to it.`,
      );
    }

    const input = [
      INSTRUCTIONS,
      context.join("\n"),
      `Phrase: ${phrase}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const interaction = (await this.client.interactions.create({
        model: this.model,
        input,
        response_format: {
          type: "json_schema",
          json_schema: { name: "parsed_place", schema: PARSED_PLACE_SCHEMA },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as { output_text?: string };

      const raw = interaction.output_text?.trim();
      if (!raw) return empty(hints.city, "Parser returned nothing.");

      const parsed = JSON.parse(raw) as ParsedPlace;

      return {
        ...parsed,
        landmarkRelations: parsed.landmarkRelations ?? [],
        ambiguityNotes: parsed.ambiguityNotes ?? [],
        city: parsed.city ?? hints.city ?? null,
      };
    } catch (error) {
      // A parse failure must never take down a search — the pipeline can still
      // text-search the raw phrase.
      return empty(
        hints.city,
        error instanceof Error ? error.message : "Parser failed.",
      );
    }
  }
}

function empty(city: string | undefined, note: string): ParsedPlace {
  return {
    placeType: null,
    placeName: null,
    street: null,
    area: null,
    city: city ?? null,
    houseNumber: null,
    landmarkRelations: [],
    ambiguityNotes: [`${note} Falling back to raw text search.`],
  };
}
