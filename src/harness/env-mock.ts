/**
 * Entry point for the fixture harness.
 *
 * Pins the providers to mocks *before* anything reads env, so `npm run harness`
 * cannot accidentally grade a fixture-bound corpus against live map data. That
 * is not hypothetical: run without these, the harness scored live
 * OpenStreetMap against synthetic expectations and reported "GATE FAILED - 5%"
 * in exactly the same format as a real result. A meaningless number wearing the
 * shape of a meaningful one is worse than no number at all.
 *
 * Doing it here rather than as a shell prefix in package.json also keeps the
 * scripts identical on Windows, where `VAR=x cmd` is not valid syntax.
 *
 * To point the engine at live providers, use the app or /api/resolve — not
 * this harness.
 */

process.env.PLACES_PROVIDER = "mock";
process.env.GEOCODING_PROVIDER = "mock";

// The parser is the one thing worth varying here: `npm run harness:models`
// compares real models, and forcing LLM_PROVIDER would defeat that.
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  process.env.LLM_PROVIDER = "mock";
}

// Wrapped rather than top-level await: tsx transpiles this to CJS, where a
// top-level await is a syntax error.
async function main(): Promise<void> {
  await import("./run");
}

void main();
