/**
 * Abuja test corpus.
 *
 * Abuja is the harder market to win: Places coverage is far better than in Jos,
 * so a plain text search already gets many of these right. That makes it the
 * more honest test of whether the resolution engine is adding anything. Watch
 * the landmark cases specifically — those are the ones Google does badly.
 */

import type { CorpusCase } from "./types";

export const ABUJA_CASES: CorpusCase[] = [
  // --- The master document's own worked example.
  {
    id: "abj-01",
    phrase: "the guest house behind the mosque on Buhari Street, Wuse",
    city: "abuja",
    difficulty: "hard",
    probes:
      "The example from Part III, 3.1, end to end. Category + relation + anchor + street + area, with no proper name anywhere.",
    expect: { kind: "resolves", placeId: "abj-peace-guest-house" },
  },
  {
    id: "abj-02",
    phrase: "Peace Guest House Wuse 2",
    city: "abuja",
    difficulty: "easy",
    probes: "The same place by name — the control for abj-01.",
    expect: { kind: "resolves", placeId: "abj-peace-guest-house" },
  },

  // --- Direct lookups.
  {
    id: "abj-03",
    phrase: "Wuse Market",
    city: "abuja",
    difficulty: "easy",
    probes: "Prominent named market.",
    expect: { kind: "resolves", placeId: "abj-wuse-market" },
  },
  {
    id: "abj-04",
    phrase: "GTBank Wuse 2",
    city: "abuja",
    difficulty: "easy",
    probes: "Branded chain plus a numbered district.",
    expect: { kind: "resolves", placeId: "abj-gtbank-wuse" },
  },
  {
    id: "abj-05",
    phrase: "Transcorp Hilton",
    city: "abuja",
    difficulty: "easy",
    probes: "Very prominent place, partial name.",
    expect: { kind: "resolves", placeId: "abj-hilton" },
  },
  {
    id: "abj-06",
    phrase: "Maitama District Hospital",
    city: "abuja",
    difficulty: "easy",
    probes: "Exact institutional name.",
    expect: { kind: "resolves", placeId: "abj-maitama-hospital" },
  },
  {
    id: "abj-07",
    phrase: "Sahad Stores Garki",
    city: "abuja",
    difficulty: "easy",
    probes: "Name plus area.",
    expect: { kind: "resolves", placeId: "abj-sahad" },
  },
  {
    id: "abj-08",
    phrase: "Jabi Lake Mall",
    city: "abuja",
    difficulty: "easy",
    probes: "Prominent named mall.",
    expect: { kind: "resolves", placeId: "abj-jabi-lake-mall" },
  },
  {
    id: "abj-09",
    phrase: "Nnamdi Azikiwe airport",
    city: "abuja",
    difficulty: "easy",
    probes: "Partial official name, lowercase feature word.",
    expect: { kind: "resolves", placeId: "abj-airport" },
  },
  {
    id: "abj-10",
    phrase: "Nyanya junction",
    city: "abuja",
    difficulty: "easy",
    probes: "Junction on the city edge, named colloquially.",
    expect: { kind: "resolves", placeId: "abj-nyanya-junction" },
  },
  {
    id: "abj-11",
    phrase: "Wuse Central Mosque",
    city: "abuja",
    difficulty: "easy",
    probes: "The anchor from abj-01, looked up directly.",
    expect: { kind: "resolves", placeId: "abj-wuse-mosque" },
  },

  // --- Category plus area, no proper name.
  {
    id: "abj-12",
    phrase: "the market in Garki",
    city: "abuja",
    difficulty: "moderate",
    probes: "Category plus district.",
    expect: { kind: "resolves", placeId: "abj-garki-market" },
  },
  {
    id: "abj-13",
    phrase: "the mall in Jabi",
    city: "abuja",
    difficulty: "moderate",
    probes: "Category plus district, single obvious answer.",
    expect: { kind: "resolves", placeId: "abj-jabi-lake-mall" },
  },
  {
    id: "abj-14",
    phrase: "the airport in Abuja",
    city: "abuja",
    difficulty: "moderate",
    probes: "Category plus city, far outside the centre — distance bias must not bury it.",
    expect: { kind: "resolves", placeId: "abj-airport" },
  },
  {
    id: "abj-15",
    phrase: "the hotel on Aguiyi Ironsi Street Maitama",
    city: "abuja",
    difficulty: "moderate",
    probes: "Category plus a street shared with a hospital — the type word is the discriminator.",
    expect: { kind: "resolves", placeId: "abj-hilton" },
  },

  // --- Duplicates and near-misses.
  {
    id: "abj-16",
    phrase: "Buhari Street in Garki",
    city: "abuja",
    difficulty: "moderate",
    probes: "Duplicate street name, disambiguated by the district given.",
    expect: { kind: "resolves", placeId: "abj-buhari-st-garki" },
  },
  {
    id: "abj-17",
    phrase: "Buhari Street, Abuja",
    city: "abuja",
    difficulty: "hard",
    probes:
      "Two Buhari Streets plus a Buhari Crescent. Must ask, and the crescent must not be silently treated as a match for 'street'.",
    expect: {
      kind: "asks",
      mustIncludePlaceIds: ["abj-buhari-st-wuse", "abj-buhari-st-garki"],
    },
  },
  {
    id: "abj-18",
    phrase: "Buhari Crescent Maitama",
    city: "abuja",
    difficulty: "moderate",
    probes:
      "The near-miss control. 'Crescent' must beat the two 'Street' entries that share the only content token.",
    expect: { kind: "resolves", placeId: "abj-buhari-cres-maitama" },
  },
  {
    id: "abj-19",
    phrase: "the mosque on Buhari Street Wuse",
    city: "abuja",
    difficulty: "moderate",
    probes:
      "Here the mosque is the target, not the anchor. Tests that a landmark word is not always a relation.",
    expect: { kind: "resolves", placeId: "abj-wuse-mosque" },
  },

  // --- The floor.
  {
    id: "abj-20",
    phrase: "somewhere around Abuja",
    city: "abuja",
    difficulty: "easy",
    probes: "Nothing identifying. Must decline rather than return a city centroid as an answer.",
    expect: { kind: "declines" },
  },
];
