/**
 * Step 3 — candidate generation.
 *
 * Candidates are pulled from independent sources in parallel. Independence is
 * the point: when a text search, a geocoder and the user's own history all land
 * within 60 m of each other, that agreement is strong evidence, and the scorer
 * rewards it. Sources that merely echo one another would produce false
 * agreement, so each one is queried from the parsed components directly rather
 * than chained off another source's answer.
 *
 * The one deliberate exception is the anchor hop, which has to be sequential:
 *
 *   "the guest house behind the mosque on Buhari Street, Wuse"
 *      1. geocode "Buhari Street, Wuse, Abuja"   -> a rough area centre
 *      2. nearby search "mosque" around it        -> the anchor's real point
 *      3. nearby search "guest house" around that -> the candidates
 *
 * That chain is how a landmark description becomes coordinates at all, and it
 * is the part a plain geocoder cannot do.
 */

import type { Providers } from "@/lib/providers/types";
import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import { localCentre } from "@/lib/geo/cities";
import { categoryQuery } from "@/lib/providers/osm/nominatim";
import type {
  Candidate,
  KnownPlace,
  ParsedPlace,
  RelationType,
  ResolutionContext,
} from "./types";

/** A landmark named in the phrase, resolved to a real point. */
export interface AnchorPoint {
  /** The anchor as the user said it: "mosque". */
  anchor: string;
  relation: RelationType;
  /** The matched place's actual name: "Wuse Central Mosque". */
  name: string;
  point: LatLng;
}

export interface CandidateInput {
  rawPhrase: string;
  parsed: ParsedPlace;
  context: ResolutionContext;
  providers: Providers;
  /** Find Me's own address graph — previously confirmed resolutions. */
  graphLookup?: (parsed: ParsedPlace, context: ResolutionContext) => Promise<KnownPlace[]>;
}

export interface CandidateOutput {
  candidates: Candidate[];
  anchors: AnchorPoint[];
  /** Rough centre the search was anchored on, for the harness to display. */
  searchCentre: LatLng | null;
}

/** Landmark relations are close-range: "behind" means metres, not kilometres. */
const ANCHOR_NEIGHBOURHOOD_M = 350;
/** How far from the area centre to look for the named anchor. */
const ANCHOR_SEARCH_RADIUS_M = 2000;

export async function generateCandidates(
  input: CandidateInput,
): Promise<CandidateOutput> {
  const { parsed, context, providers } = input;

  const searchCentre = await resolveSearchCentre(input);

  const [
    textCandidates,
    categoryCandidates,
    geocodeCandidates,
    anchorResult,
    graphCandidates,
  ] = await Promise.all([
    fromTextSearch(input, searchCentre),
    fromCategoryNearCentre(input, searchCentre),
    fromGeocoder(input, searchCentre),
    fromAnchors(input, searchCentre),
    fromGraph(input),
  ]);

  const personal = fromContext(context);

  return {
    candidates: [
      ...textCandidates,
      ...categoryCandidates,
      ...geocodeCandidates,
      ...anchorResult.candidates,
      ...graphCandidates,
      ...personal,
    ],
    anchors: anchorResult.anchors,
    searchCentre,
  };
}

// ---------------------------------------------------------------------------
// Search centre
// ---------------------------------------------------------------------------

/**
 * Where to bias searches.
 *
 * Answered from the local city registry before reaching for the network. This
 * used to geocode "Wuse 2, Abuja" on every single resolve, which under
 * Nominatim's one-request-per-second policy cost over a second before any
 * real search began — to look up a district centre that has not moved in
 * years.
 *
 * Preference order: a district the user named, then their actual position,
 * then the city centre. Their phone comes second because someone standing in
 * Garki can perfectly well ask about Kubwa.
 */
