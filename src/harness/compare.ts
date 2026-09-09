/**
 * Model comparison for the parse step.
 *
 *   npm run harness:models
 *   npm run harness:models -- --models=claude-haiku-4-5,claude-sonnet-5
 *   npm run harness:models -- --city=jos
 *
 * The question "which cheap model is good enough" has no answer in the
 * abstract — it depends entirely on this corpus and this pipeline. So this
 * runs the same corpus once per model, changing nothing but the parser, and
 * reports accuracy against measured cost.
 *
 * The rule-based parser is included as a baseline on purpose. If a model
 * cannot beat a few hundred lines of regex on these phrases, it is not
 * earning its latency or its money, and that is worth finding out before
 * building on it.
 *
 * Costs money: every model runs the full corpus. Requires ANTHROPIC_API_KEY.
 */

import path from "node:path";

import { AnthropicLlmProvider } from "@/lib/providers/anthropic/llm";
import { MockLlmProvider } from "@/lib/providers/mock/llm";
import { MockPlacesProvider } from "@/lib/providers/mock/places";
import { MockGeocodingProvider } from "@/lib/providers/mock/geocoding";
import type { LlmProvider, Providers } from "@/lib/providers/types";
import { resolvePlace } from "@/lib/resolution/pipeline";
import { CITY_CENTRES, type FixtureCity } from "@/lib/providers/mock/fixtures";
import { JOS_CASES } from "@/lib/corpus/jos";
import { ABUJA_CASES } from "@/lib/corpus/abuja";
import type { CorpusCase } from "@/lib/corpus/types";
import { grade, summarise, type GradedCase } from "./grade";

const DEFAULT_MODELS = ["claude-haiku-4-5", "claude-sonnet-5"];

/** Input / output USD per million tokens. Verify against current pricing. */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};

interface Row {
  label: string;
  pass: number;
  soft: number;
  fail: number;
  passRate: number;
  reachRate: number;
  meanParseMs: number;
  costUsd: number | null;
  tokens: string;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env"));
  } catch {
    /* optional */
  }
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env.local"));
  } catch {
    /* optional */
  }

  const argv = process.argv.slice(2);
  const cityArg = argv.find((a) => a.startsWith("--city="))?.slice(7);
  const modelsArg = argv.find((a) => a.startsWith("--models="))?.slice(9);

  const cases: CorpusCase[] =
    cityArg === "jos" ? JOS_CASES : cityArg === "abuja" ? ABUJA_CASES : [...JOS_CASES, ...ABUJA_CASES];

  const models = modelsArg ? modelsArg.split(",").map((m) => m.trim()) : DEFAULT_MODELS;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  console.log("\nFIND ME — PARSE MODEL COMPARISON");
  console.log("=".repeat(78));
  console.log(`Corpus  ${cases.length} cases (${cityArg ?? "both cities"})`);
  console.log(
    "Places and geocoding are pinned to fixtures so the ONLY variable is the parser.",
  );

  if (!apiKey) {
    console.log(
      "\n  ANTHROPIC_API_KEY is not set, so only the rule-based baseline can run.\n" +
        "  Add a key to .env.local to compare real models against it.",
    );
  } else {
    console.log(`Models  ${["rule-based (free)", ...models].join(", ")}`);
    console.log("\n  This spends real money — one full corpus run per model.");
  }

  console.log("=".repeat(78));

  const rows: Row[] = [];

  // Baseline first, so every model below has something to be compared against.
  rows.push(await runOne("rule-based (free)", new MockLlmProvider(), cases, null));

  if (apiKey) {
    for (const model of models) {
      const provider = new AnthropicLlmProvider(apiKey, model);
      rows.push(await runOne(model, provider, cases, provider));
    }
  }

  report(rows);
}

async function runOne(
  label: string,
  llm: LlmProvider,
  cases: CorpusCase[],
  usageSource: AnthropicLlmProvider | null,
): Promise<Row> {
  process.stdout.write(`\n${label.padEnd(24)} `);

  const providers: Providers = {
    places: new MockPlacesProvider(),
    geocoding: new MockGeocodingProvider(),
    llm,
  };

  const graded: GradedCase[] = [];
  let parseMsTotal = 0;

  for (const corpusCase of cases) {
    const result = await resolvePlace(corpusCase.phrase, providers, {
      context: {
        city: corpusCase.city,
        currentLocation: CITY_CENTRES[corpusCase.city as FixtureCity],
      },
    });

    parseMsTotal += result.timings.parse ?? 0;

    const entry = grade(corpusCase, result);
    graded.push(entry);
    process.stdout.write(
      entry.outcome === "pass" ? "." : entry.outcome === "soft" ? "~" : "x",
    );
  }

  const summary = summarise(graded);

  let costUsd: number | null = null;
  let tokens = "—";

  if (usageSource) {
    const price = PRICE_PER_MTOK[modelKey(label)] ?? PRICE_PER_MTOK["claude-haiku-4-5"]!;
    const { inputTokens, outputTokens, cacheReadTokens } = usageSource.usage;
    costUsd =
      (inputTokens * price.input) / 1_000_000 +
      (outputTokens * price.output) / 1_000_000 +
      (cacheReadTokens * price.input * 0.1) / 1_000_000;
    tokens = `${inputTokens.toLocaleString()}/${outputTokens.toLocaleString()}`;
  }

  return {
    label,
    pass: summary.pass,
    soft: summary.soft,
    fail: summary.fail,
    passRate: summary.passRate,
    reachRate: summary.reachRate,
    meanParseMs: parseMsTotal / Math.max(1, cases.length),
    costUsd,
    tokens,
  };
}

function modelKey(label: string): string {
  return Object.keys(PRICE_PER_MTOK).find((key) => label.startsWith(key)) ?? label;
}

function report(rows: Row[]): void {
  console.log(`\n\n${"=".repeat(78)}`);
  console.log(
    ["model".padEnd(22), "pass", "soft", "fail", " rate", " reach", "  parse", "     cost"].join(
      " ",
    ),
  );
  console.log("-".repeat(78));

  for (const row of rows) {
    console.log(
      [
        row.label.slice(0, 22).padEnd(22),
        String(row.pass).padStart(4),
        String(row.soft).padStart(4),
        String(row.fail).padStart(4),
        `${(row.passRate * 100).toFixed(0)}%`.padStart(5),
        `${(row.reachRate * 100).toFixed(0)}%`.padStart(6),
        `${row.meanParseMs.toFixed(0)}ms`.padStart(7),
        (row.costUsd === null ? "free" : `$${row.costUsd.toFixed(4)}`).padStart(9),
      ].join(" "),
    );
  }

  console.log("-".repeat(78));

  const baseline = rows[0];
  const best = [...rows].sort((a, b) => b.passRate - a.passRate)[0];

  if (baseline && best && best.label !== baseline.label) {
    const delta = (best.passRate - baseline.passRate) * 100;
    console.log(
      delta > 2
        ? `\n  ${best.label} beats the rule-based baseline by ${delta.toFixed(0)} points.`
        : `\n  No model meaningfully beat the free rule-based parser (best: ${delta.toFixed(
            0,
          )} points).\n  On this corpus the model is not earning its latency or its cost.`,
    );
  }

  console.log(
    "\n  Caveat: fixtures, not live map data. This compares parsers against each\n" +
      "  other honestly, but the absolute numbers are not the exit test.",
  );
}

main().catch((error: unknown) => {
  console.error("\nComparison failed:\n", error);
  process.exitCode = 1;
});
