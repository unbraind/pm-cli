// pm-3puw: a minimal FIFO async queue. Tasks enqueued onto a single instance run
// strictly one-at-a-time in arrival order — the next task does not start until
// the previous one has fully settled. The MCP stdio transport uses this to
// process JSON-RPC lines in arrival order, so a client that pipelines two
// mutations on the same item (without awaiting the first response) no longer
// races into a lock conflict on the second.

export interface SerialQueue {
  /**
   * Schedule `task` to run after every previously-enqueued task has settled.
   * Returns a promise for this task's result (or rejection) so callers can
   * await individual outcomes. A rejected task never wedges the queue: later
   * tasks still run in order.
   */
  enqueue<T>(task: () => Promise<T> | T): Promise<T>;
  /** Resolves once the queue has fully drained (no pending tasks remain). */
  idle(): Promise<void>;
}

export function createSerialQueue(): SerialQueue {
  // `tail` is the error-isolated chain the next task waits on; it is kept
  // separate from the per-task promise returned to callers so one rejection
  // does not break the chain or surface as an unhandled rejection.
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => task());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    idle(): Promise<void> {
      return tail;
    },
  };
}
