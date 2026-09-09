/**
 * Step 6 — disambiguation.
 *
 * The rule from the master document: one *specific* question, never a generic
 * retry. "Can you be more specific?" pushes the work back onto the user and
 * usually produces the same phrase again, slightly louder. "Is yours the one
 * near Wuse Market, or the one in Garki?" is answerable in one tap.
 *
 * So the job here is to find what actually separates the top candidates, and
 * ask about that one thing. The discriminators are tried cheapest-first: the
 * address is already in hand, whereas a landmark lookup costs a Places call.
 */

import type { PlacesProvider } from "@/lib/providers/types";
import { distanceMetres } from "@/lib/geo/distance";
import { normalise } from "@/lib/text/similarity";
import type {
  DisambiguationOption,
  DisambiguationQuestion,
  ScoredCandidate,
} from "./types";

/** Only the plausible few are worth asking about. */
const MAX_OPTIONS = 3;
/** How far around a candidate to look for a distinguishing landmark. */
const LANDMARK_RADIUS_M = 700;

export interface DisambiguateInput {
  ranked: ScoredCandidate[];
  /** Supplying this enables landmark-based questions, at one call per option. */
  places?: PlacesProvider;
}

export async function buildQuestion(
  input: DisambiguateInput,
): Promise<DisambiguationQuestion | null> {
  const top = input.ranked.slice(0, MAX_OPTIONS);
  if (top.length < 2) return null;

  // Cheapest first: the address text we already have.
  const byArea = discriminateByAddress(top);
  if (byArea) return byArea;

  const byName = discriminateByName(top);
  if (byName) return byName;

  // Costs a Places call per option, so it runs only when the free
  // discriminators could not separate the candidates.
  if (input.places) {
    const byLandmark = await discriminateByLandmark(top, input.places);
    if (byLandmark) return byLandmark;
  }

  return discriminateByDistance(top);
}

// ---------------------------------------------------------------------------
// Address segments
// ---------------------------------------------------------------------------

/**
 * Find the comma-separated address segment that differs across candidates.
 *
 * "Buhari Street, Rayfield, Jos, Plateau" against "Buhari Street, Terminus,
 * Jos, Plateau" differ at index 1 — so the district is the question, and the
 * repeated street name is not. Doing this positionally keeps it working for
 * any city without a hand-maintained list of districts.
 */
function discriminateByAddress(
  top: ScoredCandidate[],
): DisambiguationQuestion | null {
  const segmented = top.map((entry) =>
    entry.candidate.formattedAddress
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

  if (segmented.some((segments) => segments.length === 0)) return null;

  const depth = Math.max(...segmented.map((s) => s.length));

  for (let index = 0; index < depth; index++) {
    const values = segmented.map((segments) => segments[index] ?? "");
    if (values.some((value) => !value)) continue;

    const distinct = new Set(values.map(normalise));
    // Every candidate must sit in a different one, or the question does not
    // actually resolve anything.
    if (distinct.size !== values.length) continue;

    const options: DisambiguationOption[] = top.map((entry, i) => ({
      candidateId: entry.candidate.id,
      label: entry.candidate.name,
      detail: values[i] ?? "",
    }));

    return {
      question: `I found ${top.length} places matching that. Which one — the one in ${joinNaturally(
        values,
      )}?`,
      discriminator: "area",
      options,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function discriminateByName(
  top: ScoredCandidate[],
): DisambiguationQuestion | null {
  const names = top.map((entry) => entry.candidate.name);
  const distinct = new Set(names.map(normalise));
  if (distinct.size !== names.length) return null;

  return {
    question: `Did you mean ${joinNaturally(names, "or")}?`,
    discriminator: "name",
    options: top.map((entry) => ({
      candidateId: entry.candidate.id,
      label: entry.candidate.name,
      detail: entry.candidate.formattedAddress,
    })),
  };
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/**
 * Ask by what is near each candidate.
 *
 * This is the shape the master document uses as its worked example, and it is
 * the most natural for a user who described the place by landmark in the first
 * place — they are being asked in the same language they used.
 */
async function discriminateByLandmark(
  top: ScoredCandidate[],
  places: PlacesProvider,
): Promise<DisambiguationQuestion | null> {
  const nearby = await Promise.all(
    top.map(async (entry) => {
      const results = await places
        .nearbySearch({
          center: entry.candidate.point,
          radiusM: LANDMARK_RADIUS_M,
          maxResults: 5,
        })
        .catch(() => []);

      // The most recognisable thing nearby that is not the candidate itself.
      const landmark = results
        .filter((r) => r.placeId !== entry.candidate.placeId)
        .sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0))[0];

      return landmark?.name ?? null;
    }),
  );

  if (nearby.some((name) => !name)) return null;

  const distinct = new Set(nearby.map((name) => normalise(name ?? "")));
  if (distinct.size !== nearby.length) return null;

  return {
    question: `Is yours the one near ${joinNaturally(
      nearby.filter((n): n is string => Boolean(n)),
      "or",
    )}?`,
    discriminator: "anchor",
    options: top.map((entry, index) => ({
      candidateId: entry.candidate.id,
      label: entry.candidate.name,
      detail: `near ${nearby[index]}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Distance (last resort)
// ---------------------------------------------------------------------------

function discriminateByDistance(
  top: ScoredCandidate[],
): DisambiguationQuestion | null {
  const first = top[0];
  if (!first) return null;

  const options: DisambiguationOption[] = top.map((entry) => {
    const metres = distanceMetres(first.candidate.point, entry.candidate.point);
    return {
      candidateId: entry.candidate.id,
      label: entry.candidate.name,
      detail:
        metres < 1
          ? entry.candidate.formattedAddress
          : `${formatDistance(metres)} from the first option`,
    };
  });

  return {
    question: `There are ${top.length} possible spots and they are some way apart. Can you name something close by — a shop, a junction, a filling station?`,
    discriminator: "distance",
    options,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinNaturally(values: string[], conjunction = "or"): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  const head = values.slice(0, -1).join(", ");
  const tail = values[values.length - 1] ?? "";
  return `${head} ${conjunction} ${tail}`;
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
