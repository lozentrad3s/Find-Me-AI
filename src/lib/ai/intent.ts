/**
 * What is the user asking for? Read the request before answering it.
 *
 * "What's the weather in Maitama" and "where is Maitama" share a place name
 * and want completely different answers. A model usually tells them apart,
 * but "usually" is not good enough for the common requests, and each wrong
 * guess costs a slow extra round trip on a free tier that allows a few dozen
 * calls a day. So the frequent, unambiguous requests are recognised here,
 * deterministically, before any model sees them:
 *
 *   - the right tool runs immediately (fast, and no model call to choose it)
 *   - the model is told what was detected, so it phrases the answer rather
 *     than second-guessing the request
 *   - anything this does not recognise with confidence goes to the model
 *     unchanged, as `unknown`
 *
 * It is covered by `npm run harness:intents`, which is where new phrasings
 * should be added when a real user is misread.
 */

import { applyCorrections, findPlaceNames, type NameMatch } from "@/lib/geo/gazetteer";
import { normalise, tokenSimilarity } from "@/lib/text/similarity";

export type IntentKind =
  | "smalltalk"
  | "where_am_i"
  | "weather"
  | "road_traffic"
  | "directions"
  | "nearby"
  | "area_info"
  | "place_lookup"
  | "unknown";

/** A place already shown to the user, which a follow-up may refer to. */
export interface ContextPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
}

export interface CategoryMatch {
  /** Word the search providers understand. */
  query: string;
  /** Word to say to the user. */
  label: string;
}

export interface Intent {
  kind: IntentKind;
  category?: CategoryMatch;
  /** A place or destination as said, with spelling corrected. */
  target?: string;
  /** Search in this named area instead of around the user. */
  area?: string;
  roads?: string[];
  /** A place already on screen that this message refers to. */
  place?: ContextPlace;
  /** Names that were misspelled — for "did you mean". */
  corrections: NameMatch[];
  /** Every gazetteer name mentioned. */
  names: NameMatch[];
  /** Why this was chosen. Read by the harness. */
  reason: string;
}

const CATEGORIES: Array<{ pattern: RegExp; exclude?: RegExp } & CategoryMatch> = [
  // First, so "bus park" is never read as a garden.
  {
    pattern: /\b(bus ?terminals?|bus ?stations?|motor ?parks?|motorparks?|bus ?parks?|luxury bus|terminals?)\b/,
    query: "bus station",
    label: "bus terminal",
  },
  {
    pattern: /\b(filling stations?|petrol stations?|fuel stations?|gas stations?|fuel|petrol|diesel)\b/,
    query: "fuel",
    label: "filling station",
  },
  { pattern: /\b(pharmac(?:y|ies)|chemists?|drug ?stores?)\b/, query: "pharmacy", label: "pharmacy" },
  {
    pattern: /\b(hospitals?|clinics?|emergency room|health ?cent(?:re|er)s?|doctors?)\b/,
    query: "hospital",
    label: "hospital",
  },
  { pattern: /\b(atms?|cash machines?|withdraw cash)\b/, query: "atm", label: "ATM" },
  { pattern: /\bbanks?\b/, query: "bank", label: "bank" },
  {
    pattern: /\b(restaurants?|food|eat|eatery|eateries|bukka|buka|canteen|lunch|dinner|breakfast|fast ?food|suya|cafes?|coffee|hungry)\b/,
    query: "restaurant",
    label: "restaurant",
  },
  {
    pattern: /\b(hotels?|guest ?houses?|lodges?|motels?|accommodation|place to (?:sleep|stay)|somewhere to (?:sleep|stay))\b/,
    query: "hotel",
    label: "hotel",
  },
  { pattern: /\b(supermarkets?|groceries|grocery|provisions|mini ?mart)\b/, query: "supermarket", label: "supermarket" },
  { pattern: /\b(shopping malls?|malls?)\b/, query: "mall", label: "shopping mall" },
  { pattern: /\b(markets?|marketplace)\b/, exclude: /\bsuper ?markets?\b/, query: "market", label: "market" },
  { pattern: /\b(police stations?|police)\b/, query: "police station", label: "police station" },
  { pattern: /\b(mosques?|masjid)\b/, query: "mosque", label: "mosque" },
  { pattern: /\b(church(?:es)?)\b/, query: "church", label: "church" },
  { pattern: /\b(schools?|universit(?:y|ies)|colleges?)\b/, query: "school", label: "school" },
  { pattern: /\b(cinemas?|movies)\b/, query: "cinema", label: "cinema" },
  { pattern: /\b(gyms?|fitness)\b/, query: "gym", label: "gym" },
  { pattern: /\b(mechanics?|vulcani[sz]ers?|car repair|workshops?)\b/, query: "mechanic", label: "mechanic" },
  { pattern: /\bcar ?wash\b/, query: "car wash", label: "car wash" },
  { pattern: /\b(car ?parks?|parking)\b/, query: "parking", label: "car park" },
  { pattern: /\b(parks?|gardens?)\b/, exclude: /\b(bus|motor|car) ?parks?\b/, query: "park", label: "park" },
  { pattern: /\bairports?\b/, query: "airport", label: "airport" },
  { pattern: /\b(embass(?:y|ies)|high commission|consulate)\b/, query: "embassy", label: "embassy" },
  { pattern: /\b(fire stations?|fire service)\b/, query: "fire station", label: "fire station" },
];

