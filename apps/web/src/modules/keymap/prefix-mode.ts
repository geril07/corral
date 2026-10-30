import { resolvePrefixKey, type PrefixKeymap } from "@corral/client/prefix-keymap";
import { useEffect, useRef, useState } from "react";

/**
 * Listens for the prefix chord and the key after it on the whole window, in the capture phase,
 * so a key it takes never reaches xterm.js. Returns whether prefix mode is armed. While
 * `enabled` is false (a dialog is open) no key is taken, so typing into the dialog is untouched.
 */
export function usePrefixMode<Action>(
  keymap: PrefixKeymap<Action>,
  onAction: (action: Action) => void,
  enabled: boolean,
): boolean {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      armedRef.current = false;
      setArmed(false);
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const outcome = resolvePrefixKey(keymap, armedRef.current, event);
      armedRef.current = outcome.armed;
      setArmed(outcome.armed);
      if (!outcome.handled) return;
      event.preventDefault();
      event.stopPropagation();
      if (outcome.action !== undefined) onAction(outcome.action);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [keymap, onAction, enabled]);

  return armed;
}
