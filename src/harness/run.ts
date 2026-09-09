/**
 * The V0.1 exit test (master document, Part VIII).
 *
 *   "Resolve 20 real, awkwardly-described Jos addresses.
 *    Under 70% correct -> fix the engine, build nothing else."
 *
 * Run:  npm run harness
 *       npm run harness:jos
 *       npm run harness -- --city=abuja --verbose
 *       npm run harness -- --json=harness-results/baseline.json
 *
 * The exit code is 1 when the gate fails, so this can sit in CI as the thing
 * that stops the rest of the product being built on an engine that does not
 * work.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { buildProviders } from "@/lib/providers/registry";
import { resolvePlace } from "@/lib/resolution/pipeline";
import { BAND_MARKER } from "@/lib/resolution/band";
import { CITY_CENTRES, type FixtureCity } from "@/lib/providers/mock/fixtures";
import { JOS_CASES } from "@/lib/corpus/jos";
import { ABUJA_CASES } from "@/lib/corpus/abuja";
import type { CorpusCase } from "@/lib/corpus/types";
import { grade, summarise, type GradedCase } from "./grade";

/** The gate from Part VIII. */
const PASS_THRESHOLD = 0.7;

interface Args {
  city: FixtureCity | "both";
  verbose: boolean;
  jsonPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { city: "both", verbose: false, jsonPath: null };

  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") args.verbose = true;
    else if (arg.startsWith("--city=")) {
      const value = arg.slice("--city=".length).toLowerCase();
      if (value === "jos" || value === "abuja" || value === "both") {
        args.city = value;
      }
    } else if (arg.startsWith("--json=")) {
      args.jsonPath = arg.slice("--json=".length);
    }
  }

  return args;
}

