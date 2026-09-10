/**
 * Dispatch — who is actually told when someone activates SOS.
 *
 * THIS FILE IS THE HONEST PART OF THE SAFETY FEATURE.
 *
 * The ask was: "once a user turns on SOS our system automatically tracks and
 * shares their location to the security community around their precise
 * location." Every piece of that is built and working except one, and the one
 * matters: no Nigerian security organisation has a public dispatch API. The
 * NPF, NSCDC, FRSC and the state response agencies take phone calls. There is
 * no endpoint to POST an alert to, and inventing one would mean shipping a
 * screen that says help has been notified when nothing left the building.
 *
 * So this returns a PLAN, and every channel in it carries what actually
 * happened:
 *
 *   sent        — a request went out and succeeded. The alert is in the
 *                 community feed; anyone nearby with the app sees it now, and
 *                 the live tracking link resolves.
 *   manual      — real, works offline, but a human presses it. Dialling 112 is
 *                 the fastest genuine route to a Nigerian responder and it
 *                 needs only a phone signal, so it is never buried.
 *   unavailable — cannot happen, with the reason stated. SMS to next-of-kin
 *                 needs a gateway; an agency relay needs an agreement.
 *
 * THE SEAM FOR THE PITCH
 *
 * `SECURITY_PARTNERS` is where a partnered organisation plugs in. Give it a
 * webhook and a coverage area and its channel flips from `unavailable` to
 * `sent` with no other change anywhere in the codebase — the alert record,
 * the live trail, the tracking link and the responder view already exist and
 * already work. That is the thing to demonstrate: not a promise, a socket.
 */

import type { LatLng } from "@/lib/geo/distance";
import { distanceMetres } from "@/lib/geo/distance";
import type { DispatchChannel, SosAlert } from "./types";

/**
 * A partnered responder organisation.
 *
 * Empty until an agreement exists. Populated from `SECURITY_PARTNERS` (JSON)
 * so a pilot can be switched on for one command area without a deploy.
 */
export interface SecurityPartner {
  id: string;
  name: string;
  /** HTTPS endpoint that receives the alert payload. */
  webhook: string;
  /** Optional bearer token the partner issues. */
  token?: string;
  /** Centre of the area this partner covers. */
  centre: LatLng;
  /** Coverage radius in metres. */
  radiusM: number;
}

function loadPartners(env: NodeJS.ProcessEnv): SecurityPartner[] {
  const raw = env.SECURITY_PARTNERS?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is SecurityPartner =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SecurityPartner).webhook === "string" &&
        typeof (entry as SecurityPartner).name === "string",
    );
  } catch {
    // Malformed config must not take the SOS path down with it. The channel
    // below reports the partner list as unavailable, which is the truth.
    return [];
  }
}

/**
 * Nigeria's emergency numbers.
 *
 * 112 is the national toll-free emergency line and reaches a state response
 * centre. 199 is the police direct line, still widely answered where 112
 * coverage is patchy. Both are dialled by the user — that is a feature: a
 * phone call works when mobile data does not, and this app's data path is the
 * fragile one.
 */
export const EMERGENCY_NUMBERS = [
  { label: "National emergency", number: "112" },
  { label: "Police", number: "199" },
  { label: "Road safety (FRSC)", number: "122" },
] as const;

