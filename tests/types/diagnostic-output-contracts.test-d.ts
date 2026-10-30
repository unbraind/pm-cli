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
import { isPmTokenBudgetRecovery, resolveTelemetrySourceAttribution, type PmTokenBudgetRecovery } from "@unbrained/pm-cli/sdk";
import { isPmTokenBudgetRecovery as coreBudgetGuard, type PmTokenBudgetRecovery as CoreBudgetRecovery } from "@unbrained/pm-cli/sdk/core";
import type { JsonErrorEnvelope } from "../../src/cli/error-guidance.js";
import { attachPreflightWarnings } from "../../src/cli/preflight-warnings.js";

const attribution = resolveTelemetrySourceAttribution({}, { PM_TELEMETRY_SOURCE_CONTEXT: "dogfood" }, false);
const sourceContext: "user" | "automation" | "test" | "dogfood" = attribution.source_context;
const sourceOrigin: "env_override" | "inferred" | "env_override_rejected" = attribution.source_context_source;
// @ts-expect-error source attribution must not widen to arbitrary private text
const invalidContext: typeof sourceContext = "private-path";
void sourceContext;
void sourceOrigin;
void invalidContext;

const withPreflight = attachPreflightWarnings({ code: "command_failed" });
const preflightCode: string = withPreflight.code;
const preflightWarnings: JsonErrorEnvelope["warnings"] = withPreflight.warnings;
const preflightDetails: JsonErrorEnvelope["warning_details"] = withPreflight.warning_details;
const preflightMessage: string | undefined = withPreflight.warning_details?.[0]?.message;
// @ts-expect-error advisory codes must remain machine-readable strings
const invalidWarningCode: JsonErrorEnvelope["warnings"] = [123];
void preflightCode;
void preflightWarnings;
void preflightDetails;
void preflightMessage;
void invalidWarningCode;

const budgetRecovery: PmTokenBudgetRecovery = {
  requested_tokens: 1, feasible_tokens: 500, minimum_feasible_tokens: null,
  minimum_status: "feasible_only", basis: "canonical_retry",
};
const unknownRecovery: unknown = budgetRecovery;
if (isPmTokenBudgetRecovery(unknownRecovery)) {
  const requested: number = unknownRecovery.requested_tokens;
  void requested;
  if (unknownRecovery.minimum_status === "unavailable") {
    const feasible: null = unknownRecovery.feasible_tokens;
    const reason: "query_cost_limit" | "search_limit" | "output_constraints" = unknownRecovery.reason;
    void feasible;
    void reason;
  } else {
    const feasible: number = unknownRecovery.feasible_tokens;
    void feasible;
  }
}
void coreBudgetGuard(budgetRecovery);
const exactRecovery: CoreBudgetRecovery = { ...budgetRecovery, minimum_status: "exact", minimum_feasible_tokens: 500 };
const unavailableRecovery: PmTokenBudgetRecovery = { ...budgetRecovery, minimum_status: "unavailable", feasible_tokens: null, reason: "search_limit" };
void exactRecovery;
void unavailableRecovery;
// @ts-expect-error exact evidence needs a verified feasible budget
const exactWithoutFeasible: PmTokenBudgetRecovery = { ...exactRecovery, feasible_tokens: null };
// @ts-expect-error exact evidence needs a proved minimum
const exactWithoutMinimum: PmTokenBudgetRecovery = { ...exactRecovery, minimum_feasible_tokens: null };
// @ts-expect-error exact evidence cannot carry an unavailable reason
const exactWithReason: PmTokenBudgetRecovery = { ...exactRecovery, reason: "search_limit" };
// @ts-expect-error feasible-only advice cannot claim an exact minimum
const feasibleWithMinimum: PmTokenBudgetRecovery = { ...budgetRecovery, minimum_feasible_tokens: 500 };
// @ts-expect-error feasible-only advice needs a verified feasible budget
const feasibleWithoutBudget: PmTokenBudgetRecovery = { ...budgetRecovery, feasible_tokens: null };
// @ts-expect-error feasible-only advice cannot carry an unavailable reason
const feasibleWithReason: PmTokenBudgetRecovery = { ...budgetRecovery, reason: "query_cost_limit" };
// @ts-expect-error unavailable advice requires its explicit cause
const unavailableWithoutReason: PmTokenBudgetRecovery = { ...budgetRecovery, minimum_status: "unavailable", feasible_tokens: null };
// @ts-expect-error unavailable advice cannot advertise a feasible budget
const unavailableWithBudget: PmTokenBudgetRecovery = { ...unavailableRecovery, feasible_tokens: 500 };
// @ts-expect-error unavailable advice cannot claim a minimum
const unavailableWithMinimum: PmTokenBudgetRecovery = { ...unavailableRecovery, minimum_feasible_tokens: 500 };
void exactWithoutFeasible;
void exactWithoutMinimum;
void exactWithReason;
void feasibleWithMinimum;
void feasibleWithoutBudget;
void feasibleWithReason;
void unavailableWithoutReason;
void unavailableWithBudget;
void unavailableWithMinimum;
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
