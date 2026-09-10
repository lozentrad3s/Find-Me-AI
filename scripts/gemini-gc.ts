import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
import { GoogleGenAI } from "@google/genai";

async function main() {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
  console.log("generateContent is fn:", typeof (client.models as any).generateContent);

  const tools = [{
    functionDeclarations: [{
      name: "get_time",
      description: "Get the current time in a city.",
      parametersJsonSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
  }];

  const contents: any[] = [
    { role: "user", parts: [{ text: "What time is it in Abuja? Use the tool." }] },
  ];

  const r1: any = await (client.models as any).generateContent({
    model: "gemini-3.8-flash", contents, config: { tools },
  });

  const calls = r1.functionCalls ?? [];
  console.log("round 1 calls:", JSON.stringify(calls));
  if (calls.length === 0) { console.log("text:", r1.text); return; }

  contents.push({ role: "model", parts: calls.map((c: any) => ({ functionCall: c })) });
  contents.push({
    role: "user",
    parts: calls.map((c: any) => ({
      functionResponse: { name: c.name, response: { time: "15:42" } },
    })),
  });

  const r2: any = await (client.models as any).generateContent({
    model: "gemini-3.8-flash", contents, config: { tools },
  });
  console.log("round 2 text:", JSON.stringify(r2.text));
}
main().catch(e => console.log("THREW:", (e?.message ?? e).toString().slice(0, 300)));
