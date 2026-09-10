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
import { GeminiLlmProvider } from "./gemini/llm";

export interface ProviderSelection extends Providers {
  /** Anything that silently downgraded, for display. */
  notes: string[];
}

/** Default parse model. Small and cheap — this is a bounded extraction task. */
const DEFAULT_PARSE_MODEL = "claude-haiku-4-5";
/** Gemini's free tier needs no card, which is why it is worth supporting. */
const DEFAULT_GEMINI_PARSE_MODEL = "gemini-3.7-flash";

export function buildProviders(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSelection {
  const notes: string[] = [];
  const googleKey = env.GOOGLE_MAPS_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const geminiKey = (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim();

  const wantPlaces = (env.PLACES_PROVIDER ?? "osm").toLowerCase();
  const wantGeocoding = (env.GEOCODING_PROVIDER ?? "osm").toLowerCase();
  /*
   * The PARSE step defaults to the rule-based parser, even when a model key
   * is present. This is deliberate and it is not a cost-saving compromise.
   *
   * Parsing is bounded structured extraction, and the rule-based parser
   * scores 88% on the harness — free, instant, deterministic, and offline.
   * Routing it through a model spends the scarcest resource in the system on
   * the task that needs it least: on Gemini's free tier every search consumed
   * one of about twenty daily calls, so a handful of searches exhausted the
   * quota and the *assistant* then stopped working. That is exactly backwards.
   *
   * Conversation is where a model is irreplaceable. Extraction is not.
   * Set LLM_PROVIDER explicitly to override.
   */
  const wantLlm = (env.LLM_PROVIDER ?? "rules").toLowerCase();

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
  } else if (wantLlm === "gemini" && geminiKey) {
    llm = new GeminiLlmProvider(
      geminiKey,
      env.GEMINI_PARSE_MODEL?.trim() || DEFAULT_GEMINI_PARSE_MODEL,
    );
  } else {
    if (wantLlm === "anthropic" && !anthropicKey) {
      notes.push("ANTHROPIC_API_KEY is unset — parsing with the rule-based parser.");
    }
    if (wantLlm === "gemini" && !geminiKey) {
      notes.push("GEMINI_API_KEY is unset — parsing with the rule-based parser.");
    }
    llm = new MockLlmProvider();
  }

  return { places, geocoding, llm, notes };
}

/** Which assistant the chat endpoint will use. */
export function selectAssistant(
  env: NodeJS.ProcessEnv = process.env,
): "claude" | "gemini" | "offline" {
  const forced = env.LLM_PROVIDER?.trim().toLowerCase();

  if (forced === "anthropic" && env.ANTHROPIC_API_KEY?.trim()) return "claude";
  if (forced === "gemini" && (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim()) {
    return "gemini";
  }
  if (forced === "mock" || forced === "offline") return "offline";

  if (env.ANTHROPIC_API_KEY?.trim()) return "claude";
  if ((env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)?.trim()) return "gemini";
  return "offline";
}