const SMALLTALK =
  /^(hi|hello|hey|hiya|good (?:morning|afternoon|evening|night)|thanks?|thank you|ok thanks|how are you|who are you|what can you do|what do you do|are you there|you there|nice|cool|great)\b/;
const WHERE_AM_I =
  /\b(where am i|where i am|my (?:current )?location|current location|i m lost|im lost|i am lost|locate me|where exactly am i|what area is this|what street is this)\b/;
const ROUTE =
  /\b(take me|navigate|directions?|how (?:do|can|will) i get|how to get|route (?:to|me)|drive (?:me )?to|walk (?:me )?to|ride to|go to|get to|lead me|guide me|show me the way|how far|get me to|drop me)\b/;
/** Agreement — only a request to go when directions were just offered. */
const AFFIRM = /^(yes|yeah|yea|yep|yup|ok|okay|sure|please|go ahead|yes please|please do|do it|oya|alright|of course)\b/;
/** Unambiguous "go", whatever was said before. */
const GO_WORDS =
  /\b(take me there|go there|let s go|lets go|start (?:the )?(?:route|trip|navigation)|navigate there|drive there|walk there|show me the way|take me)\b/;
const TRAFFIC = /\b(traffic|congest\w*|go ?slow|hold ?up|jam|gridlock|road (?:is )?clear|is the road (?:free|clear|busy))\b/;
const WEATHER =
  /\b(weather|rain\w*|forecast|temperature|how hot|how cold|sunny|storm\w*|humid\w*|cloudy|drizzl\w*|thunder\w*|umbrella)\b/;
const NEARBY =
  /\b(near|nearest|nearby|around|closest|close to me|close by|around me|any|find|where can i|looking for|i need|i want|show me|recommend|best|good)\b/;
const AREA_ASK =
  /\b(where is|where s|wheres|what is|whats in|what s in|tell me about|about|places in|things in|landmarks in|explore|what can i find in|describe)\b/;
const LOOKUP = /\b(where is|where s|wheres|find|locate|search for|search|show me|look up|lookup|how do i find)\b/;
const ADDRESSY =
  /\b(street|road|close|crescent|avenue|junction|plaza|estate|behind|opposite|beside|near the|after the|before the|plot|house)\b|\d/;
