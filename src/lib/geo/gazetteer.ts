/**
 * Abuja gazetteer — the names people actually say, for spelling correction.
 *
 * Speech recognition and thumbs both mangle place names: "Maintama" for
 * Maitama, "Gwarimpa" for Gwarinpa, "Wuze" for Wuse. A geocoder given the
 * mangled word returns nothing, and "I couldn't find that" is the wrong answer
 * when the user obviously meant a district everyone in the city knows.
 *
 * So this is a list of NAMES, not coordinates. It exists to recognise and
 * correct what was said; where a place actually is still comes from the
 * geocoder, exactly as everywhere else in the product. A name listed here that
 * turns out not to be mapped costs nothing worse than an honest "not found" —
 * which is why it is safe to keep this list generous.
 */

import { levenshtein, normalise } from "@/lib/text/similarity";

export type GazetteerKind = "district" | "road" | "landmark";

export interface GazetteerEntry {
  name: string;
  kind: GazetteerKind;
  /** Other ways people say or spell it. Matched exactly like the name. */
  aliases?: string[];
}

const DISTRICTS: GazetteerEntry[] = [
  { name: "Maitama", kind: "district" },
  { name: "Asokoro", kind: "district" },
  { name: "Wuse", kind: "district", aliases: ["wuze"] },
  { name: "Wuse 2", kind: "district", aliases: ["wuse ii", "wuse two", "wuze 2"] },
  { name: "Garki", kind: "district" },
  { name: "Garki 2", kind: "district", aliases: ["garki ii", "garki two"] },
  { name: "Central Business District", kind: "district", aliases: ["cbd", "central area"] },
  { name: "Utako", kind: "district" },
  { name: "Jabi", kind: "district" },
  { name: "Wuye", kind: "district" },
  { name: "Gwarinpa", kind: "district", aliases: ["gwarimpa"] },
  { name: "Kubwa", kind: "district" },
  { name: "Lugbe", kind: "district" },
  { name: "Nyanya", kind: "district" },
  { name: "Karu", kind: "district" },
  { name: "Mararaba", kind: "district", aliases: ["maraba"] },
  { name: "Dutse", kind: "district" },
  { name: "Bwari", kind: "district" },
  { name: "Gudu", kind: "district" },
  { name: "Durumi", kind: "district" },
  { name: "Apo", kind: "district" },
  { name: "Lokogoma", kind: "district" },
  { name: "Galadimawa", kind: "district" },
  { name: "Kado", kind: "district" },
  { name: "Katampe", kind: "district" },
  { name: "Jahi", kind: "district" },
  { name: "Mabushi", kind: "district" },
  { name: "Life Camp", kind: "district", aliases: ["lifecamp"] },
  { name: "Karmo", kind: "district" },
  { name: "Dei-Dei", kind: "district", aliases: ["deidei", "dei dei"] },
  { name: "Idu", kind: "district" },
  { name: "Kuje", kind: "district" },
  { name: "Gwagwalada", kind: "district" },
  { name: "Jikwoyi", kind: "district" },
  { name: "Karshi", kind: "district" },
  { name: "Kurudu", kind: "district" },
  { name: "Guzape", kind: "district" },
  { name: "Mpape", kind: "district" },
  { name: "Dakibiyu", kind: "district" },
  { name: "Kaura", kind: "district" },
  { name: "Duboyi", kind: "district" },
  { name: "Dawaki", kind: "district" },
  { name: "Kagini", kind: "district" },
  { name: "Pyakasa", kind: "district" },
  { name: "Piwoyi", kind: "district" },
  { name: "Wumba", kind: "district" },
  { name: "Dakwo", kind: "district" },
  { name: "Kuchigoro", kind: "district" },
  { name: "Area 1", kind: "district", aliases: ["area one"] },
  { name: "Area 3", kind: "district", aliases: ["area three"] },
  { name: "Area 10", kind: "district", aliases: ["area ten"] },
  { name: "Area 11", kind: "district", aliases: ["area eleven"] },
];

/*
 * Roads are compared with their street-type word removed ("Sani Abacha Way"
 * matches "sani abacha road"), because people say "road" for everything and
 * the official suffix is the part they are least likely to get right.
 */
