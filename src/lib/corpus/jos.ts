/**
 * Jos test corpus.
 *
 * These are written the way people actually say addresses, not the way a
 * search box wants them. Phrases lean on landmarks, drop the city, use
 * relative position, and reuse street names across districts — because that is
 * the input the product has to survive.
 *
 * Replace these with real phrases from real users as soon as there are any.
 * Synthetic cases can only prove the pipeline runs; only real ones can answer
 * the exit-test question of whether it is better than a plain geocoder.
 */

import type { CorpusCase } from "./types";

export const JOS_CASES: CorpusCase[] = [
  // --- Direct name lookups: the floor. If these fail, nothing else matters.
  {
    id: "jos-01",
    phrase: "Rayfield Resort",
    city: "jos",
    difficulty: "easy",
    probes: "Plain named place, no qualifiers.",
    expect: { kind: "resolves", placeId: "jos-rayfield-resort" },
  },
  {
    id: "jos-02",
    phrase: "Jos Main Market",
    city: "jos",
    difficulty: "easy",
    probes: "Prominent landmark by exact name.",
    expect: { kind: "resolves", placeId: "jos-main-market" },
  },
  {
    id: "jos-03",
    phrase: "Hill Station Hotel Tudun Wada",
    city: "jos",
    difficulty: "easy",
    probes: "Name plus area, both correct.",
    expect: { kind: "resolves", placeId: "jos-hill-station" },
  },
  {
    id: "jos-04",
    phrase: "Bukuru Market",
    city: "jos",
    difficulty: "easy",
    probes: "Named place on the outskirts, far from the city centre bias.",
    expect: { kind: "resolves", placeId: "jos-bukuru-market" },
  },
  {
    id: "jos-05",
    phrase: "Leventis roundabout Jos",
    city: "jos",
    difficulty: "easy",
    probes: "Junction named as a landmark, lowercase feature word.",
    expect: { kind: "resolves", placeId: "jos-leventis" },
  },
  {
    id: "jos-06",
    phrase: "Naraguta Guest House",
    city: "jos",
    difficulty: "easy",
    probes: "Low-prominence place by exact name — must not be buried by bigger places.",
    expect: { kind: "resolves", placeId: "jos-naraguta-guest-house" },
  },

  // --- Landmark relations: the wedge.
  {
    id: "jos-07",
    phrase: "the guest house behind the mosque on Buhari Street, Rayfield",
    city: "jos",
    difficulty: "hard",
    probes:
      "The flagship case. Anchor hop: locate the mosque, then find the guest house behind it. A plain geocoder cannot do this.",
    expect: { kind: "resolves", placeId: "jos-bluewiz-lodge" },
  },
  {
    id: "jos-08",
    phrase: "Green Palace Hotel opposite the filling station, Farin Gada",
    city: "jos",
    difficulty: "hard",
    probes: "Name plus a corroborating landmark relation. Both should agree.",
    expect: { kind: "resolves", placeId: "jos-green-palace" },
  },
  {
    id: "jos-09",
    phrase: "the hotel opposite Total in Farin Gada",
    city: "jos",
    difficulty: "hard",
    probes:
      "Same place as jos-08 but with no proper name at all — only category plus landmark.",
    expect: { kind: "resolves", placeId: "jos-green-palace" },
  },
  {
    id: "jos-10",
    phrase: "Crunchies beside Zenith Bank in Rayfield",
    city: "jos",
    difficulty: "moderate",
    probes: "Named anchor, tight relation. Anchor is specific, not a category.",
    expect: { kind: "resolves", placeId: "jos-crunchies-rayfield" },
  },
  {
    id: "jos-11",
    phrase: "First Bank near Jos Main Market",
    city: "jos",
    difficulty: "moderate",
    probes: "Loose relation ('near') around a very prominent anchor.",
    expect: { kind: "resolves", placeId: "jos-firstbank-terminus" },
  },
  {
    id: "jos-12",
    phrase: "the guest house near University of Jos",
    city: "jos",
    difficulty: "moderate",
    probes: "Category plus prominent anchor, no name, no street.",
    expect: { kind: "resolves", placeId: "jos-naraguta-guest-house" },
  },

  // --- Area-qualified duplicates: the disambiguation machinery.
  {
    id: "jos-13",
    phrase: "Buhari Street in Farin Gada",
    city: "jos",
    difficulty: "moderate",
    probes:
      "One of three Buhari Streets. The area is the only thing separating them, and it was given.",
    expect: { kind: "resolves", placeId: "jos-buhari-st-faringada" },
  },
  {
    id: "jos-14",
    phrase: "Buhari Street, Jos",
    city: "jos",
    difficulty: "hard",
    probes:
      "Three Buhari Streets, no area given. Asking is correct; picking one confidently is the failure this product exists to prevent.",
    expect: {
      kind: "asks",
      mustIncludePlaceIds: [
        "jos-buhari-st-rayfield",
        "jos-buhari-st-terminus",
        "jos-buhari-st-faringada",
      ],
    },
  },
  {
    id: "jos-15",
    phrase: "that place beside the bank in Rayfield",
    city: "jos",
    difficulty: "hard",
    probes:
      "Generic anchor ('the bank') and no category for the target. Should reach the right neighbourhood but not commit.",
    expect: {
      kind: "asks",
      mustIncludePlaceIds: ["jos-crunchies-rayfield", "jos-zenith-rayfield"],
    },
  },

  // --- Category-plus-area, no name.
  {
    id: "jos-16",
    phrase: "the market at Terminus",
    city: "jos",
    difficulty: "moderate",
    probes: "Category plus area. One obvious answer despite no proper name.",
    expect: { kind: "resolves", placeId: "jos-main-market" },
  },
  {
    id: "jos-17",
    phrase: "the junction at Bukuru express",
    city: "jos",
    difficulty: "moderate",
    probes: "Colloquial shortening of a road name plus a feature word.",
    expect: { kind: "resolves", placeId: "jos-bukuru-junction" },
  },

  // --- Known-hard: abbreviation the fixtures do not carry.
  {
    id: "jos-18",
    phrase: "JUTH",
    city: "jos",
    difficulty: "hard",
    probes:
      "Local acronym with no expansion in the place data. Expected to fail today — it is here to size the alias problem, which is what place_aliases will exist to fix.",
    expect: { kind: "resolves", placeId: "jos-juth" },
  },
  {
    id: "jos-19",
    phrase: "Jos University Teaching Hospital, Lamingo",
    city: "jos",
    difficulty: "easy",
    probes: "The same place spelled out — the control for jos-18.",
    expect: { kind: "resolves", placeId: "jos-juth" },
  },

  // --- The floor: too little to go on.
  {
    id: "jos-20",
    phrase: "somewhere in Jos",
    city: "jos",
    difficulty: "easy",
    probes:
      "No place, no street, no landmark. Declining is the only correct answer; anything else is a hallucinated location.",
    expect: { kind: "declines" },
  },
];
