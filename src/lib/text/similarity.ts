/**
 * Text normalisation and fuzzy matching.
 *
 * Tuned for Nigerian place names, which is why the stopword list carries
 * "street", "road", "close", "crescent" and friends: two candidates called
 * "Buhari Street" and "Buhari Crescent" must not score as near-identical
 * just because they share a generic suffix. The suffix is the discriminator,
 * so it is stripped from the token set and compared separately.
 */

/**
 * Generic street-type words. Meaningful for typing, useless for matching.
 *
 * "junction" and "roundabout" deliberately are NOT here. They look like the
 * same class of word but they name a *place category*, not a road suffix —
 * people say "meet me at the junction" and mean a specific spot. Listing them
 * made them stopwords, which stripped the only identifying token out of
 * "the junction at Bukuru express" and scored it 0.00 against a place actually
 * called Bukuru Express Junction.
 */
const STREET_TYPES = new Set([
  "street", "st", "road", "rd", "close", "crescent", "avenue", "ave", "way",
  "drive", "lane", "boulevard", "expressway", "bypass",
]);

/** Words that carry no discriminating signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "at", "in", "on", "to", "and", "by", "for",
  "off", "near", "opposite", "behind", "beside", "my", "that", "this",
  ...STREET_TYPES,
]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenise(text: string): string[] {
  return normalise(text).split(" ").filter(Boolean);
}

/** Tokens with stopwords and street types removed. */
export function contentTokens(text: string): string[] {
  return tokenise(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/** The street-type word in a string, if any: "Buhari Crescent" -> "crescent". */
export function streetType(text: string): string | null {
  for (const token of tokenise(text)) {
    if (STREET_TYPES.has(token)) return token;
  }
  return null;
}

/** Levenshtein distance, iterative with a single row buffer. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/** Levenshtein as a 0..1 similarity. */
export function editSimilarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(x, y) / longest;
}

/**
 * Token-set similarity that rewards containment.
 *
 * "Bluewiz" against "Bluewiz Lodge" should score high — the user gave a
 * partial name, not a wrong one. Plain Jaccard would punish that, so this
 * blends Jaccard with a containment ratio over the smaller token set.
 */
export function tokenSimilarity(a: string, b: string): number {
  const setA = new Set(contentTokens(a));
  const setB = new Set(contentTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      shared++;
      continue;
    }
    // Allow near-misses on longer tokens: spelling drift is common.
    for (const other of setB) {
      if (token.length >= 5 && editSimilarity(token, other) >= 0.8) {
        shared += 0.85;
        break;
      }
    }
  }

  const union = setA.size + setB.size - shared;
  const jaccard = union > 0 ? shared / union : 0;
  const containment = shared / Math.min(setA.size, setB.size);

  return 0.4 * jaccard + 0.6 * containment;
}

/**
 * Fraction of `needle`'s content tokens present in `haystack`, 0..1.
 *
 * Unlike `tokenSimilarity` this is asymmetric and ignores how long the
 * haystack is. That is what makes it right for locality matching: asking
 * "is Bukuru in this address?" should not be diluted by the address also
 * containing a road, a city and a state. Symmetric similarity scores a
 * present district around 0.7 and a wholly absent one around 0.42 once the
 * shared city name is counted, which is nowhere near enough separation to
 * act on.
 */
export function tokenContainment(needle: string, haystack: string): number {
  const wanted = contentTokens(needle);
  if (wanted.length === 0) return 0;

  const hay = new Set(contentTokens(haystack));
  if (hay.size === 0) return 0;

  let found = 0;
  for (const token of wanted) {
    if (hay.has(token)) {
      found += 1;
      continue;
    }
    for (const other of hay) {
      if (token.length >= 5 && editSimilarity(token, other) >= 0.8) {
        found += 0.85;
        break;
      }
    }
  }

  return Math.min(1, found / wanted.length);
}

/** True when every content token of `needle` appears in `haystack`. */
export function containsAllTokens(haystack: string, needle: string): boolean {
  const hay = new Set(contentTokens(haystack));
  const tokens = contentTokens(needle);
  if (tokens.length === 0) return false;
  return tokens.every((t) => hay.has(t));
}
