/**
 * Provider selection.
 *
 * Reads env and degrades rather than failing. A missing key is never an error:
 * it downgrades to the next best option and records a note that the harness and
 * the UI both surface, so you always know what actually served a result.
 *
 * Default is OSM (Nominatim + Overpass) because it needs no key and no billing,
 * which means the app runs on localhost the moment it is cloned.
 */

import type { Providers } from "./types";
import { MockPlacesProvider } from "./mock/places";
import { MockGeocodingProvider } from "./mock/geocoding";
import { MockLlmProvider } from "./mock/llm";
import { GooglePlacesProvider } from "./google/places";
import { GoogleGeocodingProvider } from "./google/geocoding";
import {
  NominatimGeocodingProvider,
  NominatimPlacesProvider,
} from "./osm/nominatim";
import { OverpassPlacesProvider } from "./osm/overpass";
import { AnthropicLlmProvider } from "./anthropic/llm";

export interface ProviderSelection extends Providers {
  /** Anything that silently downgraded, for display. */
  notes: string[];
}

/** Default parse model. Small and cheap — this is a bounded extraction task. */
const DEFAULT_PARSE_MODEL = "claude-haiku-4-5";

export function buildProviders(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSelection {
  const notes: string[] = [];
  const googleKey = env.GOOGLE_MAPS_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();

  const wantPlaces = (env.PLACES_PROVIDER ?? "osm").toLowerCase();
  const wantGeocoding = (env.GEOCODING_PROVIDER ?? "osm").toLowerCase();
  const wantLlm = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();

  // --- Places -------------------------------------------------------------
  let places: Providers["places"];

  if (wantPlaces === "google" && googleKey) {
    places = new GooglePlacesProvider(googleKey);
  } else if (wantPlaces === "mock") {
    places = new MockPlacesProvider();
  } else {
    if (wantPlaces === "google" && !googleKey) {
      notes.push(
        "PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is unset — using OpenStreetMap.",
      );
    }
    // Nominatim answers free text; Overpass answers "what is within N metres".
    // Neither does the other job well, so they are composed.
    const overpass = new OverpassPlacesProvider();
    places = new NominatimPlacesProvider(overpass);
  }

  // --- Geocoding ----------------------------------------------------------
  let geocoding: Providers["geocoding"];

  if (wantGeocoding === "google" && googleKey) {
    geocoding = new GoogleGeocodingProvider(googleKey);
  } else if (wantGeocoding === "mock") {
    geocoding = new MockGeocodingProvider();
  } else {
    if (wantGeocoding === "google" && !googleKey) {
      notes.push(
        "GEOCODING_PROVIDER=google but GOOGLE_MAPS_API_KEY is unset — using OpenStreetMap.",
      );
    }
    geocoding = new NominatimGeocodingProvider();
  }

  // --- LLM ----------------------------------------------------------------
  let llm: Providers["llm"];

  if (wantLlm === "anthropic" && anthropicKey) {
    llm = new AnthropicLlmProvider(
      anthropicKey,
      env.ANTHROPIC_PARSE_MODEL?.trim() || DEFAULT_PARSE_MODEL,
    );
  } else {
    if (wantLlm === "anthropic" && !anthropicKey) {
      notes.push(
        "ANTHROPIC_API_KEY is unset — parsing with the rule-based fallback. Search still works; the AI chat does not.",
      );
    }
    llm = new MockLlmProvider();
  }

  return { places, geocoding, llm, notes };
}

/** True when the chat endpoint can actually run. */
export function hasLlmCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}