const ROADS: GazetteerEntry[] = [
  { name: "Ahmadu Bello Way", kind: "road" },
  { name: "Sani Abacha Way", kind: "road", aliases: ["abacha"] },
  { name: "Aguiyi Ironsi Street", kind: "road", aliases: ["ironsi"] },
  { name: "Shehu Shagari Way", kind: "road" },
  { name: "Herbert Macaulay Way", kind: "road" },
  { name: "Tafawa Balewa Way", kind: "road" },
  { name: "Constitution Avenue", kind: "road" },
  { name: "Independence Avenue", kind: "road" },
  { name: "Obafemi Awolowo Way", kind: "road", aliases: ["awolowo"] },
  { name: "Muhammadu Buhari Way", kind: "road" },
  { name: "Aminu Kano Crescent", kind: "road" },
  { name: "Adetokunbo Ademola Crescent", kind: "road", aliases: ["ademola adetokunbo"] },
  { name: "Ibrahim Babangida Way", kind: "road", aliases: ["ibb way", "ibb"] },
  { name: "Umaru Musa Yar'Adua Expressway", kind: "road", aliases: ["airport road", "yar adua", "yaradua"] },
  { name: "Kubwa Expressway", kind: "road", aliases: ["kubwa road"] },
  { name: "Murtala Mohammed Expressway", kind: "road", aliases: ["murtala", "murtala mohammed", "murtala muhammed"] },
  { name: "Kashim Ibrahim Way", kind: "road" },
  { name: "Yakubu Gowon Crescent", kind: "road" },
  { name: "Gana Street", kind: "road" },
  { name: "Mississippi Street", kind: "road" },
  { name: "Lake Chad Crescent", kind: "road" },
  { name: "Abuja-Keffi Expressway", kind: "road", aliases: ["keffi road", "nyanya road", "abuja keffi"] },
  { name: "Outer Northern Expressway", kind: "road", aliases: ["onex"] },
  { name: "Inner Southern Expressway", kind: "road", aliases: ["isex"] },
  { name: "Outer Southern Expressway", kind: "road", aliases: ["osex"] },
];

const LANDMARKS: GazetteerEntry[] = [
  { name: "Aso Rock", kind: "landmark" },
  { name: "Eagle Square", kind: "landmark" },
  { name: "Abuja National Mosque", kind: "landmark", aliases: ["national mosque", "central mosque"] },
  { name: "National Christian Centre", kind: "landmark", aliases: ["ecumenical centre"] },
  { name: "Millennium Park", kind: "landmark" },
  { name: "Unity Fountain", kind: "landmark" },
  { name: "Transcorp Hilton", kind: "landmark", aliases: ["hilton"] },
  { name: "Jabi Lake Mall", kind: "landmark", aliases: ["jabi mall"] },
  { name: "Jabi Lake", kind: "landmark" },
  { name: "Ceddi Plaza", kind: "landmark" },
  { name: "Silverbird Galleria", kind: "landmark", aliases: ["silverbird"] },
  { name: "Wuse Market", kind: "landmark" },
  { name: "Utako Market", kind: "landmark" },
  { name: "Moshood Abiola National Stadium", kind: "landmark", aliases: ["national stadium"] },
  { name: "Nnamdi Azikiwe International Airport", kind: "landmark", aliases: ["abuja airport", "nnamdi azikiwe airport"] },
  { name: "Magic Land", kind: "landmark" },
  { name: "IBB Golf Club", kind: "landmark" },
  { name: "Minister's Hill", kind: "landmark", aliases: ["ministers hill"] },
  { name: "Berger Roundabout", kind: "landmark", aliases: ["berger junction", "berger"] },
  { name: "Banex Plaza", kind: "landmark", aliases: ["banex junction", "banex"] },
  { name: "Area 1 Roundabout", kind: "landmark" },
  { name: "AYA Junction", kind: "landmark", aliases: ["aya roundabout"] },
  { name: "Mabushi Bus Terminal", kind: "landmark", aliases: ["mabushi terminal"] },
  { name: "Jabi Motor Park", kind: "landmark" },
  { name: "Utako Motor Park", kind: "landmark" },
  { name: "Nyanya Motor Park", kind: "landmark" },
  { name: "National Hospital Abuja", kind: "landmark", aliases: ["national hospital"] },
  { name: "Maitama District Hospital", kind: "landmark" },
  { name: "Garki Hospital", kind: "landmark" },
  { name: "University of Abuja", kind: "landmark", aliases: ["uniabuja"] },
  { name: "Sheraton Abuja Hotel", kind: "landmark", aliases: ["sheraton"] },
];

export const GAZETTEER: GazetteerEntry[] = [...DISTRICTS, ...ROADS, ...LANDMARKS];

const STREET_WORDS = new Set([
  "street", "st", "road", "rd", "way", "avenue", "ave", "crescent", "close",
  "drive", "lane", "expressway", "express", "boulevard", "highway",
]);

/**
 * Words that must never be *fuzzily* corrected into a place name.
 *
 * They are ordinary English, and several sit within an edit or two of a
 * district ("garage"/"garki" is not, but "cafe" and "kado" nearly are). An
 * exact match on the gazetteer still counts — "Life Camp" is a district — but
 * a near-miss on a common word is a coincidence, not a misspelling.
 */
