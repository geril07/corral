import { useCallback, useRef } from "react";

/** The part of a React keyboard event the guard reads; a real event also carries the modifiers. */
interface EnterEvent {
  key: string;
  nativeEvent: { isComposing: boolean };
}

export interface EnterGuard {
  /** `onCompositionStart`: an IME composition owns the next Enter. */
  start: () => void;
  /** `onCompositionEnd`: after a confirming keydown, the next Enter is real again. */
  end: () => void;
  /** Any key that is not the guarded Enter closes the Safari window described below. */
  noteKey: (key: string) => void;
  /**
   * True when this Enter confirms an IME composition and must not submit. Chrome and Firefox send
   * the confirming keydown inside the composition; Safari ends the composition first, so its
   * `compositionend` alone cannot tell the confirming Enter from the user's next one. Recording
   * that a keydown was seen (`enterSeen`) makes both orders swallow exactly one Enter.
   */
  isComposition: (event: EnterEvent) => boolean;
}

/**
 * The A5 IME guard, shared by every composer (`docs/ux.md`: an Enter that confirms a composition
 * is never a submission, whichever order the platform reports the keydown and composition end).
 */
export function useEnterGuard(): EnterGuard {
  const state = useRef({ composing: false, ended: false, enterSeen: false });

  const start = useCallback(() => {
    state.current = { composing: true, ended: false, enterSeen: false };
  }, []);
  const end = useCallback(() => {
    state.current = {
      composing: false,
      ended: !state.current.enterSeen,
      enterSeen: false,
    };
  }, []);
  const noteKey = useCallback((key: string) => {
    if (key === "Enter") return;
    state.current = { composing: state.current.composing, ended: false, enterSeen: false };
  }, []);
  const isComposition = useCallback((event: EnterEvent) => {
    const current = state.current;
    if (event.nativeEvent.isComposing || current.composing || current.ended) {
      state.current = { composing: current.composing, ended: false, enterSeen: true };
      return true;
    }
    return false;
  }, []);

  return { start, end, noteKey, isComposition };
}
