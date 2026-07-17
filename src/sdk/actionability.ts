/**
 * @module sdk/actionability
 *
 * Public dependency-aware scheduling primitives shared by CLI adapters,
 * embedded tools, and automation. The implementation remains pure: callers
 * provide item metadata plus the runtime status registry and receive stable
 * blocker or ready-work classifications without storage or rendering side
 * effects.
 */
export {
  collectBlockedByIds,
  collectDependencyBlockedIds,
  computeActionabilityReport,
  resolveItemBlockers,
  type ActionabilityReport,
  type ActionableEntry,
  type ResolvedBlocker,
} from "../core/item/actionability.js";
