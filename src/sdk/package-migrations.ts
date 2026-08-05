/**
 * @module sdk/package-migrations
 *
 * Provides one-shot SDK helpers for extension and package migration lifecycle.
 */
import {
  PmClient,
  type ExtensionCommandOptions,
  type ExtensionCommandResult,
  type PackageCommandOptions,
  type PackageCommandResult,
  type PmClientOptions,
} from "./runtime.js";

/** Plan or apply active extension migrations without constructing a reusable client. */
export function extensionMigrate(
  options: ExtensionCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<ExtensionCommandResult> {
  return new PmClient(clientOptions).extension(undefined, {
    ...options,
    migrate: true,
  });
}

/** Plan or apply active package migrations without constructing a reusable client. */
export function packageMigrate(
  options: PackageCommandOptions = {},
  clientOptions: PmClientOptions = {},
): Promise<PackageCommandResult> {
  return new PmClient(clientOptions).packageMigrate(options);
}
