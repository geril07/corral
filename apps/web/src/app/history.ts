import { createHashHistory, type RouterHistory } from "@tanstack/react-router";

// TanStack history's direction protocol, coupled to @tanstack/react-router 1.170.46 and its
// @tanstack/history 1.162.5. A browser-created entry has no state, and the library reads it as
// index 0 each time, so a physical Forward can look like Back. Give the entry its real index
// before TanStack's own popstate handler reads it, and blocker.reset() can then compute the
// correct reverse traversal instead of a no-op. The package is pinned to the versions above; the
// browser action tests fail if the private key or its direction semantics change.
const INDEX_KEY = "__TSR_index";

type IndexedState = Record<string, unknown> & { __TSR_index: number };

function hasIndex(state: unknown): state is IndexedState {
  if (typeof state !== "object" || state === null || !(INDEX_KEY in state)) return false;
  const index = state[INDEX_KEY];
  return typeof index === "number" && Number.isSafeInteger(index);
}

/** A fresh key in the same shape TanStack assigns to its own entries. */
function createKey() {
  return (Math.random() + 1).toString(36).slice(7);
}

function indexedState(state: unknown, index: number): Record<string, unknown> {
  const key = createKey();
  return {
    ...(typeof state === "object" && state !== null ? state : {}),
    key,
    __TSR_key: key,
    [INDEX_KEY]: index,
  };
}

/**
 * Hash history for the app. It indexes browser-created entries (address bar, a native
 * `location.hash` write) before TanStack reads their state on `popstate`; otherwise TanStack
 * cannot tell a physical Forward from Back. The Navigation API gives the entry's exact position;
 * without it, a newly created entry is the next slot because a push truncates forward history.
 * The normalizer only writes the current entry's state and never navigates.
 */
export function createAppHistory(win: Window = window): RouterHistory {
  const nativeReplaceState = win.history.replaceState.bind(win.history);
  // Firefox and older Chromium builds may not have the Navigation API yet.
  const navigation = win.navigation as
    | { readonly currentEntry: { readonly index: number } | null }
    | undefined;
  const navigationIndex = () => {
    const index = navigation?.currentEntry?.index;
    return index === undefined || index < 0 ? undefined : index;
  };
  const baseNavigationIndex = navigationIndex();
  const initialState = win.history.state as unknown;
  let baseIndex = hasIndex(initialState) ? initialState[INDEX_KEY] : 0;
  if (!hasIndex(initialState)) {
    nativeReplaceState(indexedState(initialState, baseIndex), "");
  }

  let lastIndex = baseIndex;
  const normalizePopState = () => {
    const state = win.history.state as unknown;
    if (hasIndex(state)) {
      lastIndex = state[INDEX_KEY];
      return;
    }
    const currentNavigationIndex = navigationIndex();
    const index =
      baseNavigationIndex === undefined || currentNavigationIndex === undefined
        ? lastIndex + 1
        : baseIndex + currentNavigationIndex - baseNavigationIndex;
    lastIndex = index;
    nativeReplaceState(indexedState(state, index), "");
  };
  // Registered before createHashHistory: popstate is dispatched at window, where listeners run in
  // registration order, so this runs before TanStack's handler. The capture flag is not the
  // ordering guarantee; keep this registration ahead of the factory if this code moves.
  win.addEventListener("popstate", normalizePopState, { capture: true });

  const history = createHashHistory({ window: win });
  const unsubscribe = history.subscribe(({ location }) => {
    const index = location.state[INDEX_KEY];
    if (typeof index === "number") lastIndex = index;
  });
  const destroy = history.destroy.bind(history);
  history.destroy = () => {
    win.removeEventListener("popstate", normalizePopState, { capture: true });
    unsubscribe();
    destroy();
  };
  return history;
}
