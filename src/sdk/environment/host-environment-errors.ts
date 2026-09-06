/**
 * @module sdk/host-environment-errors
 * Public SDK compatibility surface for path-redacted host filesystem refusals.
 */
export {
  classifyHostEnvironmentFault,
  translateHostEnvironmentFault,
  withHostEnvironmentBoundary,
  type HostEnvironmentBoundaryOptions,
  type HostEnvironmentFaultCodeOverrides,
} from "../../core/fs/host-environment-errors.js";
