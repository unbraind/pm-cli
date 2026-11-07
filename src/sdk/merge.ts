/**
 * @module sdk/merge
 *
 * Provides semantic tracker merge, reconciliation, and merge-fence APIs.
 */
export * from "./merge/index.js";
export * from "./merge/install.js";

// Types named by this entrypoint's exported function signatures, so consumers can import them (pm-gh1667).
export type { ItemDocumentFormatOptions } from "../core/item/item-format.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export type { PmSettings } from "../types.js";
