/**
 * @module sdk/environment/tracker-preflight
 *
 * Exposes tracker initialization and filesystem preflight primitives to SDK consumers.
 */
export {
  assertInitializedTracker,
  assertReadableTrackerRoot,
  buildTrackerInitializationRecovery,
} from "../../core/store/tracker-preflight.js";
