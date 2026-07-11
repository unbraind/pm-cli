/**
 * @module core/shared/lazy-module
 *
 * Provides shared primitives and utilities for Lazy Module.
 */
/** Creates a memoized async module loader for optional or expensive runtime dependencies. */
export function createLazyModule<T>(
  importer: () => Promise<T>,
): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= importer();
    return promise;
  };
}
