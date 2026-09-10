/** @module core/history/digest
 * Named digest primitives for immutable history; absent labels always mean SHA-256.
 */
import { createHash } from "node:crypto";

/** Digest algorithms supported for item anchors and immutable record envelopes. */
export const HISTORY_HASH_ALGORITHMS = ["sha256", "sha512"] as const;
/** Explicit algorithm accepted by history writers. */
export type HistoryHashAlgorithm = (typeof HISTORY_HASH_ALGORITHMS)[number];
/** Historical default, fixed permanently so unlabeled records remain readable. */
export const LEGACY_HISTORY_HASH_ALGORITHM = "sha256" as const;
/** Algorithm written on new records unless a caller explicitly selects another. */
export const CURRENT_HISTORY_HASH_ALGORITHM = "sha256" as const;

/** Validate a persisted algorithm before passing it to the crypto provider. */
export function resolveHistoryHashAlgorithm(value?: string): HistoryHashAlgorithm {
  if (value === undefined) return LEGACY_HISTORY_HASH_ALGORITHM;
  if (value === "sha256" || value === "sha512") return value;
  throw new TypeError(`unsupported_history_hash_algorithm:${String(value)}`);
}

/** Hash canonical UTF-8 bytes using the declared algorithm, rejecting unknown labels. */
export function historyDigest(value: string, algorithm?: string): string {
  return createHash(resolveHistoryHashAlgorithm(algorithm)).update(value, "utf8").digest("hex");
}