const COMMON_WORDS = new Set([
  "the", "a", "an", "is", "are", "where", "what", "find", "me", "my", "near",
  "nearest", "closest", "close", "around", "take", "to", "go", "get", "how",
  "far", "from", "in", "at", "on", "of", "and", "or", "there", "here", "it",
  "traffic", "weather", "rain", "road", "way", "street", "park", "market",
  "motor", "area", "camp", "life", "central", "business", "district", "hotel",
  "hospital", "mall", "plaza", "lake", "hill", "square", "junction", "bridge",
  "please", "any", "some", "show", "tell", "about", "place", "places", "cafe",
  "food", "fuel", "bank", "bus", "car", "bike", "walk", "drive", "today",
  "now", "good", "best", "nice", "open", "late", "night", "morning", "yes",
  "no", "okay", "ok", "then", "that", "this", "with", "for", "by", "want",
  "need", "looking", "like", "can", "could", "would", "you", "i", "we",
]);

export interface NameMatch {
  /** The words as they appeared in the text. */
  heard: string;
  /** The gazetteer name they matched. */
  name: string;
  kind: GazetteerKind;
  /** True when spelled correctly (or via a known alias). */
  exact: boolean;
  /** Edit distance to the matched name, 0 when exact. */
  distance: number;
  /** Index of the first matched word, for ordering. */
  position: number;
}

interface IndexedName {
  key: string;
  /** Road keys with the street word removed; same as `key` otherwise. */
  core: string;
  tokens: number;
  entry: GazetteerEntry;
}

const INDEX: IndexedName[] = GAZETTEER.flatMap((entry) =>
  [entry.name, ...(entry.aliases ?? [])].map((variant) => {
    const key = normalise(variant);
    const core =
      entry.kind === "road"
        ? key
            .split(" ")
            .filter((token) => !STREET_WORDS.has(token))
            .join(" ") || key
        : key;
    return { key, core, tokens: core.split(" ").length, entry };
  }),
);

/**
 * How many edits a word of this length may carry and still count as a
 * misspelling rather than a different word. Short names get none: "Apo" and
 * "ago" are different words, not a typo.
 */
function allowedEdits(length: number): number {
  if (length <= 4) return 0;
  if (length <= 6) return 1;
  if (length <= 10) return 2;
  return 3;
}

/**
 * Every gazetteer name mentioned in `text`, spelled right or nearly right.
 *
 * Longer phrases win over the words inside them ("Wuse Market" beats "Wuse"),
 * and each word is claimed by at most one match.
 */
export function findPlaceNames(
  text: string,
  kinds?: GazetteerKind[],
): NameMatch[] {
  const words = normalise(text).split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const claimed = new Array<boolean>(words.length).fill(false);
  const matches: NameMatch[] = [];

  for (let size = Math.min(5, words.length); size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      if (claimed.slice(start, start + size).some(Boolean)) continue;

      const window = words.slice(start, start + size);
      const phrase = window.join(" ");
      const core = window.filter((word) => !STREET_WORDS.has(word)).join(" ");
      const allCommon = window.every((word) => COMMON_WORDS.has(word));

      let best: { entry: GazetteerEntry; distance: number } | null = null;

      for (const indexed of INDEX) {
        if (kinds && !kinds.includes(indexed.entry.kind)) continue;

        const candidate = indexed.entry.kind === "road" ? core : phrase;
        if (!candidate) continue;

        const target = indexed.entry.kind === "road" ? indexed.core : indexed.key;
        if (candidate.split(" ").length !== target.split(" ").length) continue;

        if (candidate === target) {
          best = { entry: indexed.entry, distance: 0 };
          break;
        }

        if (allCommon) continue;
        if (candidate[0] !== target[0]) continue;

        const distance = levenshtein(candidate, target);
        if (distance > allowedEdits(target.length)) continue;
        if (!best || distance < best.distance) {
          best = { entry: indexed.entry, distance };
        }
      }

      if (!best) continue;
      // An exact hit on nothing but common words is still an exact hit
      // ("life camp"); a fuzzy one never gets this far.
      for (let i = start; i < start + size; i++) claimed[i] = true;

      matches.push({
        heard: phrase,
        name: best.entry.name,
        kind: best.entry.kind,
        exact: best.distance === 0,
        distance: best.distance,
        position: start,
      });
    }
  }

  return matches.sort((a, b) => a.position - b.position);
}

/** The best single correction for a place phrase, or null when none applies. */
export function correctPlaceName(
  phrase: string,
  kinds?: GazetteerKind[],
): NameMatch | null {
  const matches = findPlaceNames(phrase, kinds);
  if (matches.length === 0) return null;
  // Prefer the longest match; it is the most specific thing that was said.
  return [...matches].sort(
    (a, b) => b.heard.split(" ").length - a.heard.split(" ").length || a.distance - b.distance,
  )[0]!;
}

/**
 * Rewrite `text` with every near-miss replaced by its gazetteer spelling.
 * Exact matches are left untouched so the user's own words survive.
 */
export function applyCorrections(text: string, matches: NameMatch[]): string {
  let result = text;
  for (const match of matches) {
    if (match.exact) continue;
    const pattern = new RegExp(
      match.heard.split(" ").map(escapeRegExp).join("[\\s\\W]+"),
      "i",
    );
    result = result.replace(pattern, match.name);
  }
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
