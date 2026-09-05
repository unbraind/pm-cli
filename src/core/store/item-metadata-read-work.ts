/**
 * @module core/store/item-metadata-read-work
 *
 * Measures successful filesystem metadata enumerations within one async SDK
 * operation. Cache hits count too: materializing a cached corpus is still work.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

/** Logical metadata work, independent of output projection and cache hit rate. */
export interface ItemMetadataReadWork {
  /** Completed full, light, or body-bearing item-store enumeration calls. */
  enumeration_calls: number;
  /** Metadata rows returned by those calls, counting repeated enumeration. */
  metadata_rows: number;
}

const observers = new AsyncLocalStorage<readonly ItemMetadataReadWork[]>();

const enumerations = channel<number>("@unbrained/pm-cli/item-metadata-enumeration/v1");
/** Record completed enumeration in each enclosing measurement, without retaining item data. */
export function recordItemMetadataEnumeration(rowCount: number): void {
  enumerations.publish(rowCount);
}

/**
 * Measure an awaited operation without changing its result or failure semantics.
 * Concurrent roots remain isolated; nested measurements also contribute to their
 * parents. The returned snapshot excludes work completed after the operation.
 * Counters cover filesystem item-store enumeration APIs, not arbitrary host I/O.
 */
export async function measureItemMetadataReadWork<T>(
  operation: () => T | Promise<T>,
): Promise<{ result: T; work: Readonly<ItemMetadataReadWork> }> {
  const work: ItemMetadataReadWork = { enumeration_calls: 0, metadata_rows: 0 };
  // A named channel crosses the published query/bundled runtime boundary;
  // async membership prevents concurrent roots from counting each other's work.
  /** Count notifications only while this measurement belongs to the active async scope. */
  const observe = (message: unknown): void => {
    if (observers.getStore()?.includes(work)) {
      work.enumeration_calls += 1;
      work.metadata_rows += message as number;
    }
  };
  enumerations.subscribe(observe);
  try {
    const result = await observers.run([...(observers.getStore() ?? []), work], operation);
    return { result, work: { ...work } };
  } finally {
    enumerations.unsubscribe(observe);
  }
}
