/**
 * What does the parser actually extract? Run: npx tsx scripts/parse-check.ts
 *
 * The parse step decides everything downstream: a phrase parsed as a bare
 * category ("school") searches for the nearest school, while the same phrase
 * parsed with its name ("christian community") searches for that place. This
 * prints both so the difference is visible rather than inferred.
 */

import { MockLlmProvider } from "../src/lib/providers/mock/llm";

const PHRASES = [
  "christian community school",
  "Christian Community School",
  "take me to christian community school",
  "clover hospital",
  "21 agadez street aminu kano crescent",
  "the guest house behind the mosque on Buhari Street, Wuse",
  "nigerian tulip international school",
  "jabi lake mall",
  "transcorp hilton",
  "a pharmacy in garki",
  "wuse market",
];

async function main(): Promise<void> {
  const parser = new MockLlmProvider();

  for (const phrase of PHRASES) {
    const parsed = await parser.parsePlacePhrase(phrase, { city: "Abuja", knownAreas: ["Wuse", "Wuse 2", "Garki", "Maitama"] });
    console.log(
      [
        JSON.stringify(phrase).padEnd(52),
        `name=${parsed.placeName ?? "—"}`.padEnd(34),
        `type=${parsed.placeType ?? "—"}`.padEnd(22),
        `street=${parsed.street ?? "—"}`.padEnd(26),
        `area=${parsed.area ?? "—"}`,
      ].join(" "),
    );
  }
}

void main();
