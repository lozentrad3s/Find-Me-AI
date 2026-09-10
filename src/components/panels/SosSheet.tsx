"use client";

/**
 * SOS.
 *
 * The design constraints here come from the master document and they are not
 * stylistic:
 *
 * - It never touches the AI. Not the assistant, not a tool, not a model call.
 *   An emergency control must work when the network is bad, the API key is
 *   missing, and the model is rate-limited. `activate_sos` is deliberately not
 *   in the tool registry, so no prompt can ever trigger this.
 * - Hold to activate, not tap. A pocket tap that broadcasts your location and
 *   calls emergency services is worse than a control that takes 1.5 seconds of
 *   deliberate pressure. The hold is also cancellable the entire time.
 * - It states exactly what it will and will not do. Every dispatch channel
 *   reports its real status: what was sent, what needs a tap, and what cannot
 *   happen at all. A safety feature that appears to notify someone and does
 *   not is materially dangerous.
 *
 * WHAT ACTIVATING NOW ACTUALLY DOES
 *
 * Opens a server-side alert, starts a location beacon that reports every few
 * seconds, publishes the alert to the community safety map, and produces a
 * live tracking link to send to anyone. What it still does NOT do is reach a
 * security agency automatically — no Nigerian service has an endpoint to send
 * to — and the screen says that in those words rather than implying otherwise.
 *
 * The asymmetric timing is deliberate: 1.5s of slow deliberate hold, then an
 * instant response on release. Slow where the user is deciding, snappy where
 * the system answers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  MessageSquare,
  Phone,
  Radio,
  Share2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";

import type { LatLng } from "@/lib/geo/distance";
import type { SosBeacon } from "@/lib/safety/useSosBeacon";
import type { AlertKind, DispatchChannel } from "@/lib/safety/types";
import styles from "./SosSheet.module.css";

/** Long enough to be deliberate, short enough not to fight a panicking user. */
const HOLD_MS = 1500;

/**
 * Categories, in the words a Nigerian caller would use.
 *
 * Offered but never required — the button works without choosing one. Someone
 * being followed down a street does not have a spare hand for a taxonomy, so
 * the selector sits above the button and the default is "unspecified".
 */
const KINDS: Array<{ id: AlertKind; label: string }> = [
  { id: "crime", label: "Crime" },
  { id: "medical", label: "Medical" },
  { id: "accident", label: "Accident" },
  { id: "fire", label: "Fire" },
  { id: "harassment", label: "Harassment" },
  { id: "lost", label: "Lost" },
];

export interface SosSheetProps {
  open: boolean;
  location: LatLng | null;
  /** Human-readable position from the surroundings scan, when available. */
  locationDescription: string | null;
  /**
   * Owned by the page, not this sheet.
   *
   * An emergency must outlive the screen that started it: closing the sheet,
   * switching tabs or opening the assistant cannot be allowed to stop the
   * beacon. Lifting it also lets the map shell show a live banner.
   */
  beacon: SosBeacon;
  onClose: () => void;
}

