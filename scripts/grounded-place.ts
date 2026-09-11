/**
 * Can Google Search grounding name a place well enough to geocode it?
 * Run: npx tsx scripts/grounded-place.ts
 *
 * The idea under test: the model never supplies coordinates — it supplies a
 * better SEARCH STRING. OpenStreetMap knows where "Christian Community School,
 * Wuse 2" is; it does not know that "the school near Agadez Street" means that
 * school. Search is good at the second half, the geocoder at the first.
 *
 * Prints what came back, whether it was actually grounded, and how long it
 * took — latency decides whether this can sit in front of every lookup or only
 * behind a failed one. It walks the model ladder, because the free tier's
 * per-model daily quota is small enough to exhaust in an afternoon.
 */
import path from "node:path";
try {
  process.loadEnvFile(path.join(process.cwd(), ".env.local"));
} catch {
  /* env is optional here */
}

import { GoogleGenAI } from "@google/genai";

interface GenResponse {
  text?: string;
  candidates?: Array<{ groundingMetadata?: { webSearchQueries?: string[] } }>;
}

const MODELS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-2.5-flash"];

const QUERIES: Array<{ phrase: string; near: string }> = [
  { phrase: "christian community school", near: "Aminu Kano Crescent, Wuse 2, Abuja" },
  { phrase: "clover hospital", near: "Wuse 2, Abuja" },
  { phrase: "the school close to agadez street", near: "Wuse 2, Abuja" },
];

const INSTRUCTIONS = `You help a Nigerian map app turn a vague place description into a precise SEARCH STRING for a geocoder.

Rules:
- Never give coordinates. Never invent an address you did not find.
- Reply with JSON only: {"name": string|null, "address": string|null, "area": string|null, "confidence": "high"|"medium"|"low", "note": string|null}
- "name" is the official name of the place as written on signs or listings.
- "address" is the street address if you found one, otherwise null.
- If you cannot find the place near the stated location, set every field null and say why in "note".`;

async function main(): Promise<void> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    console.log("No GEMINI_API_KEY in .env.local");
    return;
  }

  const client = new GoogleGenAI({ apiKey: key });
  const models = client.models as never as {
    generateContent(input: Record<string, unknown>): Promise<GenResponse>;
  };

  let working: string | null = null;

  for (const { phrase, near } of QUERIES) {
    const preferred: string = working ?? MODELS[0]!;
    const ladder: string[] = [preferred, ...MODELS.filter((model) => model !== preferred)];
    let answered = false;

    for (const model of ladder) {
      const started = Date.now();
      try {
        const response = await models.generateContent({
          model,
          contents: `${INSTRUCTIONS}\n\nPlace: "${phrase}"\nNear: ${near}`,
          config: { tools: [{ googleSearch: {} }] },
        });

        const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
        console.log(`"${phrase}" via ${model} (${Date.now() - started}ms, grounded=${queries.length > 0})`);
        if (queries.length > 0) console.log(`  searched: ${queries.join(" | ")}`);
        console.log(`  ${(response.text ?? "").replace(/\s+/g, " ").slice(0, 400)}\n`);
        working = model;
        answered = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const quota = /429|RESOURCE_EXHAUSTED|quota/i.test(message);
        console.log(`  ${model}: ${quota ? "quota exhausted" : message.slice(0, 140)}`);
        if (!quota) break;
      }
    }

    if (!answered) console.log(`"${phrase}" — no model answered\n`);
  }
}

void main();
