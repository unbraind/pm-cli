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
import { isPmTokenBudgetRecovery, type PmTokenBudgetRecovery } from "@unbrained/pm-cli/sdk";
import { isPmTokenBudgetRecovery as coreBudgetGuard } from "@unbrained/pm-cli/sdk/core";

const budgetRecovery: PmTokenBudgetRecovery = {
  requested_tokens: 1, feasible_tokens: 500, minimum_feasible_tokens: null,
  minimum_status: "feasible_only", basis: "canonical_retry",
};
const unknownRecovery: unknown = budgetRecovery;
if (isPmTokenBudgetRecovery(unknownRecovery)) {
  const requested: number = unknownRecovery.requested_tokens;
  void requested;
}
void coreBudgetGuard(budgetRecovery);
// @ts-expect-error the evidence vocabulary is closed
const invalidMinimumStatus: PmTokenBudgetRecovery["minimum_status"] = "guessed";
void invalidMinimumStatus;

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
const textReceipt: PmDiagnosticOutputReceipt = text.diagnostic_output;
const declaredCount: number = PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS.length;

// @ts-expect-error diagnostic classes are a closed contract vocabulary
const invalidClass: PmDiagnosticOutputClass = "notice";

void receipt;
void projectedCode;
void projectedRequired;
void projectedRecovery;
void text;
void textReceipt;
void declaredCount;
void invalidClass;
