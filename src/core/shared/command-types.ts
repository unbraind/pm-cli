/**
 * @module core/shared/command-types
 *
 * Provides shared primitives and utilities for Command Types.
 */
/**
 * Carries process-wide CLI options shared by command handlers and runtime adapters.
 */
export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  noChangedFields?: boolean;
  idOnly?: boolean;
  path?: string;
  noExtensions?: boolean;
  noPager?: boolean;
  profile?: boolean;
  defaultOutputFormat?: "toon" | "json";
}
