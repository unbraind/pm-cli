/**
 * @module core/shared/serial-queue
 *
 * Provides shared primitives and utilities for Serial Queue.
 */
// pm-3puw: a minimal FIFO async queue. Tasks enqueued onto a single instance run
// strictly one-at-a-time in arrival order — the next task does not start until
// the previous one has fully settled. The MCP stdio transport uses this to
// process JSON-RPC lines in arrival order, so a client that pipelines two
// mutations on the same item (without awaiting the first response) no longer
// races into a lock conflict on the second.

/** Defines the FIFO queue contract used to serialize asynchronous mutation-sensitive work. */
export interface SerialQueue {
  /** Schedule `task` to run after every previously-enqueued task has settled. Returns a promise for this task's result (or rejection) so callers can await individual outcomes. A rejected task never wedges the queue: later tasks still run in order. */
  enqueue<T>(task: () => Promise<T> | T): Promise<T>;
  /** Resolves once the queue has fully drained (no pending tasks remain). */
  idle(): Promise<void>;
}

/** Coordinates concurrent readers with FIFO-exclusive writers without serializing independent read work. */
export interface AsyncReadWriteGate {
  /** Run work concurrently after every writer scheduled before this call has settled. */
  read<T>(task: () => Promise<T> | T): Promise<T>;
  /** Run work exclusively after all readers and writers scheduled before this call have settled. */
  write<T>(task: () => Promise<T> | T): Promise<T>;
}

/** Create an arrival-ordered asynchronous read/write gate. Readers may overlap, while writers exclude both modes and never starve behind later readers. */
export function createAsyncReadWriteGate(): AsyncReadWriteGate {
  let writerBarrier: Promise<void> = Promise.resolve();
  const readers = new Set<Promise<void>>();
  return {
    async read<T>(task: () => Promise<T> | T): Promise<T> {
      const precedingWriters = writerBarrier;
      let finishReader!: () => void;
      const readerDone = new Promise<void>((resolve) => {
        finishReader = resolve;
      });
      readers.add(readerDone);
      await precedingWriters;
      try {
        return await task();
      } finally {
        readers.delete(readerDone);
        finishReader();
      }
    },
    write<T>(task: () => Promise<T> | T): Promise<T> {
      const precedingWork = Promise.all([writerBarrier, ...readers]);
      const run = precedingWork.then(() => task());
      writerBarrier = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** Implements create serial queue for the public runtime surface of this module. */
export function createSerialQueue(): SerialQueue {
  // `tail` is the error-isolated chain the next task waits on; it is kept
  // separate from the per-task promise returned to callers so one rejection
  // does not break the chain or surface as an unhandled rejection.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  const idleWaiters: Array<() => void> = [];
  const notifyIdle = () => {
    if (pending !== 0) {
      return;
    }
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  };
  return {
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
      pending++;
      const run = tail.then(() => task());
      tail = run
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          pending--;
          notifyIdle();
        });
      return run;
    },
    idle(): Promise<void> {
      return pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
