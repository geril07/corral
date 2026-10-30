/** The read side of a store: what `useSyncExternalStore` takes, so any UI can follow it. */
export interface ReadableStore<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
}

export class Store<T> implements ReadableStore<T> {
  readonly #listeners = new Set<() => void>();
  #value: T;

  constructor(initial: T) {
    this.#value = initial;
  }

  // Arrow properties, so a store can be handed to `useSyncExternalStore` without binding.
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): T => this.#value;

  set(value: T): void {
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }
}
