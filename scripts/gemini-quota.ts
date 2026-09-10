/**
 * Reports the live free-tier quota for each model. Run when 429s appear:
 *   npx tsx scripts/gemini-quota.ts
 */
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

const MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];

async function main() {
  const c = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const models = c.models as never as {
    generateContent(i: Record<string, unknown>): Promise<{ text?: string }>;
  };

  for (const model of MODELS) {
    try {
      const r = await models.generateContent({ model, contents: "OK" });
      console.log(`  ${model.padEnd(20)} available -> "${(r.text ?? "").trim().slice(0, 12)}"`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const id = m.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? "?";
      const limit = m.match(/"quotaValue"\s*:\s*"?(\d+)/)?.[1] ?? "?";
      const retry = m.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1] ?? "-";
      console.log(`  ${model.padEnd(20)} EXHAUSTED  limit=${limit}/day  retry=${retry}  (${id})`);
    }
  }
}
main();
