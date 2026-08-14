/**
 * @module sdk/assurance-mutation-error
 *
 * Distinguishes expected assurance mutation refusals from unexpected runtime
 * faults before transport layers normalize them into stable usage errors.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/** Machine-readable location of a refused assurance evaluation. */
export interface AssuranceEvaluationRefusalContext {
  /** Gate being evaluated. */
  gate_id?: string;
  /** Assertion whose measurement failed. */
  assertion_id?: string;
  /** Measurement whose source failed. */
  measurement_id?: string;
  /** Measurement source discriminant. */
  source_kind?: string;
  /** Field selected from a graph, validate, or health result. */
  field?: string;
  /** Validate or health check selected by the source. */
  check?: string;
}

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
  /** Structured evaluation location retained across CLI, SDK, and MCP. */
  public readonly context: AssuranceEvaluationRefusalContext;

  /** Create one typed refusal while retaining TypeError compatibility for SDK callers. */
  constructor(
    message: string,
    context: AssuranceEvaluationRefusalContext = {},
  ) {
    super(message);
    this.name = "AssuranceEvaluationRefusalError";
    this.context = context;
  }
}

/** Expected failure to resolve one declared external measurement source. */
export class AssuranceSourceResolutionError extends TypeError {
  /** Measurement that owns the failed source, once evaluation identifies it. */
  public readonly measurement_id?: string;
  /** Measurement source discriminant. */
  public readonly source_kind: string;
  /** Field selected from the source result. */
  public readonly field: string;
  /** Optional validate or health check selector. */
  public readonly check?: string;

  /** Create one source-local refusal before gate context is attached. */
  constructor(
    message: string,
    context: {
      measurement_id?: string;
      source_kind: string;
      field: string;
      check?: string;
    },
  ) {
    super(message);
    this.name = "AssuranceSourceResolutionError";
    this.measurement_id = context.measurement_id;
    this.source_kind = context.source_kind;
    this.field = context.field;
    this.check = context.check;
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
        ...error.context,
      });
    }
    throw error;
  }
}
