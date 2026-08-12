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

/** Expected gate-policy refusal caused by an incomplete or disallowed provider contract. */
export class AssuranceEvaluationRefusalError extends TypeError {
  /** Create one typed refusal while retaining TypeError compatibility for SDK callers. */
  constructor(message: string) {
    super(message);
    this.name = "AssuranceEvaluationRefusalError";
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

/** Normalize only expected assurance evaluation-policy refusals for transport hosts. */
export async function normalizeAssuranceEvaluation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof AssuranceEvaluationRefusalError) {
      throw new PmCliError(error.message, EXIT_CODE.USAGE, {
        code: "invalid_argument_value",
        reason: "assurance_evaluation_refused",
      });
    }
    throw error;
  }
}
