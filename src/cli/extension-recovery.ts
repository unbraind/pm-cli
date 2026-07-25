/**
 * @module cli/extension-recovery
 *
 * Recovers bounded extension activation failures for parse-time diagnostics.
 */
import {
  activateExtensions,
  loadExtensions,
  readSettings,
} from "../sdk/runtime-primitives.js";

/** Extension failure safe to append to unknown-command output. */
export interface ExtensionRecoveryFailure {
  /** Extension resolution layer that failed. */
  layer: string;
  /** Installed extension identity. */
  name: string;
  /** Actionable loader or activation error. */
  error: string;
}

/** Injectable recovery dependencies used to exercise loader failure boundaries. */
export interface ExtensionRecoveryDependencies {
  /** Reads active tracker settings. */
  readSettings: typeof readSettings;
  /** Loads installed extension modules. */
  loadExtensions: typeof loadExtensions;
  /** Activates loaded extension modules. */
  activateExtensions: typeof activateExtensions;
}

/** Reload extensions and return bounded load plus activation failures. */
export async function loadExtensionRecoveryFailures(
  pmRoot: string,
  overrides: Partial<ExtensionRecoveryDependencies> = {},
): Promise<ExtensionRecoveryFailure[]> {
  const dependencies: ExtensionRecoveryDependencies = {
    readSettings,
    loadExtensions,
    activateExtensions,
    ...overrides,
  };
  try {
    const settings = await dependencies.readSettings(pmRoot);
    const loaded = await dependencies.loadExtensions({
      pmRoot,
      settings,
      cwd: process.cwd(),
      noExtensions: false,
    });
    const activated = await dependencies.activateExtensions(loaded);
    return [...loaded.failed, ...activated.failed].map((entry) => ({
      layer: entry.layer,
      name: entry.name,
      error: entry.error,
    }));
  } catch (error: unknown) {
    return [
      {
        layer: "runtime",
        name: "extension-loader",
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

/** Loads recovery details only for unknown-command failures. */
export async function loadUnknownCommandRecoveryFailures(
  classificationCode: string,
  pmRoot: string,
  overrides: Partial<ExtensionRecoveryDependencies> = {},
): Promise<ExtensionRecoveryFailure[]> {
  return classificationCode === "unknown_command"
    ? loadExtensionRecoveryFailures(pmRoot, overrides)
    : [];
}
