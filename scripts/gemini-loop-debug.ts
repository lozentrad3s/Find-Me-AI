import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

async function main() {
  const key = process.env.GEMINI_API_KEY!.trim();
  const client = new GoogleGenAI({ apiKey: key });

  const tools = [{
    type: "function",
    name: "get_time",
    description: "Get the current time in a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }];

  const first = (await client.interactions.create({
    model: "gemini-3.8-flash",
    input: "What time is it in Abuja? Use the tool.",
    tools,
  } as never)) as any;

  console.log("--- FIRST ---");
  console.log("id:", first.id);
  console.log("output_text:", JSON.stringify(first.output_text));
  console.log("step types:", (first.steps ?? []).map((s: any) => s.type));

  const call = (first.steps ?? []).find((s: any) => s.type === "function_call");
  if (!call) { console.log("no function_call"); return; }
  console.log("call:", call.name, JSON.stringify(call.arguments), "id:", call.id);

  const second = (await client.interactions.create({
    model: "gemini-3.8-flash",
    previous_interaction_id: first.id,
    tools,
    input: [{ type: "function_result", call_id: call.id, name: call.name, result: JSON.stringify({ time: "15:42" }) }],
  } as never)) as any;

  console.log("--- SECOND ---");
  console.log("output_text:", JSON.stringify(second.output_text));
  console.log("step types:", (second.steps ?? []).map((s: any) => s.type));
  for (const s of second.steps ?? []) {
    if (s.type !== "function_call") console.log("  step", s.type, ":", JSON.stringify(s).slice(0, 220));
  }
}
main().catch(e => console.log("THREW:", e?.message ?? e));
