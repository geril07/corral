import {
  resolveDirectKey,
  resolvePrefixKey,
  type DirectKeymap,
  type PrefixKeymap,
} from "@corral/client/prefix-keymap";
import type { ModifierPlatform } from "@corral/protocol/keymap";
import { useEffect, useRef, useState } from "react";

/** The platform's `mod` key for direct commands: Command on macOS, Control elsewhere. */
export function modifierPlatform(): ModifierPlatform {
  const platform = navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "mac" : "other";
}

/** A focused native terminal keeps its keys; direct commands are not stolen from it. */
function inNativeTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".terminal-host") !== null;
}

/**
 * Listens for the prefix chord and direct commands on the whole window, in the capture phase, so
 * a key it takes never reaches xterm.js. Returns whether prefix mode is armed. While `enabled` is
 * false (a dialog, Settings or a create in flight owns the keyboard) no key is taken, so typing
 * there is untouched. A held key never repeats a command, and IME composition is left alone.
 */
export function usePrefixMode<Action, Direct = never>(
  keymap: PrefixKeymap<Action>,
  onAction: (action: Action) => void,
  enabled: boolean,
  direct?: {
    keymap: DirectKeymap<Direct>;
    onAction: (action: Direct) => void;
  },
): boolean {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const directRef = useRef(direct);
  directRef.current = direct;

  useEffect(() => {
    if (!enabled) {
      armedRef.current = false;
      setArmed(false);
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      const currentDirect = directRef.current;
      if (!armedRef.current && currentDirect !== undefined && !inNativeTerminal(event.target)) {
        const chosen = resolveDirectKey(currentDirect.keymap, event);
        if (chosen !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          if (chosen.action !== undefined) currentDirect.onAction(chosen.action);
          return;
        }
      }
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
