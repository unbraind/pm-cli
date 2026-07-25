/**
 * @module cli/extension-recovery
 *
 * Recovers bounded extension activation failures for parse-time diagnostics.
 */
import path from "node:path";
import {
  activateExtensions,
  loadExtensions,
  readSettings,
  resolveImplicitPmRoot,
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
  /** Resolves the ordinary cwd tracker independently from an explicit CLI path. */
  resolveImplicitPmRoot: typeof resolveImplicitPmRoot;
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
    resolveImplicitPmRoot,
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
  if (classificationCode !== "unknown_command") return [];
  const failures = await loadExtensionRecoveryFailures(pmRoot, overrides);
  const dependencies: ExtensionRecoveryDependencies = {
    readSettings,
    loadExtensions,
    activateExtensions,
    resolveImplicitPmRoot,
    ...overrides,
  };
  try {
    const workspacePmRoot = dependencies.resolveImplicitPmRoot(process.cwd());
    if (path.resolve(workspacePmRoot) === path.resolve(pmRoot)) return failures;
    const [selectedSettings, workspaceSettings] = await Promise.all([
      dependencies.readSettings(pmRoot),
      dependencies.readSettings(workspacePmRoot),
    ]);
    const [selected, workspace] = await Promise.all([
      dependencies.loadExtensions({
        pmRoot,
        settings: selectedSettings,
        cwd: process.cwd(),
        noExtensions: false,
      }),
      dependencies.loadExtensions({
        pmRoot: workspacePmRoot,
        settings: workspaceSettings,
        cwd: process.cwd(),
        noExtensions: false,
      }),
    ]);
    const selectedCommands = new Set(
      selected.loaded.flatMap((entry) => entry.activation?.commands ?? []),
    );
    const missingCommands = [
      ...new Set(
        workspace.loaded.flatMap((entry) => entry.activation?.commands ?? []),
      ),
    ]
      .filter((command) => !selectedCommands.has(command))
      .sort((left, right) => left.localeCompare(right));
    if (missingCommands.length === 0) return failures;
    failures.push({
      layer: "runtime",
      name: "extension-root-relocation",
      error:
        `storage_root=${path.resolve(pmRoot)} extension_discovery_root=${selected.roots.project}; ` +
        `cwd_storage_root=${path.resolve(workspacePmRoot)} cwd_extension_discovery_root=${workspace.roots.project}; ` +
        `the selected --pm-path runtime is missing ${missingCommands.length} workspace command path(s): ${missingCommands.slice(0, 8).join(", ")}${missingCommands.length > 8 ? ", ..." : ""}. ` +
        `--pm-path selects extension discovery as well as item storage; omit it, point --pm-path at ${path.resolve(workspacePmRoot)}, or install the extension into the selected tracker with "pm --pm-path ${path.resolve(pmRoot)} install <package> --project".`,
    });
  } catch {
    // The ordinary extension failures remain useful when comparison is unavailable.
  }
  return failures;
}
