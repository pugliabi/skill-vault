/**
 * Thin wrapper over the browser's Web Speech API (SpeechRecognition) for
 * the assistant composer's voice input. Chrome/Edge ship it (vendor-
 * prefixed); Firefox doesn't — callers hide the mic when unsupported.
 *
 * Shaped as start/stop with callbacks (not a hook) so the composer owns
 * exactly one recognizer across renders and can stop it on send/unmount.
 */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function ctor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && ctor() !== null;
}

export interface Dictation {
  stop(): void;
}

/**
 * Start dictating. `onFinal` fires per finalized utterance (append it to
 * the draft); `onInterim` carries the in-flight guess for live display;
 * `onEnd` fires exactly once when recognition stops for any reason
 * (mic button toggled, silence timeout, permission denied, no speech).
 */
export function startDictation(handlers: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onEnd: (error?: string) => void;
}): Dictation | null {
  const Ctor = ctor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  let lastError: string | undefined;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    handlers.onEnd(lastError);
  };

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0]?.transcript ?? "";
      if (r.isFinal) handlers.onFinal(text);
      else interim += text;
    }
    handlers.onInterim?.(interim);
  };
  rec.onerror = (e) => {
    // "no-speech" / "aborted" are normal endings, not failures worth surfacing.
    if (e.error && e.error !== "no-speech" && e.error !== "aborted") lastError = e.error;
  };
  rec.onend = end;

  try {
    rec.start();
  } catch {
    return null; // e.g. a second start() while one is pending
  }

  return {
    stop() {
      try {
        rec.stop();
      } catch {
        end();
      }
    },
  };
}
