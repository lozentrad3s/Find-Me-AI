import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

const CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-2.0-flash",
];

async function main() {
  const c = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const models = c.models as never as {
    generateContent(i: Record<string, unknown>): Promise<{ text?: string }>;
  };

  for (const model of CANDIDATES) {
    try {
      const r = await models.generateContent({ model, contents: "Say OK" });
      console.log(`  ${model.padEnd(24)} OK -> "${(r.text ?? "").trim().slice(0, 20)}"`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const limit = m.match(/"quotaValue"\s*:\s*"?(\d+)/)?.[1];
      const code = m.match(/"code"\s*:\s*(\d+)/)?.[1];
      console.log(`  ${model.padEnd(24)} ${code ?? "ERR"}${limit ? ` (daily limit ${limit})` : ""}`);
    }
  }
}
main();
