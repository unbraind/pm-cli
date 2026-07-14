/**
 * @module sdk/output
 *
 * Defines public output-control primitives for extension commands, exporters,
 * renderers, and custom SDK-built hosts.
 */

export {
  SUPPRESS_HOST_OUTPUT_MARKER,
  isHostOutputSuppressed,
  suppressHostOutput,
  type SuppressedHostOutput,
} from "../core/output/output-control.js";
