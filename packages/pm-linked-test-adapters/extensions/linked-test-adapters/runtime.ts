/**
 * Runtime contracts and behavior for packages/pm linked test adapters/extensions/linked test adapters/runtime.
 *
 * @module packages/pm-linked-test-adapters/extensions/linked-test-adapters/runtime
 */
import {
  EXIT_CODE,
  PmCliError,
  readBooleanOption,
  readStringOption,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  type GlobalOptions,
} from "@unbrained/pm-cli/sdk";

function requireRunId(
  commandName: string,
  args: string[],
): string {
  const runId = args[0];
  if (typeof runId === "string" && runId.trim().length > 0) {
    return runId.trim();
  }
  throw new PmCliError(
    `${commandName} requires a runId argument.`,
    EXIT_CODE.USAGE,
  );
}

/** Executes the test runs list package operation through the package runtime. */
export async function runTestRunsListPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  return runTestRunsList(
    {
      status: readStringOption(options, "status"),
      limit: readStringOption(options, "limit"),
    },
    global,
  );
}

/** Executes the test runs status package operation through the package runtime. */
export async function runTestRunsStatusPackage(
  args: string[],
  global: GlobalOptions,
): Promise<unknown> {
  return runTestRunsStatus(
    requireRunId("test-runs status", args),
    global,
  );
}

/** Executes the test runs logs package operation through the package runtime. */
export async function runTestRunsLogsPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  return runTestRunsLogs(
    requireRunId("test-runs logs", args),
    {
      stream: readStringOption(options, "stream"),
      tail: readStringOption(options, "tail"),
    },
    global,
  );
}

/** Executes the test runs stop package operation through the package runtime. */
export async function runTestRunsStopPackage(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  return runTestRunsStop(
    requireRunId("test-runs stop", args),
    {
      force: readBooleanOption(options, "force") === true,
    },
    global,
  );
}

/** Executes the test runs resume package operation through the package runtime. */
export async function runTestRunsResumePackage(
  args: string[],
  global: GlobalOptions,
): Promise<unknown> {
  return runTestRunsResume(
    requireRunId("test-runs resume", args),
    {
      author: global.author,
      noExtensions: global.noExtensions === true,
    },
    global,
  );
}