function casesFor(city: Args["city"]): CorpusCase[] {
  if (city === "jos") return JOS_CASES;
  if (city === "abuja") return ABUJA_CASES;
  return [...JOS_CASES, ...ABUJA_CASES];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Optional — the whole pipeline runs on mocks with no env file at all.
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env"));
  } catch {
    /* no .env: mocks it is */
  }

  const providers = buildProviders();
  const cases = casesFor(args.city);

  /*
   * The corpus is bound to the fixtures.
   *
   * Every expectation names a fixture place id at a synthetic coordinate —
   * "Bluewiz Lodge" at 9.8493, 8.8766 exists nowhere but `fixtures.ts`.
   * Grading live OpenStreetMap results against those expectations does not
   * measure the engine, it measures whether reality happens to agree with
   * invented test data, and the answer is always no.
   *
   * This guard exists because the harness did exactly that once: run without
   * the mock env vars, it graded against live OSM and printed
   * "GATE FAILED - 5%" in the same authoritative format as a real result. A
   * meaningless number in the shape of a meaningful one is worse than no
   * number, so the run is now refused outright.
   */
  if (providers.places.name !== "mock" || providers.geocoding.name !== "mock") {
    console.error(
      [
        "",
        "REFUSING TO RUN",
        "=".repeat(72),
        `  Places provider:    ${providers.places.name}`,
        `  Geocoding provider: ${providers.geocoding.name}`,
        "",
        "  This corpus is bound to the fixtures — every expected answer is a",
        "  synthetic place at an invented coordinate. Scoring live map data",
        "  against it produces a number that looks authoritative and means",
        "  nothing.",
        "",
        "  To run the fixture harness:",
        "    PLACES_PROVIDER=mock GEOCODING_PROVIDER=mock LLM_PROVIDER=mock npm run harness",
        "",
        "  To run the REAL exit test, the corpus needs real expected",
        "  coordinates — 20 addresses collected from people in Jos, each with a",
        "  verified point. That corpus does not exist yet, and building it is",
        "  the actual next step in Part VIII.",
        "=".repeat(72),
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  header(providers, cases.length, args.city);

  const graded: GradedCase[] = [];

  for (const corpusCase of cases) {
    const result = await resolvePlace(corpusCase.phrase, providers, {
      context: {
        city: corpusCase.city,
        // The device is in the city centre. Realistic, and it keeps the
        // user-proximity signal exercised rather than always null.
        currentLocation: CITY_CENTRES[corpusCase.city],
      },
    });

    const entry = grade(corpusCase, result);
    graded.push(entry);
    printCase(entry, args.verbose);
  }

  const summary = summarise(graded);
  printSummary(summary);

  if (args.jsonPath) {
    await writeJson(args.jsonPath, graded, summary);
    console.log(`\nWrote full results to ${args.jsonPath}`);
  }

  const passed = summary.passRate >= PASS_THRESHOLD;
  console.log(
    passed
      ? `\n✅ GATE PASSED — ${pct(summary.passRate)} at or above the ${pct(
          PASS_THRESHOLD,
        )} threshold.`
      : `\n❌ GATE FAILED — ${pct(summary.passRate)} is below the ${pct(
          PASS_THRESHOLD,
        )} threshold.\n   Per Part VIII: fix the engine, build nothing else.`,
  );

  process.exitCode = passed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function header(
  providers: ReturnType<typeof buildProviders>,
  count: number,
  city: string,
): void {
  console.log("\nFIND ME — RESOLUTION ENGINE HARNESS");
  console.log("=".repeat(72));
  console.log(`Cases      ${count} (${city})`);
  console.log(
    `Providers  places=${providers.places.name}  geocoding=${providers.geocoding.name}  llm=${providers.llm.name}`,
  );

  for (const note of providers.notes) console.log(`           ! ${note}`);

  if (providers.places.name === "mock") {
    console.log(
      "\n  NOTE: running on fixtures, not real map data. This proves the pipeline\n" +
        "  works; it does not answer the exit test. That needs real Places data and\n" +
        "  real phrases from real users.",
    );
  }

  console.log("=".repeat(72));
}

const OUTCOME_MARK = { pass: "✓", soft: "~", fail: "✗" } as const;

function printCase(entry: GradedCase, verbose: boolean): void {
  const { case: corpusCase, result, outcome, note } = entry;
  const mark = OUTCOME_MARK[outcome];
  const band = BAND_MARKER[result.band.band];

  console.log(
    `\n${mark} ${corpusCase.id}  ${band} ${result.band.band.padEnd(8)} ${corpusCase.difficulty.padEnd(8)} "${corpusCase.phrase}"`,
  );

  if (result.best) {
    console.log(
      `    -> ${result.best.candidate.name}  (${result.best.score.toFixed(
        2,
      )}, margin ${result.band.margin.toFixed(2)}, via ${result.best.candidate.source})`,
    );
    if (result.best.reasons.length > 0) {
      console.log(`       because: ${result.best.reasons.join("; ")}`);
    }
  }

  if (result.question) {
    console.log(`    ? ${result.question.question}`);
  }

  if (note) console.log(`    ! ${note}`);

  if (verbose) printVerbose(entry);
}

function printVerbose(entry: GradedCase): void {
  const { result } = entry;
  const parsed = result.parsed;

  const components = Object.entries({
    name: parsed.placeName,
    type: parsed.placeType,
    street: parsed.street,
    area: parsed.area,
    city: parsed.city,
    number: parsed.houseNumber,
  })
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  console.log(`       parsed: ${components || "(nothing extracted)"}`);

  if (parsed.landmarkRelations.length > 0) {
    console.log(
      `       relations: ${parsed.landmarkRelations
        .map((r) => `${r.type} "${r.anchor}"`)
        .join(", ")}`,
    );
  }

  for (const note of parsed.ambiguityNotes) {
    console.log(`       note: ${note}`);
  }

  for (const candidate of result.ranked.slice(0, 4)) {
    const signals = Object.entries(candidate.signals)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key.slice(0, 6)}=${(value as number).toFixed(2)}`)
      .join(" ");
    console.log(
      `       ${candidate.score.toFixed(2)}  ${candidate.candidate.name.padEnd(34)} ${signals}`,
    );
  }

  if (result.reverse) {
    console.log(`       driver: "${result.reverse.driverInstruction}"`);
  }
}

function printSummary(summary: ReturnType<typeof summarise>): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY");
  console.log("=".repeat(72));
  console.log(
    `  pass ${String(summary.pass).padStart(3)}   right place, appropriate confidence`,
  );
  console.log(
    `  soft ${String(summary.soft).padStart(3)}   right place, miscalibrated confidence`,
  );
  console.log(
    `  fail ${String(summary.fail).padStart(3)}   wrong place, or confidently wrong`,
  );
  console.log(`  ---------`);
  console.log(`  pass rate   ${pct(summary.passRate)}   <- the exit-test number`);
  console.log(`  reach rate  ${pct(summary.reachRate)}   pass + soft`);

  console.log("\n  by difficulty");
  for (const [difficulty, counts] of Object.entries(summary.byDifficulty)) {
    const total = counts.pass + counts.soft + counts.fail;
    console.log(
      `    ${difficulty.padEnd(9)} ${counts.pass}/${total} pass, ${counts.soft} soft, ${counts.fail} fail`,
    );
  }
}

async function writeJson(
  jsonPath: string,
  graded: GradedCase[],
  summary: ReturnType<typeof summarise>,
): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        summary,
        cases: graded.map((entry) => ({
          id: entry.case.id,
          phrase: entry.case.phrase,
          difficulty: entry.case.difficulty,
          expect: entry.case.expect,
          outcome: entry.outcome,
          note: entry.note,
          band: entry.result.band,
          parsed: entry.result.parsed,
          question: entry.result.question,
          top: entry.result.ranked.slice(0, 5).map((c) => ({
            name: c.candidate.name,
            placeId: c.candidate.placeId,
            source: c.candidate.source,
            score: c.score,
            signals: c.signals,
          })),
          timings: entry.result.timings,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

main().catch((error: unknown) => {
  console.error("\nHarness failed to run:\n", error);
  process.exitCode = 1;
});