export default function SosSheet({
  open,
  location,
  locationDescription,
  beacon,
  onClose,
}: SosSheetProps) {
  const [holdProgress, setHoldProgress] = useState(0);
  const [kind, setKind] = useState<AlertKind>("unspecified");
  const [copied, setCopied] = useState<string | null>(null);

  const holdRef = useRef<number | null>(null);
  const startedRef = useRef(0);

  const active = beacon.alert !== null;

  // Reset the transient bits when dismissed. The ALERT is not reset — closing
  // this sheet must never end an emergency; that takes the explicit stand-down.
  useEffect(() => {
    if (!open) {
      setHoldProgress(0);
      setCopied(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const cancelHold = useCallback(() => {
    if (holdRef.current !== null) {
      cancelAnimationFrame(holdRef.current);
      holdRef.current = null;
    }
    setHoldProgress(0);
  }, []);

  const beginHold = useCallback(() => {
    if (active || beacon.starting) return;

    startedRef.current = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startedRef.current;
      const progress = Math.min(1, elapsed / HOLD_MS);
      setHoldProgress(progress);

      if (progress >= 1) {
        holdRef.current = null;
        // A single firm buzz on completion. Confirms activation for someone
        // who cannot look at the screen.
        navigator.vibrate?.([40, 60, 120]);
        void beacon.open({ kind, note: "", locationDescription });
        return;
      }

      holdRef.current = requestAnimationFrame(tick);
    };

    holdRef.current = requestAnimationFrame(tick);
  }, [active, beacon, kind, locationDescription]);

  useEffect(() => cancelHold, [cancelHold]);

  if (!open) return null;

  const trackUrl = beacon.alert?.trackUrl ?? null;

  const shareText = trackUrl
    ? `EMERGENCY. I need help. Follow my live location: ${trackUrl}${
        locationDescription ? `\n${locationDescription}` : ""
      }`
    : location
      ? `EMERGENCY. I need help. My location: https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=18/${location.lat}/${location.lng}${
          locationDescription ? `\n${locationDescription}` : ""
        }`
      : "EMERGENCY. I need help. My location is not available on this device.";

  const share = async () => {
    if (navigator.share) {
      await navigator
        .share({ title: "Emergency", text: shareText })
        .catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(shareText).catch(() => undefined);
    setCopied("share");
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Emergency"
    >
      <div className={styles.topBar}>
        <span>
          <div className={styles.title}>Emergency</div>
          <div className={styles.subtitle}>
            {active ? "Your location is being shared" : "Your safety is the priority"}
          </div>
        </span>
        <button type="button" className={styles.close} onClick={onClose} title="Close">
          <X size={20} />
          <span className="sr-only">Close emergency screen</span>
        </button>
      </div>

      <div className={styles.stage}>
        {/* --- Category, before activation only -------------------------- */}
        {!active && (
          <div className={styles.kindRow} role="group" aria-label="What is happening">
            {KINDS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={styles.kindChip}
                data-selected={kind === entry.id}
                onClick={() => setKind(kind === entry.id ? "unspecified" : entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}

        <span className={styles.buttonWrap} data-holding={holdProgress > 0}>
          <button
            type="button"
            className={styles.button}
            data-active={active}
            onPointerDown={beginHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            disabled={active || beacon.starting}
            aria-label={
              active
                ? "SOS active"
                : "Hold for one and a half seconds to activate SOS"
            }
          >
            {/* Progress ring drawn with a conic gradient — no extra element,
                no layout, and it tracks the hold exactly. */}
            <span
              className={styles.progressRing}
              style={{
                background:
                  holdProgress > 0
                    ? `conic-gradient(#fff5f5 ${holdProgress * 360}deg, transparent 0deg)`
                    : "none",
                opacity: 0.35,
              }}
              aria-hidden="true"
            />
            {beacon.starting ? (
              <Loader2
                size={34}
                style={{ animation: "fm-spin 0.8s linear infinite" }}
                aria-hidden="true"
              />
            ) : (
              <ShieldAlert size={34} strokeWidth={2.2} aria-hidden="true" />
            )}
            SOS
            <span className={styles.buttonHint}>
              {beacon.starting ? "SENDING" : active ? "ACTIVE" : "HOLD"}
            </span>
          </button>
        </span>

        <div className={styles.status} aria-live="polite">
          {beacon.error ? (
            <>
              <p className={styles.statusTitle}>Alert failed</p>
              <p className={styles.statusBody}>{beacon.error}</p>
            </>
          ) : active ? (
            <>
              <p className={styles.statusTitle}>SOS active</p>
              <p className={styles.statusBody}>{beacon.alert?.summary}</p>
            </>
          ) : (
            <>
              <p className={styles.statusTitle}>Hold the button</p>
              <p className={styles.statusBody}>
                Press and hold for a moment. Release early to cancel.
              </p>
            </>
          )}
        </div>

        {/* --- Live beacon telemetry -------------------------------------- */}
        {active && (
          <div className={styles.beaconBox}>
            <div className={styles.beaconRow}>
              <Radio
                size={15}
                className={beacon.pingsFailed > 0 ? undefined : styles.pulse}
                aria-hidden="true"
              />
              {beacon.pingsFailed > 0
                ? `Position not sending (${beacon.pingsFailed} failed). Your last known position is still on the map.`
                : `Location sent ${beacon.pingsSent} ${
                    beacon.pingsSent === 1 ? "time" : "times"
                  } · updating every 5 seconds`}
            </div>

            {/*
              Browsers throttle geolocation hard in a background tab and there
              is no way around it from a web page. Saying so is the difference
              between a person keeping the screen on and one putting the phone
              in a pocket believing it is still reporting.
            */}
            {beacon.throttled && (
              <div className={styles.beaconWarn}>
                <TriangleAlert size={14} aria-hidden="true" />
                This tab is in the background, so your phone has slowed location
                updates. Keep this screen open.
              </div>
            )}
          </div>
        )}

        {/* --- The tracking link ------------------------------------------ */}
        {trackUrl && (
          <div className={styles.linkBox}>
            <div className={styles.linkLabel}>
              <Link2 size={14} aria-hidden="true" /> Live tracking link
            </div>
            <code className={styles.linkUrl}>{trackUrl}</code>
            <button
              type="button"
              className={styles.linkCopy}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(trackUrl)
                  .then(() => setCopied("link"))
                  .catch(() => undefined);
              }}
            >
              {copied === "link" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "link" ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        <div className={styles.locationBox}>
          {location ? (
            <>
              <div style={{ marginBottom: 4, opacity: 0.7 }}>Your location</div>
              {locationDescription && (
                <div style={{ marginBottom: 6 }}>{locationDescription}</div>
              )}
              <div className={styles.coords}>
                {location.lat.toFixed(6)}, {location.lng.toFixed(6)}
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 4, opacity: 0.7 }}>No location</div>
              Location permission has not been granted, so there is no position
              to send. Emergency calling still works.
            </>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {/* Calling works with no location, no network data and no API key,
            which is why it sits first. */}
        <a href="tel:112" className={styles.action} data-primary="true">
          <Phone size={19} aria-hidden="true" />
          Call 112
          <span className={styles.actionMeta}>Nigeria emergency</span>
        </a>

        <button type="button" className={styles.action} onClick={() => void share()}>
          <Share2 size={19} aria-hidden="true" />
          {copied === "share" ? "Copied to clipboard" : "Send my location"}
          <span className={styles.actionMeta}>
            {trackUrl ? "Live link" : "Share or copy"}
          </span>
        </button>

        <a
          href={`sms:?&body=${encodeURIComponent(shareText)}`}
          className={styles.action}
        >
          <MessageSquare size={19} aria-hidden="true" />
          Text my location
          <span className={styles.actionMeta}>Opens SMS</span>
        </a>

        <a href="tel:199" className={styles.action}>
          <Phone size={19} aria-hidden="true" />
          Police
          <span className={styles.actionMeta}>199</span>
        </a>

        {location && (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`)
                .then(() => setCopied("coords"))
                .catch(() => undefined);
            }}
          >
            <Copy size={19} aria-hidden="true" />
            {copied === "coords" ? "Copied" : "Copy coordinates"}
            <span className={styles.actionMeta}>To read aloud</span>
          </button>
        )}

        {active && (
          <button
            type="button"
            className={styles.action}
            data-safe="true"
            onClick={() => void beacon.resolve()}
          >
            <ShieldCheck size={19} aria-hidden="true" />
            I&rsquo;m safe now
            <span className={styles.actionMeta}>Stops sharing</span>
          </button>
        )}
      </div>

      {/* --- What happened, channel by channel --------------------------- */}
      {active && beacon.alert && (
        <div className={styles.dispatch}>
          <div className={styles.dispatchTitle}>Who has been told</div>
          {beacon.alert.dispatch.map((channel) => (
            <DispatchRow key={channel.id} channel={channel} />
          ))}
        </div>
      )}

      {!active && (
        <p className={styles.honest}>
          Activating shares your live location on a link you can send to anyone,
          and puts your alert on the safety map for other Find Me users nearby.
          No security agency is connected yet, so nothing reaches the police
          automatically — call 112 as well. Calling works without the AI, without
          an account, and without mobile data.
        </p>
      )}
    </div>
  );
}

/** One dispatch channel, coloured by what actually happened. */
function DispatchRow({ channel }: { channel: DispatchChannel }) {
  const icon =
    channel.status === "sent" ? (
      <Check size={14} aria-hidden="true" />
    ) : channel.status === "manual" ? (
      <Phone size={14} aria-hidden="true" />
    ) : (
      <TriangleAlert size={14} aria-hidden="true" />
    );

  const body = (
    <>
      <span className={styles.dispatchIcon} data-status={channel.status}>
        {icon}
      </span>
      <span>
        <span className={styles.dispatchLabel}>{channel.label}</span>
        <span className={styles.dispatchDetail}>{channel.detail}</span>
      </span>
    </>
  );

  // A `manual` channel is only honest if it is actually one tap away.
  return channel.action && channel.status === "manual" ? (
    <a href={channel.action} className={styles.dispatchRow}>
      {body}
    </a>
  ) : (
    <div className={styles.dispatchRow}>{body}</div>
  );
}
