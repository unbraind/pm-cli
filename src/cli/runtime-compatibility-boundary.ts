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
import { parseBootstrapGlobalOptions } from "../sdk/cli-bootstrap.js";

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

/** Apply SDK compatibility/output policy, emitting structured read warnings only after successful dispatch. */
export async function runRuntimeCompatibleCli(
  options: RuntimeCompatibleCliOptions,
): Promise<void> {
  const jsonOutput = parseBootstrapGlobalOptions([...options.argv]).json;
  let pendingJsonWarning: string | undefined;
  try {
    if (options.executingVersion !== undefined) {
      const compatibility = assertProjectRuntimeCompatibility({
        executingVersion: options.executingVersion,
        projectRoot: options.projectRoot,
        argv: options.argv,
        allowStale: options.allowStale,
      });
      if (compatibility.warning !== undefined) {
        if (jsonOutput) {
          pendingJsonWarning = `${JSON.stringify({ type: "warning", ...compatibility.warning })}\n`;
        } else {
          options.writeError(
            `[pm] warning: ${compatibility.warning.code} — ${compatibility.warning.message} Running ${compatibility.warning.executing_version}; project pin ${compatibility.warning.project_version} (${compatibility.warning.source}). ${compatibility.warning.next_steps[0]}\n`,
          );
        }
      }
    }
    await options.run();
    if (pendingJsonWarning !== undefined && Number(process.exitCode ?? 0) === 0) {
      options.writeError(pendingJsonWarning);
    }
  } catch (error) {
    if (!(error instanceof PmCliError)) throw error;
    options.writeError(
      `${
        jsonOutput
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
