export function createLazyModule<T>(importer: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= importer();
    return promise;
  };
}
