import {
  resolveDirectKey,
  resolvePrefixKey,
  type DirectKeymap,
  type PrefixKeymap,
} from "@corral/client/prefix-keymap";
import { matchesChord, parseChord, type ModifierPlatform } from "@corral/protocol/keymap";
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

/**
 * The palette's two-key sequence while the shell's keymap is paused, as Settings pauses it. The
 * prefix press is taken, but a key that does not complete the sequence still reaches the focused
 * control: a paused background chord must not swallow the next keystroke. The armed state is not
 * reported, so no prefix badge appears behind an overlay.
 */
export function usePausedPalette(
  prefix: string,
  binding: string | null,
  onOpen: () => void,
  enabled: boolean,
): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!enabled || binding === null) return undefined;
    const prefixChord = parseChord(prefix);
    const paletteChord = parseChord(binding);
    let armed = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      if (armed) {
        armed = false;
        if (!matchesChord(event, paletteChord)) return;
        event.preventDefault();
        event.stopPropagation();
        open.current();
        return;
      }
      if (!matchesChord(event, prefixChord)) return;
      armed = true;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [binding, enabled, prefix]);
}