const THERE = /^(?:there|it|that|this|that place|this place|that one|this one|the place|(?:the )?(?:nearest|closest|first) one)$|\b(there|that place|this place|that one|this one)\b/;
const ORDINAL = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/;
const STREET_HINT =
  /\b(road|rd|way|street|st|expressway|express|avenue|crescent|bridge|highway|junction|roundabout|interchange|flyover)\b/;
const OFFERED_DIRECTIONS =
  /\b(directions?|routes?|take you|navigate|get there|go there|want to go|head there|start)\b/i;

const ORDINAL_INDEX: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2,
  fourth: 3, "4th": 3, fifth: 4, "5th": 4,
};

/** "Find Me, where is…" — the app's own name is not part of the request. */
function stripAppName(text: string): string {
  return text.replace(/^\s*(?:hey |hi |ok |okay )?find ?me(?: ai)?[\s,:;!.-]+/i, "").trim();
}

function matchCategory(text: string): CategoryMatch | undefined {
  for (const entry of CATEGORIES) {
    if (entry.pattern.test(text) && !entry.exclude?.test(text)) {
      return { query: entry.query, label: entry.label };
    }
  }
  return undefined;
}

const LEAD_IN =
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:please\s+)?(?:help me\s+)?(?:(?:find me|show me)\s+)?(?:take me to|take me|navigate (?:me )?to|(?:give me )?directions? to|how (?:do|can|will) i get to|how to get to|route (?:me )?to|drive me to|drive to|walk me to|walk to|ride to|go to|get to|get me to|guide me to|lead me to|show me the way to|how far is|drop me at|where is|where s|wheres|find|locate|search for|look up|show me|tell me about)\s+/i;

