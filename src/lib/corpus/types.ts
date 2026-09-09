/**
 * The test corpus contract.
 *
 * Three expectation kinds, because "correct" is not one thing:
 *
 *   resolves — there is one right answer and the engine must land on it
 *   asks     — the phrase is genuinely ambiguous; asking is the correct
 *              behaviour, provided the truth is in the shortlist
 *   declines — the phrase contains too little to identify anywhere, and
 *              admitting that is the correct behaviour
 *
 * Scoring only `resolves` would reward an engine that guesses confidently on
 * ambiguous input, which is the single most damaging failure mode for a
 * product people will use to find each other.
 */

import type { FixtureCity } from "@/lib/providers/mock/fixtures";

export type Expectation =
  | { kind: "resolves"; placeId: string }
  | { kind: "asks"; mustIncludePlaceIds: string[] }
  | { kind: "declines" };

export interface CorpusCase {
  id: string;
  phrase: string;
  city: FixtureCity;
  difficulty: "easy" | "moderate" | "hard";
  /** What this case is actually testing. Shown in harness failures. */
  probes: string;
  expect: Expectation;
}
