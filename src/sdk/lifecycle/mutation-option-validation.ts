/** @module sdk/lifecycle/mutation-option-validation Shared value checks before batch planning or journal work. */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/** Reject malformed raw duration options before either parsed or direct SDK batches can write. */
export function assertMutationOptionValueTypes(
  options: Readonly<Record<string, unknown>> | undefined,
  op: string,
  index: number,
): void {
  const value = options?.estimatedMinutes;
  if (value === undefined || typeof value === "string") return;
  throw new PmCliError(
    `Mutation ${index + 1} ${op} option "estimatedMinutes" must be a string.`,
    EXIT_CODE.USAGE,
    {
      code: "mutation_option_value_invalid",
      required: 'Pass estimatedMinutes as a string, for example "45", in raw mutation options.',
      why: "Raw options use the create/update command option types; item documents accept numeric estimated_minutes instead.",
      nextSteps: ['Quote the estimatedMinutes value or use an item document with numeric estimated_minutes, then retry the transaction.'],
    },
  );
}
