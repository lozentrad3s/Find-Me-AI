/**
 * A stable, non-identifying handle for one device.
 *
 * Lives here, not in a route file: Next.js route modules may only export
 * handlers and config, and exporting this from `/api/incidents/route.ts`
 * failed the production build's route type check.
 *
 * Salted with a server secret so the stored value cannot be reversed to an IP
 * even if the table leaks, and it stays server-side regardless. This is the
 * minimum needed to stop trivial self-confirmation and duplicate flooding; it
 * is not an identity and is deliberately not usable as one.
 *
 * Without SAFETY_SALT set it falls back to a fixed string, which still blocks
 * casual abuse from one device but is not a secret. That is a knowingly weak
 * default in exchange for the feature working with no configuration.
 */

import { createHash } from "node:crypto";

export function reporterHash(request: Request, deviceId: unknown): string {
  const salt = process.env.SAFETY_SALT?.trim() || "find-me-unsalted";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const device = typeof deviceId === "string" ? deviceId.slice(0, 64) : "";

  return createHash("sha256").update(`${salt}:${ip}:${device}`).digest("hex");
}
