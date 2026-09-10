"use client";

/**
 * SOS — screen 9 of the design reference.
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
 * - It states exactly what it will and will not do. Right now it puts your
 *   precise location in front of you, ready to send, and dials emergency
 *   services — it does not automatically alert anyone, because trusted
 *   contacts do not exist yet. A safety feature that appears to notify someone
 *   and does not is materially dangerous.
 *
 * The asymmetric timing is deliberate: 1.5s of slow deliberate hold, then an
 * instant response on release. Slow where the user is deciding, snappy where
 * the system answers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, MessageSquare, Phone, Share2, ShieldAlert, X } from "lucide-react";

import type { LatLng } from "@/lib/geo/distance";
import styles from "./SosSheet.module.css";

/** Long enough to be deliberate, short enough not to fight a panicking user. */
const HOLD_MS = 1500;

export interface SosSheetProps {
  open: boolean;
  location: LatLng | null;
  /** Human-readable position from the surroundings scan, when available. */
  locationDescription: string | null;
  onClose: () => void;
}

type Phase = "armed" | "active";

export default function SosSheet({
  open,
  location,
  locationDescription,
  onClose,
}: SosSheetProps) {
  const [phase, setPhase] = useState<Phase>("armed");
  const [holdProgress, setHoldProgress] = useState(0);
  const [copied, setCopied] = useState(false);

  const holdRef = useRef<number | null>(null);
  const startedRef = useRef(0);

  // Reset whenever the sheet is dismissed, so reopening never shows a stale
  // "active" state from a previous emergency.
  useEffect(() => {
    if (!open) {
      setPhase("armed");
      setHoldProgress(0);
      setCopied(false);
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
    if (phase === "active") return;

    startedRef.current = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startedRef.current;
      const progress = Math.min(1, elapsed / HOLD_MS);
      setHoldProgress(progress);

      if (progress >= 1) {
        holdRef.current = null;
        setPhase("active");
        // A single firm buzz on completion, where supported. Confirms
        // activation for someone who cannot look at the screen.
        navigator.vibrate?.([40, 60, 120]);
        return;
      }

      holdRef.current = requestAnimationFrame(tick);
    };

    holdRef.current = requestAnimationFrame(tick);
  }, [phase]);

  useEffect(() => cancelHold, [cancelHold]);

  if (!open) return null;

  const shareText = location
    ? `EMERGENCY. I need help. My location: https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=18/${location.lat}/${location.lng}${
        locationDescription ? `\n${locationDescription}` : ""
      }`
    : "EMERGENCY. I need help. My location is not available on this device.";

  const share = async () => {
    if (navigator.share) {
      await navigator.share({ title: "Emergency", text: shareText }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(shareText).catch(() => undefined);
    setCopied(true);
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
          <div className={styles.subtitle}>Your safety is the priority</div>
        </span>
        <button type="button" className={styles.close} onClick={onClose} title="Close">
          <X size={20} />
          <span className="sr-only">Close emergency screen</span>
        </button>
      </div>

      <div className={styles.stage}>
        <span className={styles.buttonWrap} data-holding={holdProgress > 0}>
          <button
            type="button"
            className={styles.button}
            onPointerDown={beginHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            aria-label={
              phase === "active"
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
            <ShieldAlert size={34} strokeWidth={2.2} aria-hidden="true" />
            SOS
            <span className={styles.buttonHint}>
              {phase === "active" ? "ACTIVE" : "HOLD"}
            </span>
          </button>
        </span>

        <div className={styles.status} aria-live="polite">
          {phase === "active" ? (
            <>
              <p className={styles.statusTitle}>SOS active</p>
              <p className={styles.statusBody}>
                Your location is ready to send. Use the buttons below — nothing
                has been sent automatically.
              </p>
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
          {copied ? "Copied to clipboard" : "Send my location"}
          <span className={styles.actionMeta}>Share or copy</span>
        </button>

        {location && (
          <a
            href={`sms:?&body=${encodeURIComponent(shareText)}`}
            className={styles.action}
          >
            <MessageSquare size={19} aria-hidden="true" />
            Text my location
            <span className={styles.actionMeta}>Opens SMS</span>
          </a>
        )}

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
                .then(() => setCopied(true))
                .catch(() => undefined);
            }}
          >
            <Copy size={19} aria-hidden="true" />
            Copy coordinates
            <span className={styles.actionMeta}>To read aloud</span>
          </button>
        )}

        <p className={styles.honest}>
          This screen does not alert anyone automatically. Trusted contacts and
          automatic alerts are not built yet, and a safety feature that looks
          like it notifies someone but does not is worse than none. Everything
          above works without the AI, without a signed-in account, and without
          mobile data — calling needs only a phone signal.
        </p>
      </div>
    </div>
  );
}
