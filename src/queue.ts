export class KeyedQueue {
  readonly #queues = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, tail);

    const cleanup = () => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    };
    void tail.then(cleanup);
    return result;
  }
}
