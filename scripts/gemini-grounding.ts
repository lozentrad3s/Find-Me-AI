/**
 * Does Google Search grounding actually work alongside our custom tools,
 * and can it supply what OSM cannot — descriptions and photos of a place?
 * Run: npx tsx scripts/gemini-grounding.ts
 */
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

interface GenResponse {
  text?: string;
  functionCalls?: Array<{ name?: string }>;
  candidates?: Array<{ groundingMetadata?: unknown }>;
}

async function attempt(label: string, tools: unknown[]) {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const models = client.models as never as {
    generateContent(i: Record<string, unknown>): Promise<GenResponse>;
  };

  try {
    const r = await models.generateContent({
      model: "gemini-3.7-flash",
      contents:
        "Describe the Transcorp Hilton building in Abuja: what colour is it, how many storeys, and is there a photo online? Be brief.",
      config: { tools },
    });

    const grounded = Boolean(r.candidates?.[0]?.groundingMetadata);
    console.log(`${label}\n  grounded: ${grounded}`);
    console.log(`  calls   : ${(r.functionCalls ?? []).map((c) => c.name).join(", ") || "-"}`);
    console.log(`  text    : ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 300)}\n`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.log(`${label}\n  FAILED: ${m.slice(0, 200)}\n`);
  }
}

async function main() {
  // Search alone — the best case for descriptive detail.
  await attempt("A. googleSearch only", [{ googleSearch: {} }]);

  // Search alongside our function declarations, which is how the agent runs.
  await attempt("B. googleSearch + custom functions", [
    { googleSearch: {} },
    {
      functionDeclarations: [
        {
          name: "resolve_place",
          description: "Turn a described place into coordinates.",
          parametersJsonSchema: {
            type: "object",
            properties: { phrase: { type: "string" } },
            required: ["phrase"],
          },
        },
      ],
    },
  ]);
}
main();
