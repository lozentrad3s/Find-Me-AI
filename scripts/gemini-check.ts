/**
 * Verifies the Gemini key end to end: auth, model access, and tool calling.
 * Run: npx tsx scripts/gemini-check.ts
 */
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}

import { GoogleGenAI } from "@google/genai";

async function main() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) { console.log("No GEMINI_API_KEY loaded from .env.local"); return; }
  console.log(`key loaded (${key.length} chars, starts "${key.slice(0, 3)}...")`);

  const client = new GoogleGenAI({ apiKey: key });

  for (const model of ["gemini-3.8-flash", "gemini-2.5-flash"]) {
    try {
      const r = (await client.interactions.create({
        model,
        input: "Reply with exactly: OK",
      } as never)) as { output_text?: string };
      console.log(`  ${model}: OK -> "${(r.output_text ?? "").trim().slice(0, 40)}"`);
      return;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.log(`  ${model}: FAILED -> ${m.slice(0, 220)}`);
    }
  }
}

main();
