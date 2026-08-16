/**
 * @module cli/public
 *
 * Publishes the supported embeddable CLI entrypoint without exposing the
 * implementation module's repository-only test seams to package consumers.
 */
import { runPmCli as runInternalPmCli } from "./main.js";

/** Run one embedded CLI invocation without leaking its exit status into the host process. */
export async function runPmCli(rawArgv?: string[]): Promise<void> {
  const previousExitCode = process.exitCode;
  try {
    await runInternalPmCli(rawArgv);
  } finally {
    process.exitCode = previousExitCode;
  }
}
