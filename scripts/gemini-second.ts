import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

const tools = [{
  type: "function", name: "get_time",
  description: "Get the current time in a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}];

async function attempt(label: string, build: (id: string, callId: string) => any) {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  const first = (await client.interactions.create({
    model: "gemini-3.8-flash", input: "What time is it in Abuja? Use the tool.", tools,
  } as never)) as any;
  const call = (first.steps ?? []).find((s: any) => s.type === "function_call");
  if (!call) { console.log(label, "-> no call"); return; }

  const started = Date.now();
  try {
    const second = (await Promise.race([
      client.interactions.create(build(first.id, call.id) as never),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT 45s")), 45000)),
    ])) as any;
    console.log(`${label} -> OK in ${Date.now() - started}ms | text:`, JSON.stringify(second.output_text));
  } catch (e: any) {
    console.log(`${label} -> ${(e?.message ?? e).slice(0, 140)}`);
  }
}

async function main() {
  await attempt("A: with tools", (id, callId) => ({
    model: "gemini-3.8-flash", previous_interaction_id: id, tools,
    input: [{ type: "function_result", call_id: callId, name: "get_time", result: JSON.stringify({ time: "15:42" }) }],
  }));

  await attempt("B: no tools", (id, callId) => ({
    model: "gemini-3.8-flash", previous_interaction_id: id,
    input: [{ type: "function_result", call_id: callId, name: "get_time", result: JSON.stringify({ time: "15:42" }) }],
  }));

  await attempt("C: result as subcontent", (id, callId) => ({
    model: "gemini-3.8-flash", previous_interaction_id: id, tools,
    input: [{ type: "function_result", call_id: callId, name: "get_time",
      result: [{ type: "text", text: JSON.stringify({ time: "15:42" }) }] }],
  }));
}
main().catch(e => console.log("THREW:", e?.message ?? e));
