/**
 * @module sdk/assurance-mutation-error
 *
 * Distinguishes expected assurance mutation refusals from unexpected runtime
 * faults before transport layers normalize them into stable usage errors.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/** Expected declaration-validation or mutation-policy refusal. */
export class AssuranceMutationRefusalError extends TypeError {
  /** Create one typed refusal while retaining TypeError compatibility for SDK callers. */
  constructor(message: string) {
    super(message);
    this.name = "AssuranceMutationRefusalError";
  }
}

/** Normalize only expected assurance mutation refusals for CLI and MCP hosts. */
export async function normalizeAssuranceMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof AssuranceMutationRefusalError) {
      throw new PmCliError(error.message, EXIT_CODE.USAGE, {
        code: "invalid_argument_value",
        reason: "assurance_mutation_refused",
      });
    }
    throw error;
  }
}
