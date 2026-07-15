/**
 * @module core/shared/command-types
 *
 * Provides shared primitives and utilities for Command Types.
 */
/** Carries process-wide CLI options shared by command handlers and runtime adapters. */
export interface GlobalOptions {
  /** Value that configures or reports json for this contract. */
  json?: boolean;
  /** Value that configures or reports quiet for this contract. */
  quiet?: boolean;
  /** Value that configures or reports no changed fields for this contract. */
  noChangedFields?: boolean;
  /** Value that configures or reports id only for this contract. */
  idOnly?: boolean;
  /** Filesystem path used for path resolution. */
  path?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
  /** Value that configures or reports no pager for this contract. */
  noPager?: boolean;
  /** Value that configures or reports profile for this contract. */
  profile?: boolean;
  /** Invocation-wide mutation author override. */
  author?: string;
  /** Fallback output format used when callers do not provide an override. */
  defaultOutputFormat?: "toon" | "json";
}
