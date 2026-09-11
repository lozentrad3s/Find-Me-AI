"use client";

/**
 * Voice input and output via the Web Speech API.
 *
 * Free, no key, no server round trip — which is why it is the right choice at
 * this stage. The cost is coverage: SpeechRecognition is a Chrome and Edge
 * feature. Safari and Firefox do not have it, and on the ones that do, the
 * recogniser is tuned for a handful of accents that do not include Nigerian
 * English or Pidgin.
 *
 * So this is built as an enhancement that can be absent: `supported` is
 * reported honestly and the UI keeps a text input in every state.
 *
 * THE ORB BUG, AND WHAT FIXED IT
 *
 * Users reported having to close the voice screen and reopen it before the
 * orb would listen again. Two causes, both fixed here:
 *
 * 1. `recognition.start()` throws if the recogniser has not finished ending —
 *    which is exactly the state after a reply finishes and the auto-listen
 *    fires, or after a "no-speech" timeout. The old code swallowed that throw,
 *    so the tap did nothing and nothing said why. Now a start that lands while
 *    the recogniser is still winding down aborts it and starts again the
 *    moment it has ended.
 * 2. On Android Chrome, the pause/resume trick that keeps long replies from
 *    being cut off on desktop stops speech outright and never fires `onend`,
 *    so the screen stayed on "speaking" forever. The trick is desktop-only
 *    now, and a watchdog ends the "speaking" state when the engine has
 *    actually gone quiet, whether or not it said so.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// The API is still vendor-prefixed in shipping browsers and absent from the
// DOM typings, so the surface used here is declared locally.
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceOptions {
  /** Fired once, with the final transcript, when the user stops speaking. */
  onFinalTranscript?: (transcript: string) => void;
  /**
   * Fired when a spoken reply finishes by itself.
   *
   * This is what closes the hands-free loop: the caller listens again here
   * rather than guessing at a delay. It is NOT fired when speech is cut off
   * deliberately with `stopSpeaking` or `interrupt` — the caller already
   * knows what happens next in that case.
   */
  onSpeechEnd?: () => void;
  /** en-NG is requested first; browsers fall back on their own if unsupported. */
  lang?: string;
}

export interface UseVoice {
  supported: boolean;
  /** True when speech synthesis is usable in this browser. */
  canSpeak: boolean;
  /**
   * Call from a real user gesture (a tap) before any async speech.
   *
   * iOS Safari refuses `speechSynthesis.speak()` unless the call originates
   * in a user gesture, and it fails *silently*. Speaking one silent utterance
   * during a tap unlocks the queue for the rest of the session.
   */
  unlock: () => void;
  listening: boolean;
  /** Live transcript while speaking, including interim guesses. */
  transcript: string;
  error: string | null;
  speaking: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Stop talking and start listening — what tapping the orb mid-reply means. */
  interrupt: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
}

