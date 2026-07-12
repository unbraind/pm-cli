/**
 * @module core/item/item-record
 *
 * Defines item parsing, formatting, and lifecycle helpers for Item Record.
 */
import type { ItemMetadata } from "../../types/index.js";

/**
 * Bridge a typed item record into the generic `Record<string, unknown>` shape
 * consumed by formatters, field projections, history canonicalization, and
 * JSON output paths.
 *
 * `ItemMetadata` carries an index signature, but the structural mismatch on its
 * concretely-typed fields means TypeScript still requires a double cast to widen
 * it. Centralizing that `as unknown as Record<string, unknown>` widening here
 * gives the type bridge a single, named, documented home instead of scattering
 * the cast across command and core modules.
 *
 * This is a compile-time-only widening: the returned value is the very same
 * object reference, with no runtime transformation. (It is intentionally
 * distinct from the runtime `asRecord*` guards in `core/shared/primitives.ts`,
 * which validate `typeof` at runtime.) `ItemMetadata` is an alias of
 * `ItemMetadata`, so item-metadata values are accepted as-is.
 */
export function toItemRecord(item: ItemMetadata): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}
