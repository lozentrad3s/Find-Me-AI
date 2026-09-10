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
 * So this is built as an enhancement that can be absent, exactly as Part IV
 * requires: `supported` is reported honestly and the UI keeps a text input in
 * every state. Nobody should ever be unable to use the product because the
 * microphone did not understand them. Swapping in a cloud STT provider later
 * means replacing this hook, not the interface around it.
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
   * Fired when a spoken reply finishes.
   *
   * This is what closes the hands-free loop: the caller listens again here
   * rather than guessing at a delay, so the microphone reopens the instant the
   * assistant stops talking and not a moment before.
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
   * in a user gesture, and it fails *silently* — no error, no event, just no
   * sound. Since assistant replies arrive after a network round trip, they
   * are never in a gesture, so on iPhone every spoken answer was dropped
   * while the code looked correct. Speaking one silent utterance during a tap
   * unlocks the queue for the rest of the session.
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
  // Held in a ref so re-renders do not tear down an active recogniser.
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
      // their mind or pausing; surfacing them as errors is just noise.
      if (event.error === "aborted" || event.error === "no-speech") return;

      setError(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in your browser settings."
          : `Microphone error: ${event.error}`,
      );
    };

    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, [lang]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    setError(null);
    setTranscript("");

    try {
      recognition.start();
      setListening(true);
    } catch {
      // start() throws if it is already running; that is harmless.
    }
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
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

    // Never let two replies talk over each other.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      setSpeaking(false);
      speechEndRef.current?.();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      // Fire on error too, or a failed utterance would strand the loop with
      // the microphone closed and nothing listening.
      speechEndRef.current?.();
    };

    window.speechSynthesis.speak(utterance);

    /*
     * Chrome stops speaking after roughly fifteen seconds unless nudged.
     * A long answer would cut off mid-sentence without this, which sounds
     * like a crash rather than a limitation.
     */
    const keepAlive = window.setInterval(() => {
      if (!window.speechSynthesis.speaking) {
        window.clearInterval(keepAlive);
        return;
      }
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 10_000);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

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
    speak,
    stopSpeaking,
  };
}
