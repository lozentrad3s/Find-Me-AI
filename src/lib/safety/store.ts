/**
 * Which safety store is in use.
 *
 * Same seam pattern as the provider registry: read env, degrade rather than
 * fail, and record a note the health endpoint and the UI both surface. The
 * difference is that here the degradation is dangerous, so it is not merely
 * noted — `durable: false` travels with every alert and reaches the screen of
 * the person who opened it.
 */

import { MemorySafetyStore } from "./memory-store";
import { SupabaseSafetyStore } from "./supabase-store";
import type { SafetyStore } from "./types";

let cached: SafetyStore | null = null;

export function safetyStore(env: NodeJS.ProcessEnv = process.env): SafetyStore {
  if (cached) return cached;

  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  cached =
    url && key
      ? new SupabaseSafetyStore(url.replace(/\/$/, ""), key)
      : new MemorySafetyStore();

  return cached;
}

/** Test seam — lets the harness swap stores without env juggling. */
export function setSafetyStore(store: SafetyStore | null): void {
  cached = store;
}
