import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

async function main() {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });

  // 1. Plain call: where does the text actually live?
  const plain = (await client.interactions.create({
    model: "gemini-3.8-flash",
    input: "Say exactly: HELLO",
  } as never)) as any;

  console.log("PLAIN output_text:", JSON.stringify(plain.output_text));
  console.log("PLAIN steps:", (plain.steps ?? []).map((s: any) => s.type));
  for (const s of plain.steps ?? []) {
    console.log("  ", s.type, "->", JSON.stringify(s).slice(0, 260));
  }
}
main().catch(e => console.log("THREW:", e?.message ?? e));
