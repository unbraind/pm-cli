/**
 * @module sdk/test/prerequisites
 *
 * Validates measurement execution before foreground or background dispatch.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { renderPmCommand } from "../command-line.js";
import { buildBackgroundTestCommandArgs } from "./command-args.js";
import type { TestCommandOptions, TestRunResult } from "./execution.js";
import { detectEmptyLinkedTestRun } from "./execution-receipts.js";

/** Admit measurements only after real command execution, excluding preflight, spawn and recognised empty-run failures. */
export function assertTestMeasurementExecution(
  id: string,
  options: TestCommandOptions,
  global: GlobalOptions,
  pmRoot: string,
  results: TestRunResult[],
): void {
  if (
    (options.measure?.length ?? 0) === 0 ||
    results.some(
      (result) =>
        typeof result.stdout === "string" &&
        result.failure_category !== "spawn_error" &&
        result.failure_category !== "empty_run" &&
        detectEmptyLinkedTestRun(result.stdout, result.stderr ?? "") === null,
    )
  )
    return;
  const retryArgs = [
    "--pm-path",
    pmRoot,
    ...(global.noExtensions ? ["--no-extensions"] : []),
    ...(global.author ? ["--author", global.author] : []),
    "test",
    id,
    "--list",
    "--json",
  ];
  throw new PmCliError(
    "--measure requires an executed linked test",
    EXIT_CODE.USAGE,
    {
      code: "test_measure_requires_execution",
      required:
        "Execute at least one linked command before recording measurement evidence.",
      why: "Empty, skipped and pre-execution refused runs cannot support measured evidence.",
      nextSteps: [
        "Inspect the linked commands, adjust empty selections or missing commands, and resolve any trust refusal before retrying the measurement.",
      ],
      recovery: {
        suggested_retry: renderPmCommand(retryArgs),
        suggested_retry_args: retryArgs,
      },
    },
  );
}

/** Refuse non-executing measurements without changing selectors, tracker scope or explicit trust policy. */
export function assertTestMeasurementRun(
  id: string,
  options: TestCommandOptions,
  global: GlobalOptions,
  pmRoot: string,
  background = false,
): void {
  if ((options.measure?.length ?? 0) === 0 || options.run === true) return;
  const scopeArgs = [
    "--pm-path",
    pmRoot,
    ...(global.noExtensions ? ["--no-extensions"] : []),
    ...(global.author ? ["--author", global.author] : []),
  ];
  const measurementArgs = [
    ...scopeArgs,
    ...buildBackgroundTestCommandArgs(id, options as Record<string, unknown>),
    ...(options.list ? ["--list"] : []),
    ...(background ? ["--background"] : []),
  ];
  const retryArgs = options.acknowledgeLinkedTests
    ? [...scopeArgs, "test", id, "--help"]
    : measurementArgs;
  const acknowledgementArgs = [
    ...scopeArgs,
    "test",
    id,
    "--acknowledge-linked-tests",
    ...(options.author ? ["--author", options.author] : []),
  ];
  throw new PmCliError("--measure requires --run", EXIT_CODE.USAGE, {
    code: "test_measure_requires_run",
    flag: "--measure",
    required: "Run the linked tests with --run to record measurement evidence.",
    why: "Measurements describe an executed linked-test run; recording them without execution would fabricate evidence.",
    ...(options.acknowledgeLinkedTests
      ? {
          nextSteps: [
            `Review the linked commands and apply any requested link updates separately before acknowledging trust: ${renderPmCommand([...scopeArgs, "test", id, "--list"])}`,
            `After review, acknowledge trust as a separate non-executing operation: ${renderPmCommand(acknowledgementArgs)}`,
            `Then run the measurement without --acknowledge-linked-tests: ${renderPmCommand(measurementArgs)}`,
          ],
        }
      : {}),
    recovery: {
      missing: ["--run"],
      suggested_retry: renderPmCommand(retryArgs),
      suggested_retry_args: retryArgs,
    },
  });
}
