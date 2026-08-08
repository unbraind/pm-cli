/**
 * @module cli/runtime-compatibility-boundary
 *
 * Applies the SDK-owned stale-runtime mutation policy before CLI dispatch and
 * preserves the normal structured error presentation contract.
 */
import {
  formatPmCliErrorForDisplay,
  formatPmCliErrorForJson,
} from "./error-guidance.js";
import {
  assertProjectRuntimeCompatibility,
  PmCliError,
} from "../sdk/environment/project-runtime-compatibility.js";

/** Options for one early CLI compatibility check and deferred dispatch. */
export interface RuntimeCompatibleCliOptions {
  /** Version of the executable package, when its manifest was readable. */
  executingVersion?: string;
  /** Project root whose local package and lock metadata governs mutation. */
  projectRoot: string;
  /** CLI invocation arguments after the executable path. */
  argv: readonly string[];
  /** Explicit recovery override for one invocation. */
  allowStale: boolean;
  /** Deferred CLI bundle dispatch, called only after compatibility succeeds. */
  run: () => Promise<void>;
  /** Error sink used by the executable transport. */
  writeError: (message: string) => void;
}

/** Run CLI dispatch after the SDK compatibility guard and handle declared refusal exits. */
export async function runRuntimeCompatibleCli(
  options: RuntimeCompatibleCliOptions,
): Promise<void> {
  try {
    if (options.executingVersion !== undefined) {
      assertProjectRuntimeCompatibility({
        executingVersion: options.executingVersion,
        projectRoot: options.projectRoot,
        argv: options.argv,
        allowStale: options.allowStale,
      });
    }
    await options.run();
  } catch (error) {
    if (!(error instanceof PmCliError)) throw error;
    const outputFormatIndex = options.argv.indexOf("--output-format");
    const jsonErrors =
      options.argv.includes("--json") ||
      options.argv.includes("--output-format=json") ||
      (outputFormatIndex >= 0 &&
        options.argv[outputFormatIndex + 1] === "json");
    options.writeError(
      `${
        jsonErrors
          ? JSON.stringify(
              formatPmCliErrorForJson(
                error.message,
                error.exitCode,
                error.context,
              ),
              null,
              2,
            )
          : formatPmCliErrorForDisplay(error.message, error.context)
      }\n`,
    );
    process.exitCode = error.exitCode;
  }
}
