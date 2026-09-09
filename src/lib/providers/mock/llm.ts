/**
 * Rule-based stand-in for the parse step.
 *
 * This is not pretending to be a language model. It is a deterministic parser
 * that handles the common shapes of Nigerian spoken addresses well enough to
 * develop and test the rest of the pipeline without an API key — and, more
 * usefully, to act as the *baseline* the real model has to beat. If swapping
 * in Claude does not measurably improve the harness score over this, the model
 * is not earning its latency or its cost.
 *
 * Shapes handled:
 *   "<type> behind the <anchor> on <street>, <area>"
 *   "<name> opposite the <anchor> in <area>"
 *   "that place beside the <anchor>"
 *   "<number> <street>, <area>"
 */

import type { LlmProvider } from "@/lib/providers/types";
import type {
  LandmarkRelation,
  ParsedPlace,
  RelationType,
} from "@/lib/resolution/types";
import { normalise } from "@/lib/text/similarity";

/** Ordered longest-first so "in front of" wins over "in". */
const RELATION_PATTERNS: Array<[RegExp, RelationType]> = [
  [/\bat the back of\b/g, "behind"],
  [/\bin front of\b/g, "in_front_of"],
  [/\bacross from\b/g, "opposite"],
  [/\bclose to\b/g, "near"],
  [/\bnext to\b/g, "beside"],
  [/\bbehind\b/g, "behind"],
  [/\bopposite\b/g, "opposite"],
  [/\bfacing\b/g, "opposite"],
  [/\bbeside\b/g, "beside"],
  [/\balongside\b/g, "beside"],
  [/\bbetween\b/g, "between"],
  [/\binside\b/g, "inside"],
  [/\bwithin\b/g, "inside"],
  [/\balong\b/g, "along"],
  [/\bnear\b/g, "near"],
  [/\bpast\b/g, "after"],
  [/\bafter\b/g, "after"],
  [/\bbefore\b/g, "before"],
];

const STREET_SUFFIXES =
  "street|st|road|rd|close|crescent|avenue|ave|way|drive|lane|expressway|boulevard";

/** Category words, mapped to a canonical form. */
const PLACE_TYPES: Array<[RegExp, string]> = [
  [/\bguest\s?house\b/, "guest house"],
  [/\bfilling station\b|\bpetrol station\b|\bfuel station\b/, "filling station"],
  [/\bfast food\b/, "restaurant"],
  [/\brestaurant\b|\beatery\b|\bcanteen\b|\bbukka\b/, "restaurant"],
  [/\bhotel\b/, "hotel"],
  [/\blodge\b|\blodging\b/, "lodge"],
  [/\bmosque\b|\bjumat\b/, "mosque"],
  [/\bchurch\b|\bcathedral\b/, "church"],
  [/\bbank\b/, "bank"],
  [/\bmarket\b/, "market"],
  [/\bhospital\b|\bclinic\b/, "hospital"],
  [/\bpharmacy\b|\bchemist\b/, "pharmacy"],
  [/\bschool\b|\buniversity\b|\bcollege\b/, "school"],
  [/\bsupermarket\b|\bstores?\b/, "supermarket"],
  [/\bjunction\b|\broundabout\b/, "junction"],
  [/\bmotor park\b|\bgarage\b|\bpark\b/, "park"],
  [/\bmall\b|\bplaza\b/, "mall"],
  // Omitting airport meant "the airport in Abuja" had no category at all and
  // fell through to whatever prominent place matched the city name.
  [/\bairport\b/, "airport"],
  [/\bbus stop\b|\bmotor park\b/, "bus stop"],
  [/\bstadium\b/, "stadium"],
  [/\bpolice station\b/, "police station"],
  [/\bcinema\b/, "cinema"],
  [/\bestate\b/, "estate"],
];

