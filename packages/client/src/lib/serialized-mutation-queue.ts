export type SerializedMutationQueue = {
  enqueue: (mutation: () => Promise<void>) => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createSerializedMutationQueue(): SerializedMutationQueue {
  let tail = Promise.resolve();
  return {
    enqueue(mutation) {
      const current = tail.then(mutation, mutation);
      tail = current.catch(() => undefined);
      return current;
    },
    waitForIdle() {
      return tail;
    },
  };
}
