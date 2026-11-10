import type { ModelPreferences } from "@corral/protocol/models";

/**
 * The editor's one saved-state owner. A revision is an opaque content hash, not an ordering, so
 * "different revision" never means "newer". After a save acknowledgement, a watch snapshot of the
 * revision that save was based on is known to predate it and is ignored; so is every revision an
 * earlier acknowledgement superseded. Once the watch shows that save (or another change), it has
 * caught up and later snapshots are adopted again, including a genuine external undo.
 */
export interface SavedPreferences {
  readonly current: ModelPreferences;
  /** Every revision an acknowledgement superseded; invisible to the watch until it catches up. */
  readonly superseded: ReadonlySet<number>;
  /** True from an acknowledgement until the watch shows that save or a later change. */
  readonly catchingUp: boolean;
}

export function initialSavedPreferences(current: ModelPreferences): SavedPreferences {
  return { current, superseded: new Set(), catchingUp: false };
}

/** Records a save acknowledgement as the saved state; its base revision is now older by cause. */
export function acknowledgeSavedPreferences(
  state: SavedPreferences,
  saved: ModelPreferences,
): SavedPreferences {
  if (saved.revision === state.current.revision)
    return { current: saved, superseded: state.superseded, catchingUp: false };
  return {
    current: saved,
    superseded: new Set([...state.superseded, state.current.revision]),
    catchingUp: true,
  };
}

/**
 * Adopts a watch snapshot unless it is the state the last acknowledgement already replaced. The
 * return value is `state` itself when nothing changed, so callers can compare identity.
 */
export function adoptWatchedPreferences(
  state: SavedPreferences,
  watched: ModelPreferences,
): SavedPreferences {
  if (watched.revision === state.current.revision)
    return state.catchingUp ? { ...state, current: watched, catchingUp: false } : state;
  if (state.catchingUp && state.superseded.has(watched.revision)) return state;
  return {
    current: watched,
    superseded: new Set([...state.superseded, state.current.revision]),
    catchingUp: false,
  };
}

/** Whether a watched revision is a snapshot the last acknowledgement already replaced. */
export function watchedRevisionIsOld(state: SavedPreferences, revision: number): boolean {
  return state.catchingUp && revision !== state.current.revision && state.superseded.has(revision);
}
