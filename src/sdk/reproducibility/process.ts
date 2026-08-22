/**
 * @module sdk/reproducible-process
 *
 * Owns the process-environment contract that lets CLI and MCP transports enter
 * the same deterministic execution context as SDK workspace recipes.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  createReproducibleExecutionRunner,
  validateReproducibleExecutionSettings,
  type ReproducibleExecutionSettings,
  type ReproducibleExecutionRunner,
} from "../../core/reproducibility/context.js";

/** Stable environment-variable names understood by every pm process transport. */
export const PM_REPRODUCIBLE_PROCESS_ENV = Object.freeze({
  clock: "PM_CLOCK",
  tickMs: "PM_CLOCK_TICK_MS",
  seed: "PM_SEED",
} as const);

/** Environment-shaped input accepted by the reproducible process adapter. */
export type ReproducibleProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Public deterministic settings installed by recipes and process transports. */
export type { ReproducibleExecutionSettings };

/** Runner used by long-lived transports whose serial operations share one sequence. */
export type ReproducibleProcessRunner = ReproducibleExecutionRunner;

function invalidProcessEnvironment(
  message: string,
  reason: "incomplete" | "invalid_value",
  field: string,
  providedFields: string[],
): PmCliError {
  return new PmCliError(message, EXIT_CODE.USAGE, {
    code: "invalid_reproducible_process_environment",
    reason,
    field,
    required: `${PM_REPRODUCIBLE_PROCESS_ENV.clock} and ${PM_REPRODUCIBLE_PROCESS_ENV.seed}; ${PM_REPRODUCIBLE_PROCESS_ENV.tickMs} is optional`,
    nextSteps: [
      `Set ${PM_REPRODUCIBLE_PROCESS_ENV.clock} to an ISO-8601 instant and ${PM_REPRODUCIBLE_PROCESS_ENV.seed} to a non-empty reproducibility seed.`,
      `Optionally set ${PM_REPRODUCIBLE_PROCESS_ENV.tickMs} to a non-negative integer; it defaults to 1.`,
      `Unset all three variables to retain normal wall-clock and cryptographic-random behavior.`,
    ],
    recovery: {
      recovery_mode: "compact",
      provided_fields: providedFields,
      missing_required_fields:
        reason === "incomplete"
          ? [PM_REPRODUCIBLE_PROCESS_ENV.clock, PM_REPRODUCIBLE_PROCESS_ENV.seed].filter(
              (name) => !providedFields.includes(name),
            )
          : undefined,
    },
  });
}

/** Resolve validated deterministic settings, or undefined when no opt-in is present. */
export function resolveReproducibleProcessEnvironment(
  environment: ReproducibleProcessEnvironment,
): ReproducibleExecutionSettings | undefined {
  const clock = environment[PM_REPRODUCIBLE_PROCESS_ENV.clock];
  const tick = environment[PM_REPRODUCIBLE_PROCESS_ENV.tickMs];
  const seed = environment[PM_REPRODUCIBLE_PROCESS_ENV.seed];
  const providedFields = [
    [PM_REPRODUCIBLE_PROCESS_ENV.clock, clock],
    [PM_REPRODUCIBLE_PROCESS_ENV.tickMs, tick],
    [PM_REPRODUCIBLE_PROCESS_ENV.seed, seed],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name]) => name);
  if (providedFields.length === 0) {
    return undefined;
  }
  if (clock === undefined || seed === undefined) {
    throw invalidProcessEnvironment(
      "Reproducible process execution requires PM_CLOCK and PM_SEED together.",
      "incomplete",
      clock === undefined
        ? PM_REPRODUCIBLE_PROCESS_ENV.clock
        : PM_REPRODUCIBLE_PROCESS_ENV.seed,
      providedFields,
    );
  }
  if (seed.trim().length === 0) {
    throw invalidProcessEnvironment(
      `${PM_REPRODUCIBLE_PROCESS_ENV.seed} must not be empty.`,
      "invalid_value",
      PM_REPRODUCIBLE_PROCESS_ENV.seed,
      providedFields,
    );
  }
  if (!Number.isFinite(Date.parse(clock))) {
    throw invalidProcessEnvironment(
      `${PM_REPRODUCIBLE_PROCESS_ENV.clock} must be a valid ISO-8601 instant.`,
      "invalid_value",
      PM_REPRODUCIBLE_PROCESS_ENV.clock,
      providedFields,
    );
  }
  const tickMs = tick === undefined ? 1 : Number(tick);
  if (tick?.trim().length === 0 || !Number.isSafeInteger(tickMs) || tickMs < 0) {
    throw invalidProcessEnvironment(
      `${PM_REPRODUCIBLE_PROCESS_ENV.tickMs} must be a non-negative integer.`,
      "invalid_value",
      PM_REPRODUCIBLE_PROCESS_ENV.tickMs,
      providedFields,
    );
  }
  return validateReproducibleExecutionSettings({ clock, seed, tickMs });
}

/** Create one process-lifetime runner for long-lived serial transports such as MCP. */
export function createReproducibleProcessRunner(
  environment: ReproducibleProcessEnvironment,
): ReproducibleProcessRunner {
  const settings = resolveReproducibleProcessEnvironment(environment);
  return settings === undefined
    ? <T>(operation: () => Promise<T>): Promise<T> => operation()
    : createReproducibleExecutionRunner(settings);
}

/** Run one process transport operation under its declared deterministic context. */
export async function runWithReproducibleProcessEnvironment<T>(
  environment: ReproducibleProcessEnvironment,
  operation: () => Promise<T>,
): Promise<T> {
  return createReproducibleProcessRunner(environment)(operation);
}
