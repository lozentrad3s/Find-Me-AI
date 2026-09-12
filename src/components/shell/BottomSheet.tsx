"use client";

/**
 * Draggable bottom sheet with three snap detents.
 *
 * The canonical container for map applications — both Google Maps and Apple
 * Maps put their entire secondary interface in one, and the reason is
 * ergonomic rather than aesthetic: it keeps content within thumb reach while
 * never fully covering the map, so a user can see where they are and read
 * results at the same time.
 *
 *   peek — a strip: enough for one line and the handle
 *   half — the working position, roughly half the viewport
 *   full — reading position for long lists and conversations
 *
 * Implementation notes worth keeping:
 *
 * - The sheet is always full height and moves by `transform`. Animating height
 *   instead would relayout its children on every frame of a drag.
 * - Snapping uses velocity, not just position. Someone who flicks upward
 *   expects the sheet to open even if their finger only travelled 40px, which
 *   is the difference between a control that feels physical and one that feels
 *   like it is arguing with you.
 * - Inner scrolling is disabled at peek, otherwise dragging up scrolls the
 *   content rather than opening the sheet.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import styles from "./BottomSheet.module.css";

export type Detent = "peek" | "half" | "full";

/**
 * Fraction of viewport height *visible* at each detent.
 *
 * Peek is 26%, not 16%: the tab bar is fixed over the bottom ~78px of the
 * screen, so a 16% peek on a phone left barely a centimetre of content and cut
 * the panel's first line in half — which is exactly what it looked like in the
 * screenshots from the phone.
 */
const DETENT_HEIGHT: Record<Detent, number> = {
  peek: 0.26,
  half: 0.52,
  full: 0.92,
};

const ORDER: Detent[] = ["peek", "half", "full"];

/** px/ms past which a gesture counts as a flick regardless of distance. */
const FLICK_VELOCITY = 0.45;

export interface BottomSheetProps {
  detent: Detent;
  onDetentChange: (detent: Detent) => void;
  children: ReactNode;
  /** Accessible name for the sheet region. */
  label: string;
}

export default function BottomSheet({
  detent,
  onDetentChange,
  children,
  label,
}: BottomSheetProps) {
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const startRef = useRef({ y: 0, time: 0, offset: 0 });

  useEffect(() => {
    const measure = () => setViewportHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /** Distance from the top of the viewport to the top of the sheet. */
  const translateFor = useCallback(
    (target: Detent) => {
      if (viewportHeight === 0) return 0;
      return viewportHeight * (1 - DETENT_HEIGHT[target]);
    },
    [viewportHeight],
  );

  const restingY = translateFor(detent);
  const currentY = dragging ? restingY + dragOffset : restingY;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Capture so the drag survives the pointer leaving the handle.
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { y: event.clientY, time: performance.now(), offset: 0 };
    setDragging(true);
    setDragOffset(0);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;

    const delta = event.clientY - startRef.current.y;

    // Rubber-band past the top stop rather than allowing the sheet off-screen.
    const maxUp = -(restingY - translateFor("full"));
    const damped = delta < maxUp ? maxUp + (delta - maxUp) * 0.28 : delta;

    startRef.current.offset = damped;
    setDragOffset(damped);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;

    event.currentTarget.releasePointerCapture(event.pointerId);

    const { offset, time } = startRef.current;
    const elapsed = Math.max(1, performance.now() - time);
    const velocity = offset / elapsed;

    setDragging(false);
    setDragOffset(0);

    const index = ORDER.indexOf(detent);

    // A fast flick moves one detent in its direction, however short it was.
    if (Math.abs(velocity) > FLICK_VELOCITY) {
      const next = velocity < 0 ? index + 1 : index - 1;
      const clamped = Math.min(ORDER.length - 1, Math.max(0, next));
      onDetentChange(ORDER[clamped] ?? detent);
      return;
    }

    // Otherwise settle on whichever detent the sheet is physically closest to.
    const releasedY = restingY + offset;
    let closest = detent;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of ORDER) {
      const distance = Math.abs(translateFor(candidate) - releasedY);
      if (distance < bestDistance) {
        bestDistance = distance;
        closest = candidate;
      }
    }

    onDetentChange(closest);
  };

  /** Keyboard users get the same three positions without a drag gesture. */
  const onHandleKeyDown = (event: React.KeyboardEvent) => {
    const index = ORDER.indexOf(detent);

    if (event.key === "ArrowUp" && index < ORDER.length - 1) {
      event.preventDefault();
      onDetentChange(ORDER[index + 1] ?? detent);
    } else if (event.key === "ArrowDown" && index > 0) {
      event.preventDefault();
      onDetentChange(ORDER[index - 1] ?? detent);
    }
  };

  return (
    <section
      className={styles.sheet}
      data-dragging={dragging}
      data-detent={detent}
      style={{ transform: `translateY(${currentY}px)` }}
      aria-label={label}
    >
      <div
        className={styles.handleArea}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onHandleKeyDown}
        role="slider"
        tabIndex={0}
        aria-label="Resize panel"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={ORDER.indexOf(detent)}
        aria-valuetext={detent}
      >
        <span className={styles.handle} />
      </div>

      <div className={styles.body}>{children}</div>
    </section>
  );
}