async function resolveSearchCentre(input: CandidateInput): Promise<LatLng | null> {
  const { parsed, context, providers } = input;

  const known = localCentre(parsed.area, parsed.city ?? context.city);
  if (known?.precision === "district") return known.point;

  if (context.currentLocation) return context.currentLocation;
  if (known) return known.point;

  // Only now is a lookup worth a network call — an area nobody has mapped yet.
  const locality = [parsed.area, parsed.city].filter(Boolean).join(", ");
  if (!locality) return null;

  const results = await providers.geocoding
    .forward(locality, context.currentLocation)
    .catch(() => []);

  return results[0]?.point ?? null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Query ladder, most specific first.
 *
 * Two lessons from running this against live Nominatim, both of which cost
 * nothing with Google and everything with OSM:
 *
 * 1. The category word poisons the query. Nominatim matches *names*, so
 *    "mosque Wuse 2 Abuja" returns zero results while "Wuse 2, Abuja" returns
 *    several — the word "mosque" appears in no name and simply fails the
 *    conjunction. Categories are Overpass's job, not text search's, so the
 *    type is only included when there is nothing else to search on.
 *
 * 2. A long conjunctive query returns nothing rather than degrading. Google
 *    quietly relaxes terms until something matches; Nominatim does not. So we
 *    relax them ourselves and stop at the first rung that returns anything.
 *
 * Capped at three rungs: each one is a rate-limited call about 1.2 s apart,
 * and a five-rung ladder would make every search feel broken.
 */
function queryLadder(parsed: ParsedPlace, rawPhrase: string): string[] {
  const { placeName, placeType, street, area, city } = parsed;
  const locality = [area, city].filter(Boolean).join(", ");

  const rungs: string[] = [];
  const add = (parts: Array<string | null>) => {
    const query = parts.filter(Boolean).join(" ").trim();
    if (query && !rungs.includes(query)) rungs.push(query);
  };

  if (placeName) {
    add([placeName, street, locality]);
    add([placeName, city]);
  } else if (street) {
    add([street, locality]);
    add([street, city]);
  } else if (placeType) {
    /*
     * Category search, on Nominatim's own terms.
     *
     * Nominatim understands "fuel in Maitama, Abuja" and returns real stations
     * in about 1.5s. Overpass answers the same question better in principle,
     * but it is volunteer-run and its latency swings to 20s+ under load, which
     * turned every category query into a hang. So the fast path goes here
     * first, and Overpass becomes the fallback rather than the default.
     *
     * The phrase has to be one Nominatim knows: "filling station" returns
     * nothing where "fuel" returns four results for the same places.
     */
    const categoryRung = categoryQuery(placeType, area, city);
    if (categoryRung) rungs.push(categoryRung);

    add([placeType, locality]);
  }

  add([rawPhrase]);

  // Two rungs, not three. Every extra rung is another ~1.2s of enforced wait,
  // and the third almost never rescued a query the second had missed.
  return rungs.slice(0, 2);
}

async function fromTextSearch(
  input: CandidateInput,
  centre: LatLng | null,
): Promise<Candidate[]> {
  const bias = centre ? { center: centre, radiusM: 5000 } : undefined;

  for (const query of queryLadder(input.parsed, input.rawPhrase)) {
    const results = await input.providers.places
      .textSearch({ query, bias, maxResults: 8 })
      .catch(() => []);

    if (results.length === 0) continue;

    return results.map((result, index) => ({
      id: `text:${result.placeId}:${index}`,
      source: "places_text" as const,
      name: result.name,
      formattedAddress: result.formattedAddress,
      point: result.point,
      placeId: result.placeId,
      types: result.types,
      prominence: result.prominence,
    }));
  }

  return [];
}

/**
 * Everything of the requested category near the search centre.
 *
 * This is the source that actually answers "the mosque on Aminu Kano Crescent"
 * and "the hotel in Farin Gada". Overpass queries OSM tags directly, so a
 * category search is a first-class operation rather than a string match that
 * happens to hit. It also runs against a different host from Nominatim, so it
 * costs no extra latency — the two rate-limit queues drain in parallel.
 */
async function fromCategoryNearCentre(
  input: CandidateInput,
  centre: LatLng | null,
): Promise<Candidate[]> {
  const { parsed, providers } = input;
  if (!centre) return [];

  /*
   * Categories only — never a proper name.
   *
   * Falling back to placeName here meant "Transcorp Hilton" was sent to
   * Overpass as a name-regex scan across a 3km radius, which is both slow and
   * imprecise for something text search answers instantly. A name is text
   * search's job; this source exists for "a pharmacy", "a filling station".
   */
  const category = parsed.placeType;
  if (!category) return [];

  /*
   * Skip Overpass when Nominatim already covers this category.
   *
   * Both sources answer the same question, but Nominatim does it in about a
   * second and a half while Overpass — volunteer-run, no SLA — swings between
   * two and twenty. Firing both in parallel does not hedge the risk, it
   * guarantees paying the slower one: the response cannot return until every
   * branch settles, so Overpass's timeout became the floor on every category
   * query.
   *
   * So Overpass now runs only for the categories Nominatim's vocabulary does
   * not include, where it is the difference between an answer and nothing.
   */
  if (categoryQuery(parsed.placeType ?? "", parsed.area, parsed.city)) {
    return [];
  }

  const results = await providers.places
    .nearbySearch({
      center: centre,
      radiusM: 3000,
      keyword: category,
      maxResults: 15,
    })
    .catch(() => []);

  return results.map((result, index) => ({
    id: `category:${result.placeId}:${index}`,
    source: "places_nearby" as const,
    name: result.name,
    formattedAddress: result.formattedAddress,
    point: result.point,
    placeId: result.placeId,
    types: result.types,
    prominence: result.prominence,
  }));
}

async function fromGeocoder(
  input: CandidateInput,
  centre: LatLng | null,
): Promise<Candidate[]> {
  const { parsed } = input;

  // A named place is text search's job, and both hit the same rate-limited
  // host — so geocoding as well just doubled the wait to re-find what the
  // name already found. The geocoder earns its call when there is a street
  // and no name, which is the case it is actually good at.
  if (parsed.placeName && !parsed.street) return [];

  const address = [parsed.houseNumber, parsed.street, parsed.area, parsed.city]
    .filter(Boolean)
    .join(", ");

  if (!address) return [];

  const results = await input.providers.geocoding
    .forward(address, centre ?? undefined)
    .catch(() => []);

  return results.map((result, index) => ({
    id: `geo:${index}:${result.point.lat.toFixed(5)},${result.point.lng.toFixed(5)}`,
    source: "geocode" as const,
    name: parsed.street ?? parsed.area ?? address,
    formattedAddress: result.formattedAddress,
    point: result.point,
    // A district centroid is a far weaker claim than a rooftop match, and the
    // scorer needs to know the difference.
    providerConfidence: precisionConfidence(result.precision),
  }));
}

function precisionConfidence(
  precision: "rooftop" | "interpolated" | "centroid" | "approximate",
): number {
  switch (precision) {
    case "rooftop":
      return 1;
    case "interpolated":
      return 0.7;
    case "centroid":
      return 0.35;
    default:
      return 0.15;
  }
}

/**
 * The anchor hop. Resolve each named landmark, then look around it.
 *
 * This is the part a plain geocoder cannot do, and the reason landmark
 * descriptions resolve at all.
 */
async function fromAnchors(
  input: CandidateInput,
  centre: LatLng | null,
): Promise<{ candidates: Candidate[]; anchors: AnchorPoint[] }> {
  const { parsed, providers } = input;
  if (parsed.landmarkRelations.length === 0) {
    return { candidates: [], anchors: [] };
  }

  const anchors: AnchorPoint[] = [];
  const candidates: Candidate[] = [];

  for (const relation of parsed.landmarkRelations) {
    // Locate the landmark itself. Constrain to the street/area where we have
    // one, otherwise "the mosque" matches every mosque in the country.
    const anchorQuery = [relation.anchor, parsed.street, parsed.area, parsed.city]
      .filter(Boolean)
      .join(" ");

    const anchorMatches = await providers.places
      .textSearch({
        query: anchorQuery,
        bias: centre ? { center: centre, radiusM: ANCHOR_SEARCH_RADIUS_M } : undefined,
        // One match only. Each additional candidate anchor costs another
        // rate-limited lookup plus a nearby search, and the scorer already
        // takes the best proximity within an anchor group.
        maxResults: 1,
      })
      .catch(() => []);

    for (const match of anchorMatches) {
      // Reject an "anchor" that is really the target: searching for a mosque
      // near a guest house must not return the guest house as the mosque.
      if (
        parsed.placeName &&
        match.name.toLowerCase().includes(parsed.placeName.toLowerCase())
      ) {
        continue;
      }

      anchors.push({
        anchor: relation.anchor,
        relation: relation.type,
        name: match.name,
        point: match.point,
      });

      const nearby = await providers.places
        .nearbySearch({
          center: match.point,
          radiusM: ANCHOR_NEIGHBOURHOOD_M,
          keyword: parsed.placeName ?? parsed.placeType ?? undefined,
          maxResults: 6,
        })
        .catch(() => []);

      for (const [index, place] of nearby.entries()) {
        // The anchor is not its own answer.
        if (place.placeId === match.placeId) continue;

        candidates.push({
          id: `anchor:${match.placeId}:${place.placeId}:${index}`,
          source: "places_nearby",
          name: place.name,
          formattedAddress: place.formattedAddress,
          point: place.point,
          placeId: place.placeId,
          types: place.types,
          prominence: place.prominence,
        });
      }
    }
  }

  return { candidates, anchors };
}

async function fromGraph(input: CandidateInput): Promise<Candidate[]> {
  if (!input.graphLookup) return [];

  const known = await input
    .graphLookup(input.parsed, input.context)
    .catch(() => [] as KnownPlace[]);

  return known.map((place) => ({
    id: `graph:${place.id}`,
    source: "graph" as const,
    name: place.name,
    formattedAddress: place.formattedAddress ?? "",
    point: place.point,
    confirmations: place.confirmations,
  }));
}

/** The user's own saved, recent and contact-shared places. */
function fromContext(context: ResolutionContext): Candidate[] {
  const build = (
    places: KnownPlace[] | undefined,
    source: Candidate["source"],
  ): Candidate[] =>
    (places ?? []).map((place) => ({
      id: `${source}:${place.id}`,
      source,
      name: place.name,
      formattedAddress: place.formattedAddress ?? "",
      point: place.point,
      confirmations: place.confirmations,
    }));

  return [
    ...build(context.savedPlaces, "saved"),
    ...build(context.recentPlaces, "history"),
    ...build(context.contactSharedPlaces, "contact_shared"),
  ];
}

// ---------------------------------------------------------------------------
// Clustering (used by the scorer for the source-agreement signal)
// ---------------------------------------------------------------------------

/** Points this close are treated as the same place. */
export const AGREEMENT_RADIUS_M = 60;

/**
 * Group candidates that refer to the same physical point.
 *
 * Single-link clustering over a 60 m radius. Good enough at this scale, and
 * cheap: candidate sets are single or low double digits, never large.
 */
export function clusterCandidates(candidates: Candidate[]): Candidate[][] {
  const clusters: Candidate[][] = [];

  for (const candidate of candidates) {
    const existing = clusters.find((cluster) =>
      cluster.some(
        (member) =>
          distanceMetres(member.point, candidate.point) <= AGREEMENT_RADIUS_M,
      ),
    );

    if (existing) existing.push(candidate);
    else clusters.push([candidate]);
  }

  return clusters;
}