/** The destination or place from a request, without the wrapper words. */
export function extractTarget(text: string): string {
  return stripAppName(text)
    .replace(LEAD_IN, "")
    .replace(/\b(?:from here|from my location|from where i am|please|right now)\b/gi, "")
    .replace(/[?.!,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function referencedPlace(
  text: string,
  places: ContextPlace[],
): { place: ContextPlace; how: "ordinal" | "name" | "pronoun" } | null {
  if (places.length === 0 || !text) return null;

  const ordinal = ORDINAL.exec(text)?.[1];
  if (ordinal) {
    const index = ordinal === "last" ? places.length - 1 : ORDINAL_INDEX[ordinal] ?? 0;
    const place = places[Math.min(index, places.length - 1)];
    if (place) return { place, how: "ordinal" };
  }

  let best: { place: ContextPlace; score: number } | null = null;
  for (const place of places) {
    const score = tokenSimilarity(text, place.name);
    if (score >= 0.6 && (!best || score > best.score)) best = { place, score };
  }
  if (best) return { place: best.place, how: "name" };

  if (THERE.test(text)) return { place: places[0]!, how: "pronoun" };
  return null;
}

/**
 * Words that qualify a category rather than name a place: "a", "good",
 * "nearest", "open". A name is none of these.
 */
const CATEGORY_FILLER = new Set([
  "a", "an", "any", "the", "some", "my", "our", "near", "nearest", "closest",
  "close", "nearby", "around", "me", "to", "in", "at", "on", "of", "and", "or",
  "for", "find", "show", "where", "is", "get", "go", "i", "we", "you", "need",
  "want", "looking", "please", "good", "best", "cheap", "nice", "new", "open",
  "here", "there", "this", "that", "big", "small", "24", "hour", "hours",
]);

/**
 * The words naming a place in front of its category — "clover" in "clover
 * hospital", "christian community" in "christian community school".
 *
 * Only words BEFORE the category word count. "a park to relax" has a spare
 * word too, but it comes after and qualifies the park rather than naming it,
 * and treating it as a name would turn an ordinary category search into a
 * hunt for a place called "relax". District names are excluded — "hotels in
 * Wuse 2" names an area to search, not a hotel.
 */
function nameBeforeCategory(
  words: string[],
  category: CategoryMatch,
  names: NameMatch[],
): string[] {
  const districtWords = new Set(
    names
      .filter((name) => name.kind === "district")
      .flatMap((name) => name.heard.split(" ")),
  );

  const categoryAt = words.findIndex((word) => {
    // Test each word on its own so "bus station" matches at "bus".
    const pattern = new RegExp(category.query.split(" ")[0]!, "i");
    return pattern.test(word) || CATEGORIES.some((entry) => entry.query === category.query && entry.pattern.test(word));
  });

  if (categoryAt <= 0) return [];

  return words
    .slice(0, categoryAt)
    .filter(
      (word) =>
        word.length > 2 &&
        !CATEGORY_FILLER.has(word) &&
        !districtWords.has(word) &&
        !/^\d+$/.test(word),
    );
}

function cleanPiece(piece: string): string {
  return piece
    .replace(/^\s*(?:the)\s+/i, "")
    .replace(/\s+(?:now|today|right now|this morning|this evening|at the moment|currently)$/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
}

/** "traffic on Sani Abacha road, or Murtala road" -> both roads. */
function extractRoads(text: string, names: NameMatch[]): string[] {
  const found: string[] = [];

  const segment = /\b(?:on|along|at|around|through|via|for)\s+(.+)$/i.exec(text)?.[1];
  const pieces = segment
    ? segment.split(/\s*(?:,|\bor\b|\band\b|\/)\s*/i).map(cleanPiece).filter(Boolean)
    : [];

  for (const piece of pieces) {
    const road = findPlaceNames(piece, ["road", "landmark"])[0];
    if (road) found.push(road.name);
    else if (STREET_HINT.test(normalise(piece))) found.push(piece);
  }

  for (const name of names) {
    if (name.kind === "road") found.push(name.name);
  }

  return [...new Map(found.map((road) => [road.toLowerCase(), road])).values()].slice(0, 3);
}

export function classifyIntent(
  raw: string,
  context: { places?: ContextPlace[]; lastAssistant?: string | null } = {},
): Intent {
  const said = stripAppName(raw);
  const text = normalise(said);
  const words = text.split(" ").filter(Boolean);
  const names = findPlaceNames(said);
  const corrections = names.filter((name) => !name.exact);
  const places = context.places ?? [];
  const base = { corrections, names };

  if (!text) return { kind: "unknown", ...base, reason: "empty" };

  const category = matchCategory(text);
  const corrected = (value: string) => applyCorrections(value, corrections);
  const isRoute = ROUTE.test(text);

  if (
    SMALLTALK.test(text) &&
    words.length <= 6 &&
    !category &&
    !isRoute &&
    names.length === 0
  ) {
    return { kind: "smalltalk", ...base, reason: "greeting or chat" };
  }

  // "closest restaurant from my location" mentions a location but asks for a
  // restaurant, so a category or a destination always wins over this.
  if (WHERE_AM_I.test(text) && !category && !isRoute) {
    return { kind: "where_am_i", ...base, reason: "asks own location" };
  }

  // Follow-ups about something already on screen: "take me there", "yes",
  // "directions to the second one", "take me to Kilimanjaro".
  if (places.length > 0) {
    const routeTarget = isRoute ? normalise(extractTarget(said)) : null;
    const reference = referencedPlace(routeTarget ?? text, places);
    const newDestination =
      routeTarget !== null && routeTarget !== "" && !THERE.test(routeTarget) && reference === null;

    if (!newDestination) {
      const offered = Boolean(context.lastAssistant && OFFERED_DIRECTIONS.test(context.lastAssistant));
      const affirm = AFFIRM.test(text) && words.length <= 6;
      const go = GO_WORDS.test(text) && words.length <= 7;
      const named = reference !== null && reference.how !== "pronoun";

      if ((affirm && (offered || named)) || go || (routeTarget !== null && reference !== null)) {
        const place = reference?.place ?? places[0]!;
        return {
          kind: "directions",
          place,
          ...base,
          reason: `follow-up to ${reference?.how ?? "latest"} place`,
        };
      }
    }
  }

  if (TRAFFIC.test(text)) {
    const roads = extractRoads(said, names);
    if (roads.length > 0) {
      return { kind: "road_traffic", roads, ...base, reason: "traffic on a named road" };
    }

    const destination = /\b(?:to|towards)\s+(.+)$/i.exec(said)?.[1];
    if (destination) {
      return {
        kind: "directions",
        target: corrected(cleanPiece(destination)),
        ...base,
        reason: "traffic to a destination",
      };
    }

    return { kind: "unknown", ...base, reason: "traffic without a road or destination" };
  }

  if (isRoute) {
    const target = extractTarget(said);
    const targetText = normalise(target);

    if (category && /\b(nearest|closest|near|nearby|any|a|an)\b/.test(targetText)) {
      return { kind: "directions", category, ...base, reason: "route to nearest category" };
    }

    if (target && !THERE.test(targetText)) {
      return { kind: "directions", target: corrected(target), ...base, reason: "route to named place" };
    }

    return { kind: "unknown", ...base, reason: "route with no destination" };
  }

  if (WEATHER.test(text)) {
    const where = /\b(?:in|at|for|around|over)\s+([a-z0-9' -]+?)(?:\s+(?:today|tomorrow|now|tonight|this (?:morning|afternoon|evening|week)|right now))?[?.!]*$/i.exec(
      said,
    )?.[1];
    const place =
      where && !/^(?:the )?(?:morning|evening|afternoon|night|week|weekend|moment)$/i.test(where.trim())
        ? corrected(where.trim())
        : undefined;
    return { kind: "weather", target: place, ...base, reason: place ? "weather in a named place" : "weather here" };
  }

  /*
   * A name in front of a category is a specific place, not a category search.
   *
   * "clover hospital" is two words, so it used to fall straight through to
   * "find me any hospital" and answered with the nearest one — substituting a
   * different hospital for the one that was named, which is the failure this
   * app most needs to avoid. "a park to relax" is not that: the extra word
   * comes after the category and qualifies it rather than naming it.
   */
  const namedPlace =
    category !== undefined &&
    (names.some((name) => name.kind === "landmark") ||
      // "where can I get fuel" has spare words too, but they ask for any
      // filling station; the phrasing itself says it is a category search.
      (!NEARBY.test(text) && nameBeforeCategory(words, category, names).length > 0));

  if (namedPlace) {
    const target = extractTarget(said);
    if (target) {
      return {
        kind: "place_lookup",
        target: corrected(target),
        ...base,
        reason: "a specific place named in front of a category",
      };
    }
  }

  if (category && (NEARBY.test(text) || words.length <= 4)) {
    const areaPhrase = /\b(?:in|at|around|inside)\s+(.+?)[?.!]*$/i.exec(said)?.[1];
    const areaName = areaPhrase
      ? findPlaceNames(areaPhrase, ["district", "landmark"])[0]?.name
      : undefined;
    return {
      kind: "nearby",
      category,
      area: areaName,
      ...base,
      reason: areaName ? "category in a named area" : "category near the user",
    };
  }

  const district = names.find((name) => name.kind === "district");
  if (district && (AREA_ASK.test(text) || words.length <= district.heard.split(" ").length + 2)) {
    return { kind: "area_info", target: district.name, ...base, reason: "asks about a district" };
  }

  if (LOOKUP.test(text) || AREA_ASK.test(text) || ADDRESSY.test(text) || names.some((n) => n.kind === "landmark")) {
    const target = extractTarget(said);
    if (target) return { kind: "place_lookup", target: corrected(target), ...base, reason: "looks up a place" };
  }

  return { kind: "unknown", ...base, reason: "no confident match" };
}