export interface DispatchInput {
  alert: SosAlert;
  /** Absolute URL of the live tracking page for this alert. */
  trackUrl: string;
  /** Nearby app users who will see the alert on the community map. */
  witnessesNotified: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the dispatch plan and report, channel by channel, what happened.
 *
 * Never throws. A failed channel becomes an `unavailable` entry with the
 * error in `detail`; an exception here would take down the whole SOS request
 * for someone in trouble.
 */
export async function dispatchAlert(
  input: DispatchInput,
): Promise<DispatchChannel[]> {
  const env = input.env ?? process.env;
  const channels: DispatchChannel[] = [];

  // --- 1. The community map ------------------------------------------------
  // This one is unconditionally real: the alert row exists, and every app
  // instance polling nearby alerts will render it. It is the channel the
  // product actually delivers today.
  channels.push({
    id: "community",
    label: "Find Me users near you",
    status: "sent",
    detail:
      input.witnessesNotified > 0
        ? `Your alert is live on the safety map. ${input.witnessesNotified} ${
            input.witnessesNotified === 1 ? "person" : "people"
          } nearby can see it.`
        : "Your alert is live on the safety map. Nobody else is using Find Me nearby right now, so no one has seen it yet.",
  });

  // --- 2. The live tracking link -------------------------------------------
  channels.push({
    id: "tracking",
    label: "Live location link",
    status: "sent",
    detail: input.alert.durable
      ? "Your position updates every few seconds at this link. Send it to anyone you trust."
      : "The alert database is not set up, so this link is unreliable — on the live server it may stop updating or stop working entirely. Do not rely on it alone: call someone as well.",
    action: input.trackUrl,
  });

  // --- 3. Partnered security organisations ---------------------------------
  const partners = loadPartners(env).filter(
    (partner) =>
      input.alert.lastFix === null ||
      distanceMetres(partner.centre, input.alert.lastFix) <= partner.radiusM,
  );

  if (partners.length === 0) {
    channels.push({
      id: "agencies",
      label: "Security agencies",
      status: "unavailable",
      detail:
        "No security organisation is connected to Find Me yet, so nothing was sent to one. Nigerian agencies take phone calls — use the buttons below.",
    });
  } else {
    const results = await Promise.all(
      partners.map((partner) => notifyPartner(partner, input)),
    );
    channels.push(...results);
  }

  // --- 4. Emergency services, by phone -------------------------------------
  // Listed as `manual` because that is what it is, and placed high because it
  // is the channel most likely to produce an actual responder.
  for (const entry of EMERGENCY_NUMBERS) {
    channels.push({
      id: `tel-${entry.number}`,
      label: entry.label,
      status: "manual",
      detail: `Tap to dial ${entry.number}. Works with no internet — only a phone signal.`,
      action: `tel:${entry.number}`,
    });
  }

  // --- 5. Trusted contacts by SMS ------------------------------------------
  const smsConfigured = Boolean(env.SMS_GATEWAY_URL?.trim());
  channels.push({
    id: "sms",
    label: "Text your people",
    status: smsConfigured ? "manual" : "unavailable",
    detail: smsConfigured
      ? "Opens your SMS app with your location and tracking link already written."
      : "Automatic SMS to next-of-kin needs a gateway account (Termii or Africa's Talking) which is not set up. Use the share button to send it yourself.",
  });

  return channels;
}

/** POST the alert to one partner. Failure is reported, never thrown. */
async function notifyPartner(
  partner: SecurityPartner,
  input: DispatchInput,
): Promise<DispatchChannel> {
  const { alert } = input;

  try {
    const response = await fetch(partner.webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(partner.token ? { Authorization: `Bearer ${partner.token}` } : {}),
      },
      body: JSON.stringify({
        source: "find-me",
        alert_id: alert.id,
        kind: alert.kind,
        opened_at: new Date(alert.openedAt).toISOString(),
        note: alert.note,
        location: alert.lastFix
          ? {
              lat: alert.lastFix.lat,
              lng: alert.lastFix.lng,
              accuracy_m: alert.lastFix.accuracyM,
            }
          : null,
        location_description: alert.locationDescription,
        live_tracking_url: input.trackUrl,
      }),
      // A responder that takes more than ten seconds to acknowledge is not
      // the fast path. Fail over to the phone rather than making the user
      // wait on a slow webhook.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        id: `partner-${partner.id}`,
        label: partner.name,
        status: "unavailable",
        detail: `${partner.name} did not accept the alert (HTTP ${response.status}). Call 112.`,
      };
    }

    return {
      id: `partner-${partner.id}`,
      label: partner.name,
      status: "sent",
      detail: `${partner.name} received your alert and your live location.`,
    };
  } catch (error) {
    return {
      id: `partner-${partner.id}`,
      label: partner.name,
      status: "unavailable",
      detail: `Could not reach ${partner.name} (${
        error instanceof Error ? error.message : "network error"
      }). Call 112.`,
    };
  }
}

/**
 * One-line summary for the top of the SOS screen and for voice.
 *
 * Deliberately leads with what did NOT happen when nothing real was sent. A
 * person in trouble needs to know within one sentence whether to start dialling.
 */
export function dispatchSummary(channels: DispatchChannel[]): string {
  const sent = channels.filter((channel) => channel.status === "sent");
  const agenciesReached = sent.some(
    (channel) => channel.id.startsWith("partner-"),
  );

  if (agenciesReached) {
    return "Security services have your alert and your live location.";
  }

  if (sent.length > 0) {
    return "Your alert is live and your location is being shared — but no security agency is connected yet, so call 112 as well.";
  }

  return "Nothing could be sent automatically. Call 112 now.";
}
