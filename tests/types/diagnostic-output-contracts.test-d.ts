/**
 * @module tests/types/diagnostic-output-contracts.test-d
 *
 * Compile-time proof for the public diagnostic budget contract and projectors.
 */
import {
  PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS,
  projectPmDiagnosticOutput,
  projectPmDiagnosticText,
  resolvePmDiagnosticOutputBudget,
  type PmDiagnosticOutputClass,
  type PmDiagnosticOutputReceipt,
} from "@unbrained/pm-cli/sdk/contracts";

const diagnosticClass: PmDiagnosticOutputClass = "error";
const contract = resolvePmDiagnosticOutputBudget(diagnosticClass);
const projected = projectPmDiagnosticOutput(
  {
    code: "invalid_argument_value",
    required: "Use --status open and retry.",
    recovery: { suggested_retry: "pm list --status open" },
  },
  { maxEstimatedTokens: contract.minimum_max_estimated_tokens },
);
const receipt: PmDiagnosticOutputReceipt | undefined =
  projected.diagnostic_output;
const projectedCode: string = projected.code;
const projectedRequired: string = projected.required;
const projectedRecovery: { suggested_retry: string } | undefined =
  projected.recovery;
const text = projectPmDiagnosticText("Diagnostic", "Retry.");
const declaredCount: number = PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS.length;

// @ts-expect-error diagnostic classes are a closed contract vocabulary
const invalidClass: PmDiagnosticOutputClass = "notice";

void receipt;
void projectedCode;
void projectedRequired;
void projectedRecovery;
void text;
void declaredCount;
void invalidClass;
