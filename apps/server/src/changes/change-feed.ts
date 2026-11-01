/** Tells watchers that something changed; each watcher gets the current value of whatever it watches. */
export class ChangeFeed {
  readonly #listeners = new Set<() => void>();

  notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /**
   * Yields `read()` now and after every change; changes between two yields collapse into one. The
   * read may be asynchronous: the next change waits for it, so a burst of notifications costs one
   * recomputation, not one per notification.
   */
  async *watch<T>(read: () => T | Promise<T>, signal: AbortSignal | undefined): AsyncGenerator<T> {
    let changed = true;
    let wake: (() => void) | undefined;
    const listener = () => {
      changed = true;
      wake?.();
    };
    this.#listeners.add(listener);
    const aborted = () => wake?.();
    signal?.addEventListener("abort", aborted);
    try {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `aborted` flips from the abort listener
      while (!signal?.aborted) {
        if (changed) {
          changed = false;
          // oxlint-disable-next-line no-await-in-loop -- one read per change is the point
          yield await read();
        } else {
          // oxlint-disable-next-line no-await-in-loop -- one wait per change is the point
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      }
    } finally {
      this.#listeners.delete(listener);
      signal?.removeEventListener("abort", aborted);
    }
  }
}
