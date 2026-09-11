/**
 * Intent harness — does Find Me read the request correctly before answering?
 *
 * Run: npm run harness:intents
 *
 * Every case here is a phrasing a real person used or plausibly would, and
 * each one asserts the kind of request it is plus the detail that matters
 * (the category, the corrected name, the roads). When a real user is misread,
 * add their exact words here first, watch it fail, then fix the classifier.
 *
 * No network, no model: the classifier is deterministic, so this runs in a
 * second and can gate CI.
 */

import { classifyIntent, type ContextPlace, type IntentKind } from "@/lib/ai/intent";

interface Case {
  text: string;
  expect: IntentKind;
  category?: string;
  target?: RegExp;
  area?: string;
  roads?: string[];
  corrected?: string;
  place?: string;
  withPlaces?: boolean;
  lastAssistant?: string;
}

const PLACES: ContextPlace[] = [
  { id: "a", name: "Chicken Republic Wuse", lat: 9.07, lng: 7.47 },
  { id: "b", name: "Kilimanjaro Jabi", lat: 9.07, lng: 7.42 },
  { id: "c", name: "The Kitchen Maitama", lat: 9.08, lng: 7.49 },
];

const OFFER = "The closest is Chicken Republic Wuse, 600 metres away. Want directions?";

const CASES: Case[] = [
  // --- weather, and not a place -------------------------------------------
  { text: "what's the weather like", expect: "weather" },
  { text: "is it going to rain today", expect: "weather" },
  { text: "will it rain in Maitama tomorrow", expect: "weather", target: /maitama/i },
  { text: "weather in maintama", expect: "weather", target: /^maitama$/i, corrected: "Maitama" },
  { text: "how hot is it outside", expect: "weather" },
  { text: "do I need an umbrella", expect: "weather" },
  { text: "forecast for the weekend", expect: "weather" },
  { text: "is there a storm coming", expect: "weather" },

  // --- areas and spelling --------------------------------------------------
  { text: "where is maitama", expect: "area_info", target: /^maitama$/i },
  { text: "find me AI where is maintama", expect: "area_info", target: /^maitama$/i, corrected: "Maitama" },
  { text: "maintama", expect: "area_info", corrected: "Maitama" },
  { text: "tell me about wuse 2", expect: "area_info", target: /^wuse 2$/i },
  { text: "what is in garki", expect: "area_info", target: /^garki$/i },
  { text: "gwarimpa", expect: "area_info", target: /gwarinpa/i },
  { text: "where is asokor", expect: "area_info", corrected: "Asokoro" },

  // --- place lookups -------------------------------------------------------
  // A name in front of a category is one specific place. Answering these with
  // "the nearest hospital" is what sent a user miles from the place they named.
  { text: "clover hospital", expect: "place_lookup", target: /clover/i },
  { text: "christian community school", expect: "place_lookup", target: /christian community/i },
  { text: "nigerian tulip school", expect: "place_lookup", target: /tulip/i },
  { text: "jabi lake mall", expect: "place_lookup", target: /jabi lake mall/i },
  { text: "wuse market", expect: "place_lookup", target: /wuse market/i },
  { text: "where is jabi lake mall", expect: "place_lookup", target: /jabi lake mall/i },
  { text: "find transcorp hilton", expect: "place_lookup", target: /transcorp hilton/i },
  { text: "the guest house behind the mosque on Buhari Street, Wuse", expect: "place_lookup" },
  { text: "plot 1234 aminu kano crescent", expect: "place_lookup" },

  // --- nearby --------------------------------------------------------------
  { text: "find me the closest restaurant", expect: "nearby", category: "restaurant" },
  { text: "closest restaurant from my location", expect: "nearby", category: "restaurant" },
  { text: "I'm hungry", expect: "nearby", category: "restaurant" },
  { text: "where can I get fuel", expect: "nearby", category: "fuel" },
  { text: "nearest bus terminal", expect: "nearby", category: "bus station" },
  { text: "closest bus terminal", expect: "nearby", category: "bus station" },
  { text: "any motor park around here", expect: "nearby", category: "bus station" },
  { text: "bus park", expect: "nearby", category: "bus station" },
  { text: "pharmacies near me", expect: "nearby", category: "pharmacy" },
  { text: "hospital", expect: "nearby", category: "hospital" },
  { text: "atm close to me", expect: "nearby", category: "atm" },
  { text: "restaurants in maitama", expect: "nearby", category: "restaurant", area: "Maitama" },
  { text: "hotels in wuse 2", expect: "nearby", category: "hotel", area: "Wuse 2" },
  { text: "is there a supermarket nearby", expect: "nearby", category: "supermarket" },
  { text: "find a market", expect: "nearby", category: "market" },
  { text: "police station near me", expect: "nearby", category: "police station" },
  { text: "car park near me", expect: "nearby", category: "parking" },
  { text: "a park to relax", expect: "nearby", category: "park" },
  { text: "where can I eat in maitama", expect: "nearby", category: "restaurant", area: "Maitama" },

  // --- road traffic --------------------------------------------------------
  { text: "is there traffic on sani abacha road", expect: "road_traffic", roads: ["Sani Abacha Way"] },
  {
    text: "find me is there traffic on sani abacha road, or murtala road",
    expect: "road_traffic",
    roads: ["Sani Abacha Way", "Murtala Mohammed Expressway"],
  },
  { text: "how is traffic along ahmadu bello way", expect: "road_traffic", roads: ["Ahmadu Bello Way"] },
  { text: "traffic on airport road now", expect: "road_traffic", roads: ["Umaru Musa Yar'Adua Expressway"] },
  { text: "any go slow at berger junction", expect: "road_traffic", roads: ["Berger Roundabout"] },
  { text: "is there traffic to jabi", expect: "directions", target: /jabi/i },
  { text: "how's the traffic", expect: "unknown" },

  // --- directions ----------------------------------------------------------
  { text: "take me to jabi lake mall", expect: "directions", target: /jabi lake mall/i },
  { text: "how do I get to maitama", expect: "directions", target: /maitama/i },
  { text: "directions to the national hospital", expect: "directions", target: /national hospital/i },
  { text: "take me to the nearest pharmacy", expect: "directions", category: "pharmacy" },
  { text: "how far is kubwa", expect: "directions", target: /kubwa/i },
  { text: "take me there", expect: "unknown" },

  // --- follow-ups about places on screen -----------------------------------
  { text: "take me there", expect: "directions", place: "a", withPlaces: true },
  { text: "yes", expect: "directions", place: "a", withPlaces: true, lastAssistant: OFFER },
  { text: "yes please", expect: "directions", place: "a", withPlaces: true, lastAssistant: OFFER },
  { text: "yes", expect: "unknown", withPlaces: true, lastAssistant: "Did you mean Maitama?" },
  { text: "directions to the second one", expect: "directions", place: "b", withPlaces: true },
  { text: "take me to kilimanjaro", expect: "directions", place: "b", withPlaces: true },
  { text: "ok let's go", expect: "directions", place: "a", withPlaces: true, lastAssistant: OFFER },
  { text: "navigate to the last one", expect: "directions", place: "c", withPlaces: true },
  { text: "take me to jabi lake mall", expect: "directions", target: /jabi lake mall/i, withPlaces: true },

  // --- the rest ------------------------------------------------------------
  { text: "hello", expect: "smalltalk" },
  { text: "thanks", expect: "smalltalk" },
  { text: "who are you", expect: "smalltalk" },
  { text: "where am I", expect: "where_am_i" },
  { text: "I'm lost", expect: "where_am_i" },
  { text: "what street is this", expect: "where_am_i" },
  { text: "can you help me", expect: "unknown" },
  { text: "what time is it", expect: "unknown" },
];