export function useVoice(options: UseVoiceOptions = {}): UseVoice {
  const { onFinalTranscript, onSpeechEnd, lang = "en-NG" } = options;

  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const unlockedRef = useRef(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** True from start() until onend — the recogniser's real state. */
  const activeRef = useRef(false);
  /** A start was requested while the recogniser was still ending. */
  const pendingStartRef = useRef(false);
  const startRef = useRef<() => void>(() => undefined);
  /** Incremented per utterance; a stale utterance's end is ignored. */
  const utteranceRef = useRef(0);

  // Held in refs so re-renders do not tear down an active recogniser.
  const callbackRef = useRef(onFinalTranscript);
  callbackRef.current = onFinalTranscript;
  const speechEndRef = useRef(onSpeechEnd);
  speechEndRef.current = onSpeechEnd;

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }

    setSupported(true);
    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      activeRef.current = true;
      setListening(true);
    };

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else interim += text;
      }

      setTranscript(final || interim);

      if (final.trim()) {
        callbackRef.current?.(final.trim());
        setTranscript("");
      }
    };

    recognition.onerror = (event) => {
      setListening(false);
      // "aborted" and "no-speech" are ordinary outcomes of the user changing
      // their mind, pausing, or a restart; surfacing them is just noise.
      if (event.error === "aborted" || event.error === "no-speech") return;

      setError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in your browser settings."
          : `Microphone error: ${event.error}`,
      );
    };

    recognition.onend = () => {
      activeRef.current = false;
      setListening(false);

      if (pendingStartRef.current) {
        pendingStartRef.current = false;
        // A beat for the engine to release the microphone.
        window.setTimeout(() => startRef.current(), 80);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      recognition.abort();
      recognitionRef.current = null;
      activeRef.current = false;
    };
  }, [lang]);

  const begin = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    setError(null);
    setTranscript("");

    try {
      recognition.start();
      activeRef.current = true;
      setListening(true);
    } catch {
      // Still ending from the last session. Finish ending it, then start —
      // onend picks the pending start up.
      pendingStartRef.current = true;
      try {
        recognition.abort();
      } catch {
        /* nothing to abort */
      }
    }
  }, []);

  const start = useCallback(() => {
    if (!recognitionRef.current) return;

    if (activeRef.current) {
      pendingStartRef.current = true;
      try {
        recognitionRef.current.abort();
      } catch {
        /* already stopping */
      }
      return;
    }

    begin();
  }, [begin]);

  startRef.current = start;

  const stop = useCallback(() => {
    pendingStartRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {
      /* not running */
    }
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listening || activeRef.current) stop();
    else start();
  }, [listening, start, stop]);

  // --- Speech synthesis ---------------------------------------------------

  useEffect(() => {
    if (typeof window === "undefined") return;
    setCanSpeak("speechSynthesis" in window);
  }, []);

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    try {
      // A single space at zero volume: audible to the engine, silent to the
      // user, and enough to satisfy iOS's gesture requirement.
      const primer = new SpeechSynthesisUtterance(" ");
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
      unlockedRef.current = true;
    } catch {
      // Nothing to recover — speech simply stays unavailable.
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    // Never let two replies talk over each other. Bumping the id first makes
    // the cancelled utterance's end event a no-op.
    const id = ++utteranceRef.current;
    window.speechSynthesis.cancel();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (id !== utteranceRef.current) return;
      setSpeaking(false);
      speechEndRef.current?.();
    };

    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (id === utteranceRef.current) setSpeaking(true);
    };
    utterance.onend = finish;
    // Fire on error too, or a failed utterance would strand the loop with the
    // microphone closed and nothing listening.
    utterance.onerror = finish;

    setSpeaking(true);
    window.speechSynthesis.speak(utterance);

    /*
     * Chrome on desktop stops speaking after roughly fifteen seconds unless
     * nudged. On Android the same nudge stops speech entirely and swallows
     * the end event, so it is desktop-only.
     */
    const android = /Android/i.test(navigator.userAgent);
    if (!android) {
      const keepAlive = window.setInterval(() => {
        if (finished || id !== utteranceRef.current || !window.speechSynthesis.speaking) {
          window.clearInterval(keepAlive);
          return;
        }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 10_000);
    }

    // The watchdog: if the engine has gone quiet but never said so, end the
    // "speaking" state ourselves, so the orb is never stuck.
    const startedAt = Date.now();
    const words = trimmed.split(/\s+/).length;
    const hardLimitMs = 8_000 + words * 900;
    const watchdog = window.setInterval(() => {
      if (finished || id !== utteranceRef.current) {
        window.clearInterval(watchdog);
        return;
      }
      const quiet = !window.speechSynthesis.speaking && !window.speechSynthesis.pending;
      const elapsed = Date.now() - startedAt;
      if ((quiet && elapsed > 1_200) || elapsed > hardLimitMs) {
        window.clearInterval(watchdog);
        if (!quiet) window.speechSynthesis.cancel();
        finish();
      }
    }, 700);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    utteranceRef.current += 1;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const interrupt = useCallback(() => {
    stopSpeaking();
    start();
  }, [start, stopSpeaking]);

  useEffect(() => stopSpeaking, [stopSpeaking]);

  return {
    supported,
    canSpeak,
    unlock,
    listening,
    transcript,
    error,
    speaking,
    start,
    stop,
    toggle,
    interrupt,
    speak,
    stopSpeaking,
  };
}
