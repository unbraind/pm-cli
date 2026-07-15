/**
 * @module sdk/extension/concurrency
 *
 * Provides resource-bounded asynchronous collection transforms for extension workflows.
 */

/** Map inputs with a fixed worker pool so remote checks cannot exhaust process resources. */
export const mapWithFixedConcurrency = async <Input, Output>(
  inputs: Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(inputs[index] as Input);
      }
    },
  );
  await Promise.all(workers);
  return results;
};
