/**
 * Does the engine find the place the user actually named?
 * Run: npx tsx scripts/resolve-check.ts
 *
 * These are real failures reported from Abuja, not fixtures: asked for
 * "christian community school" from Aminu Kano Crescent, the engine returned a
 * different school 139 m away, because the phrase was typed in lowercase and
 * the parser only recognised capitalised names — so it searched for the
 * nearest school of any name.
 *
 * Runs against LIVE OpenStreetMap, so it is slow (Nominatim allows one request
 * a second) and its results move as the map data does. It is a diagnostic to
 * run by hand, not a gate: `npm run harness` is the gated one.
 */
import path from "node:path";
try {
  process.loadEnvFile(path.join(process.cwd(), ".env.local"));
} catch {
  /* env is optional here */
}

import { buildProviders } from "../src/lib/providers/registry";
import { resolvePlace } from "../src/lib/resolution/pipeline";

/** Aminu Kano Crescent, Wuse 2 — where the reported failures happened. */
const HERE = { lat: 9.0788, lng: 7.4694 };

interface Case {
  phrase: string;
  /** What the answer should be called, roughly. */
  expect: RegExp;
}

const CASES: Case[] = [
  { phrase: "christian community school", expect: /christian community/i },
  { phrase: "take me to christian community school", expect: /christian community/i },
  { phrase: "clover hospital", expect: /clover/i },
  { phrase: "jabi lake mall", expect: /jabi lake/i },
  { phrase: "transcorp hilton", expect: /transcorp|hilton/i },
  { phrase: "wuse market", expect: /wuse market/i },
  { phrase: "nigerian tulip international school", expect: /tulip/i },
  // Category requests must stay category requests: no name to match here.
  { phrase: "a pharmacy in garki", expect: /.*/ },
];

async function main(): Promise<void> {
  const providers = buildProviders();
  console.log(`providers: places=${providers.places.name} geocoding=${providers.geocoding.name} parser=${providers.llm.name}\n`);

  let passed = 0;

  for (const testCase of CASES) {
    const started = Date.now();
    const result = await resolvePlace(testCase.phrase, providers, {
      context: { city: "abuja", currentLocation: HERE },
      enableLandmarkQuestions: false,
    });

    const best = result.best?.candidate.name ?? result.ranked[0]?.candidate.name ?? "(nothing)";
    const ok = testCase.expect.test(best);
    if (ok) passed += 1;

    console.log(
      `${ok ? "pass" : "FAIL"}  ${JSON.stringify(testCase.phrase)}  (${Date.now() - started}ms)`,
    );
    console.log(
      `      parsed: name=${result.parsed.placeName ?? "—"} type=${result.parsed.placeType ?? "—"} area=${result.parsed.area ?? "—"}`,
    );
    console.log(`      band: ${result.band.band} (margin ${result.band.margin.toFixed(2)})`);

    for (const entry of result.ranked.slice(0, 3)) {
      console.log(
        `        ${entry.score.toFixed(2)}  name=${(entry.signals.nameMatch ?? 0).toFixed(2)}  ` +
          `near=${(entry.signals.userProximity ?? 0).toFixed(2)}  ${entry.candidate.name}`,
      );
    }
    console.log();
  }

  console.log(`${passed}/${CASES.length} found the named place`);
}

void main();