/** Words that end an anchor phrase. */
const ANCHOR_BOUNDARY = new Set([
  "on", "in", "at", "along", "near", "by", "off", "beside", "behind",
  "opposite", "after", "before", "and", "then",
]);

const FILLER_NAME_WORDS = new Set([
  "that", "the", "a", "an", "place", "one", "somewhere", "somewhere",
  "my", "friend", "friends", "mentioned", "visited", "last", "week",
  "i", "we", "you", "know", "about", "talked", "told", "me", "there",
  "go", "going", "take", "find", "get", "to", "is", "it", "s",
]);

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock-rules";

  async parsePlacePhrase(
    phrase: string,
    hints: { city?: string; knownAreas?: string[] },
  ): Promise<ParsedPlace> {
    const lower = normalise(phrase);
    const notes: string[] = [];

    const landmarkRelations = extractRelations(lower);

    /*
     * Category extraction runs against the phrase with the landmarks removed.
     *
     * Without this, "Green Palace Hotel opposite the filling station" reads the
     * *anchor's* category as the target's: the pattern for "filling station"
     * sits earlier in the list than the one for "hotel", so the engine went
     * looking for a filling station and ranked the actual hotel below it. The
     * landmark describes where the place is, never what it is.
     */
    const withoutAnchors = maskAnchors(lower, landmarkRelations);

    const street = extractStreet(lower);
    const area = extractArea(lower, hints.knownAreas ?? []);
    const city = extractCity(lower) ?? hints.city ?? null;
    const houseNumber = extractHouseNumber(lower);
    const placeType = extractPlaceType(withoutAnchors);
    const placeName = extractPlaceName(phrase, {
      street,
      area,
      city,
      anchors: landmarkRelations.map((r) => r.anchor),
      placeType,
    });

    if (!placeName && !street && landmarkRelations.length === 0) {
      notes.push("No name, street or landmark given — very little to search on.");
    }
    if (!area && !city) {
      notes.push("No area or city given — candidates cannot be geographically filtered.");
    }
    if (landmarkRelations.some((r) => GENERIC_ANCHORS.has(r.anchor))) {
      notes.push(
        "Anchor is a generic category ('the bank', 'the mosque') — needs the user's location or a named anchor to be useful.",
      );
    }

    return {
      placeType,
      placeName,
      street,
      area,
      city,
      houseNumber,
      landmarkRelations,
      ambiguityNotes: notes,
    };
  }
}

/** Anchors that name a category rather than a specific place. */
const GENERIC_ANCHORS = new Set([
  "bank", "mosque", "church", "market", "filling station", "school",
  "hospital", "junction", "roundabout", "park",
]);

/** Blank out anchor phrases so they cannot be read as the target's own words. */
function maskAnchors(lower: string, relations: LandmarkRelation[]): string {
  let masked = lower;

  for (const relation of relations) {
    const pattern = new RegExp(`\\b${escapeRegex(relation.anchor)}\\b`, "g");
    masked = masked.replace(pattern, " ");
  }

  return masked.replace(/\s+/g, " ").trim();
}

function extractRelations(lower: string): LandmarkRelation[] {
  const found: LandmarkRelation[] = [];
  const consumed: Array<[number, number]> = [];

  for (const [pattern, type] of RELATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Skip a hit already covered by a longer, earlier pattern.
      if (consumed.some(([s, e]) => start >= s && end <= e)) continue;
      consumed.push([start, end]);

      const anchor = readAnchor(lower.slice(end));
      if (anchor) found.push({ type, anchor });
    }
  }

  return found;
}

/** Read the noun phrase after a relation word, stopping at a boundary. */
function readAnchor(rest: string): string | null {
  const words = rest.trim().split(/[\s,]+/).filter(Boolean);
  const collected: string[] = [];

  for (const word of words) {
    if (collected.length > 0 && ANCHOR_BOUNDARY.has(word)) break;
    if (collected.length === 0 && (word === "the" || word === "a")) continue;
    collected.push(word);
    if (collected.length >= 4) break;
  }

  if (collected.length === 0) return null;

  // Trim a trailing street-type word: "the mosque on buhari street" must not
  // swallow the street into the anchor.
  const anchor = collected.join(" ");
  const trimmed = anchor.replace(
    new RegExp(`\\s+(${STREET_SUFFIXES})$`),
    "",
  );
  return trimmed || null;
}

