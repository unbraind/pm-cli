/**
 * @module sdk/graph
 *
 * Provides relationship modeling, traversal, analytics, and remediation APIs.
 */
export * from "./graph/index.js";
export * from "./actionability.js";
export * from "./relationships.js";
export * from "./relationship-analytics.js";
export * from "./relationship-context.js";
export * from "./relationship-history.js";
export * from "./relationship-migration.js";

// Types named by this entrypoint's exported function signatures, so consumers can import them (pm-gh1667).
export type { ItemTypeRegistry } from "../core/item/type-registry.js";
export type { RuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
export type { GlobalOptions } from "../core/shared/command-types.js";
export type { Dependency, ItemMetadata, ItemStatus } from "../types.js";
export type { ProjectedGraphResult } from "./graph/run.js";
