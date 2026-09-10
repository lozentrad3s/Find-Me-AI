import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

async function main() {
  const c = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  try {
    const r = (await (c.models as never as {
      generateContent(i: Record<string, unknown>): Promise<{ text?: string }>;
    }).generateContent({ model: "gemini-3.8-flash", contents: "Say OK" })) as { text?: string };
    console.log("OK ->", r.text);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.log("quotaId :", m.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? "?");
    console.log("metric  :", m.match(/"quotaMetric"\s*:\s*"([^"]+)"/)?.[1] ?? "?");
    console.log("limit   :", m.match(/"quotaValue"\s*:\s*"?(\d+)/)?.[1] ?? "?");
    console.log("retry   :", m.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1] ?? "none");
  }
}
main();