function check(testCase: Case): string[] {
  const intent = classifyIntent(testCase.text, {
    places: testCase.withPlaces ? PLACES : [],
    lastAssistant: testCase.lastAssistant ?? null,
  });

  const problems: string[] = [];

  if (intent.kind !== testCase.expect) problems.push(`kind ${intent.kind} (${intent.reason})`);
  if (testCase.category && intent.category?.query !== testCase.category) {
    problems.push(`category ${intent.category?.query ?? "none"}`);
  }
  if (testCase.target && !testCase.target.test(intent.target ?? "")) {
    problems.push(`target "${intent.target ?? ""}"`);
  }
  if (testCase.area && intent.area !== testCase.area) problems.push(`area ${intent.area ?? "none"}`);
  if (testCase.corrected && !intent.corrections.some((c) => c.name === testCase.corrected)) {
    problems.push(`no correction to ${testCase.corrected}`);
  }
  if (testCase.place && intent.place?.id !== testCase.place) {
    problems.push(`place ${intent.place?.id ?? "none"}`);
  }
  if (testCase.roads) {
    const got = intent.roads ?? [];
    const missing = testCase.roads.filter((road) => !got.includes(road));
    if (missing.length > 0) problems.push(`roads [${got.join(", ")}]`);
  }

  return problems;
}

function main(): void {
  let failed = 0;

  for (const testCase of CASES) {
    const problems = check(testCase);
    const ok = problems.length === 0;
    if (!ok) failed += 1;

    const context = testCase.withPlaces ? " [places]" : "";
    console.log(
      `${ok ? "pass" : "FAIL"}  ${testCase.expect.padEnd(12)} ${JSON.stringify(testCase.text)}${context}${
        ok ? "" : `  -> ${problems.join("; ")}`
      }`,
    );
  }

  const passed = CASES.length - failed;
  const rate = Math.round((passed / CASES.length) * 100);
  console.log(`\n${passed}/${CASES.length} passed (${rate}%)`);

  // Every case is a phrasing someone used; any failure is a real misread.
  if (failed > 0) process.exit(1);
}

main();
