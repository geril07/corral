/** Runs jobs one at a time, in the order they were queued; a failing job does not stop the queue. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(job);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