function extractStreet(lower: string): string | null {
  const named = new RegExp(
    `\\b([a-z0-9]+(?:\\s+[a-z0-9]+)?)\\s+(${STREET_SUFFIXES})\\b`,
  ).exec(lower);
  if (!named) return null;

  const name = named[1] ?? "";
  const suffix = named[2] ?? "";

  // Guard against a relation word being read as the street name, e.g.
  // "opposite street" from a badly-formed phrase.
  const nameWords = name.split(/\s+/);
  const cleaned = nameWords
    .filter((w) => !ANCHOR_BOUNDARY.has(w) && !FILLER_NAME_WORDS.has(w))
    .join(" ");
  if (!cleaned) return null;

  return titleCase(`${cleaned} ${suffix}`);
}

function extractArea(lower: string, knownAreas: string[]): string | null {
  // Longest match first, so "Wuse 2" beats "Wuse".
  const sorted = [...knownAreas].sort((a, b) => b.length - a.length);
  for (const area of sorted) {
    const pattern = new RegExp(`\\b${escapeRegex(normalise(area))}\\b`);
    if (pattern.test(lower)) return area;
  }
  return null;
}

const CITIES = ["jos", "abuja", "lagos", "kaduna", "kano", "port harcourt"];

function extractCity(lower: string): string | null {
  for (const city of CITIES) {
    if (new RegExp(`\\b${escapeRegex(city)}\\b`).test(lower)) {
      return titleCase(city);
    }
  }
  return null;
}

function extractHouseNumber(lower: string): string | null {
  // A number directly before a name or street word: "21 crescent", "no 4".
  const match = /\b(?:no\.?\s*|number\s*)?(\d{1,4}[a-z]?)\s+(?=[a-z])/.exec(lower);
  if (!match) return null;

  // A bare year-like number is more likely noise than a house number.
  const value = match[1] ?? "";
  if (/^(19|20)\d{2}$/.test(value)) return null;
  return value;
}

function extractPlaceType(lower: string): string | null {
  for (const [pattern, canonical] of PLACE_TYPES) {
    if (pattern.test(lower)) return canonical;
  }
  return null;
}

/**
 * Proper name extraction.
 *
 * Uses capitalisation in the *original* phrase, then subtracts everything
 * already accounted for by another field. Typed input from users is often
 * lowercase, so this returns null more often than it fires — which is correct
 * behaviour: a wrong name is worse than no name.
 */
function extractPlaceName(
  original: string,
  used: {
    street: string | null;
    area: string | null;
    city: string | null;
    anchors: string[];
    placeType: string | null;
  },
): string | null {
  const consumed = new Set<string>();
  for (const field of [used.street, used.area, used.city, used.placeType]) {
    if (field) for (const token of normalise(field).split(" ")) consumed.add(token);
  }
  for (const anchor of used.anchors) {
    for (const token of normalise(anchor).split(" ")) consumed.add(token);
  }

  const words = original.split(/[\s,]+/).filter(Boolean);
  const kept: string[] = [];

  for (const word of words) {
    const clean = normalise(word);
    if (!clean) continue;
    if (consumed.has(clean)) continue;
    if (FILLER_NAME_WORDS.has(clean)) continue;

    // Capitalised and not sentence-initial noise.
    const isCapitalised = /^[A-Z]/.test(word);
    if (isCapitalised) kept.push(word.replace(/[^A-Za-z0-9'-]/g, ""));
  }

  if (kept.length === 0) return null;
  return kept.join(" ").trim() || null;
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
