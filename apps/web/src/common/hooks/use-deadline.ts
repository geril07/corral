import { useEffect, useRef } from "react";

/** A browser clamps one timer to this; a longer wait is re-armed in steps rather than fired early. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Calls `onPass` when `at` arrives, once, and re-arms when `at` changes. A tab that was suspended
 * fires the timer on resume and finds the deadline already passed, so one call is all it needs.
 */
export function useDeadline(at: number | null, onPass: (at: number) => void): void {
  const pass = useRef(onPass);
  useEffect(() => {
    pass.current = onPass;
  }, [onPass]);
  useEffect(() => {
    if (at === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const remaining = at - Date.now();
      if (remaining <= 0) {
        pass.current(at);
        return;
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    arm();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [at]);
}
