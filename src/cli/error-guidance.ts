/**
 * @module cli/error-guidance
 *
 * Provides CLI runtime support for Error Guidance.
 */
import { describeReadCompletenessControls, isReadProjectionRecoveryFlag, resolveReadCompletenessControls, resolveReadOptionRetryArgs, resolveLinkedResourcePositionalRecovery } from "../sdk/agent/command-recovery.js";
import { isPmTokenBudgetRecovery } from "../sdk/errors.js";
import {
  type PmCliErrorContext,
  type PmCliErrorRecoveryPayload,
} from "../sdk/runtime-primitives.js";
import { resolveRecoveryCommandName } from "../sdk/agent/command-recovery.js";
import {
  estimatePmOutputTokens,
  isGenericRefusalRequired,
  isGenericRefusalWhy,
  projectLeanRecoveryPayload,
  projectPmDiagnosticOutput,
  projectPmDiagnosticText,
  resolvePmDiagnosticOutputBudget,
  withoutGenericRefusalExamples,
  type PmDiagnosticOutputReceipt,
  type PmProjectedDiagnostic,
} from "../sdk/cli-contracts/agent-output-contracts.js";
import { renderPmCommand } from "./argv-utils.js";
import { discoverNearbyPmRoot } from "../sdk/tracker-root-discovery.js";
import { stripGlobalBootstrapTokens } from "../sdk/cli-bootstrap.js";
import {
  findPmNamespacedCommand,
  resolvePmCommandAlias,
} from "../sdk/cli-contracts/command-aliases.js";

interface GuidanceMessage {
  sideEffects?: PmCliErrorContext["side_effects"];
  changed?: false;
  policyViolations?: PmCliErrorContext["policy_violations"];
  policyViolationCount?: number;
  itemId?: string;
  transactionOperation?: PmCliErrorContext["transaction_operation"];
  /** Bounded tracker-relative preview refusal coordinate. */
  previewStorage?: PmCliErrorContext["preview_storage"];
  tombstone?: PmCliErrorContext["tombstone"];
  /** Lease a refused lock_lost commit held. */
  lease?: PmCliErrorContext["lease"];
  /** Lock generation observed at a refused lock_lost commit. */
  currentOwner?: PmCliErrorContext["current_owner"];
  /** Principal holding the item behind an already_claimed_by refusal. */
  claimedBy?: string;
  /** When that holder took the item; null when history was silent. */
  claimedAt?: string | null;
  /** Whether the holder arrived through a claim or an assignment. */
  claimSource?: PmCliErrorContext["claim_source"];
  code: string;
  type: string;
  title: string;
  happened: string;
  required: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
  verificationErrors?: string[];
  flag?: string;
  value?: string;
  unmatchedSelectors?: NonNullable<PmCliErrorContext["unmatched_selectors"]>;
  availableDependencies?: NonNullable<
    PmCliErrorContext["available_dependencies"]
  >;
  recovery?: PmCliErrorRecoveryPayload;
}

/** Compact refusal identity embedded in every structured error envelope. */
export interface PmRefusalEnvelope {
  /** Command, flag, or missing operand that rejected the invocation. */
  surface: string;
  /** Supplied scalar rejected by a closed domain, when available. */
  rejected_value?: string;
  /** Complete legal domain advertised by the refusal, when applicable. */
  legal_domain?: string[];
  /** Required metadata paths from the displayed policy violations. */
  missing_fields?: string[];
  /** Policy identity, rule, rationale and missing fields, capped at three policies. */
  policies?: PmCliErrorContext["policy_violations"];
  /** Total violated policies, including any omitted from policies. */
  policy_violation_count?: number;
  /** Process exit code paired with the refusal. */
  exit_code: number;
}

/** Structured preflight advisories retained alongside a machine-readable outcome. */
export interface PreflightWarningDiagnostics {
  /** Stable advisory codes emitted before command execution. */
  warnings?: string[];
  /** Additional actionable guidance that accompanies an advisory code. */
  warning_details?: Array<{
    /** Stable code identifying the advisory. */
    code: string;
    /** Human-readable remediation retained for this code. */
    message: string;
  }>;
}

/** Documents the json error envelope payload exchanged by command, SDK, and package integrations. */
export interface JsonErrorEnvelope extends PreflightWarningDiagnostics {
  /** Completed durable writes, with paths relative to the selected tracker. */
  side_effects?: PmCliErrorContext["side_effects"];
  /** Verified admission refusal before any mutation. */
  changed?: false;
  /** Ordered mutation that failed semantic preview validation. */
  transaction_operation?: PmCliErrorContext["transaction_operation"];
  /** Bounded tracker-relative preview refusal coordinate. */
  preview_storage?: PmCliErrorContext["preview_storage"];
  /** Exact item identity attached to a storage diagnostic. */
  item_id?: string;
  /** Verified retained deletion and its recoverable version. */
  tombstone?: PmCliErrorContext["tombstone"];
  /** Lease a refused lock_lost commit held. */
  lease?: PmCliErrorContext["lease"];
  /** Lock generation observed at a refused lock_lost commit, or null when none exists. */
  current_owner?: PmCliErrorContext["current_owner"];
  /** Principal holding the item behind an already_claimed_by refusal. */
  claimed_by?: string;
  /** When that holder took the item, or null when history was silent. */
  claimed_at?: string | null;
  /** Whether the holder arrived through an explicit claim or a metadata assignment. */
  claim_source?: PmCliErrorContext["claim_source"];
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports code for this contract. */
  code: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Value that configures or reports detail for this contract. */
  detail: string;
  /** Value that configures or reports required for this contract. */
  required: string;
  /** Value that configures or reports exit code for this contract. */
  exit_code: number;
  /** Value that configures or reports why for this contract. */
  why?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports next steps for this contract. */
  next_steps?: string[];
  /** Exact integrity verifier findings that caused the operation to refuse. */
  verification_errors?: string[];
  /** CLI flag whose supplied value violated a shared mutation grammar. */
  flag?: string;
  /** Supplied scalar value that violated a shared mutation grammar. */
  value?: string;
  /** Dependency selectors that matched no stored edge. */
  unmatched_selectors?: NonNullable<PmCliErrorContext["unmatched_selectors"]>;
  /** Compact stored dependency identities available when a removal failed. */
  available_dependencies?: NonNullable<
    PmCliErrorContext["available_dependencies"]
  >;
  /** Value that configures or reports recovery for this contract. */
  recovery?: PmCliErrorRecoveryPayload;
  /** Stable compact identity of the failing surface and legal recovery domain. */
  refusal: PmRefusalEnvelope;
  /** Binding output-budget receipt for this diagnostic. */
  diagnostic_output?: PmDiagnosticOutputReceipt;
}

/** Error envelope after deterministic budget projection. */
export type ProjectedJsonErrorEnvelope =
  PmProjectedDiagnostic<JsonErrorEnvelope>;

/**
 * Compact an error envelope to fields that change the caller's next action:
 * the duplicated title, generic `required`/`why`/examples and the invocation
 * echo go; code-specific rationale, examples, recovery and typed holder
 * evidence stay (GH-1610).
 */
export function projectLeanErrorEnvelope(
  envelope: ProjectedJsonErrorEnvelope,
): ProjectedJsonErrorEnvelope {
  const { title: _title, ...actionable } = envelope;
  if (isGenericRefusalWhy(actionable.why)) delete actionable.why;
  if (isGenericRefusalRequired(actionable.required)) {
    delete (actionable as Partial<ProjectedJsonErrorEnvelope>).required;
  }
  const examples = withoutGenericRefusalExamples(actionable.examples);
  if (examples.length > 0) actionable.examples = examples;
  else delete actionable.examples;
  const recovery = projectLeanRecoveryPayload(actionable.recovery);
  if (recovery === undefined) delete actionable.recovery;
  else actionable.recovery = recovery;
  return actionable;
}

/** Documents the error classification payload exchanged by command, SDK, and package integrations. */
export interface ErrorClassification {
  /** Completed durable writes, with paths relative to the selected tracker. */
  side_effects?: PmCliErrorContext["side_effects"];
  /** Verified admission refusal before any mutation. */
  changed?: false;
  /** Ordered mutation that failed semantic preview validation. */
  transaction_operation?: PmCliErrorContext["transaction_operation"];
  /** Bounded tracker-relative preview refusal coordinate. */
  preview_storage?: PmCliErrorContext["preview_storage"];
  /** Exact item identity attached to a storage diagnostic. */
  item_id?: string;
  /** Verified retained deletion and its recoverable version. */
  tombstone?: PmCliErrorContext["tombstone"];
  /** Lease a refused lock_lost commit held. */
  lease?: PmCliErrorContext["lease"];
  /** Lock generation observed at a refused lock_lost commit, or null when none exists. */
  current_owner?: PmCliErrorContext["current_owner"];
  /** Principal holding the item behind an already_claimed_by refusal. */
  claimed_by?: string;
  /** When that holder took the item, or null when history was silent. */
  claimed_at?: string | null;
  /** Whether the holder arrived through an explicit claim or a metadata assignment. */
  claim_source?: PmCliErrorContext["claim_source"];
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports code for this contract. */
  code: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Value that configures or reports detail for this contract. */
  detail: string;
  /** Value that configures or reports required for this contract. */
  required: string;
  /** Value that configures or reports why for this contract. */
  why?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports next steps for this contract. */
  next_steps?: string[];
  /** Exact integrity verifier findings that caused the operation to refuse. */
  verification_errors?: string[];
  /** CLI flag whose supplied value violated a shared mutation grammar. */
  flag?: string;
  /** Supplied scalar value that violated a shared mutation grammar. */
  value?: string;
  /** Dependency selectors that matched no stored edge. */
  unmatched_selectors?: NonNullable<PmCliErrorContext["unmatched_selectors"]>;
  /** Compact stored dependency identities available when a removal failed. */
  available_dependencies?: NonNullable<
    PmCliErrorContext["available_dependencies"]
  >;
  /** Value that configures or reports recovery for this contract. */
  recovery?: PmCliErrorRecoveryPayload;
}

/** Documents the commander guidance context payload exchanged by command, SDK, and package integrations. */
export interface CommanderGuidanceContext {
  /** Value that configures or reports unknown command examples for this contract. */
  unknownCommandExamples?: string[];
  /** Value that configures or reports unknown command next steps for this contract. */
  unknownCommandNextSteps?: string[];
  /** Value that configures or reports attempted command for this contract. */
  attemptedCommand?: string;
  /** Value that configures or reports normalized invocation args for this contract. */
  normalizedInvocationArgs?: string[];
  /** Value that configures or reports provided option flags for this contract. */
  providedOptionFlags?: string[];
  /** Value that configures or reports unknown option suggestions for this contract. */
  unknownOptionSuggestions?: string[];
  /** Value that configures or reports unknown option other commands for this contract. */
  unknownOptionOtherCommands?: string[];
  /** Complete number of commands accepting the unknown option. */
  unknownOptionOtherCommandsTotal?: number;
  /** Whether the structured command candidates reached their own ceiling. */
  unknownOptionOtherCommandsTruncated?: boolean;
  /** Declared lexicon membership of the rejected option spelling. */
  unknownOptionScope?: PmCliErrorRecoveryPayload["option_scope"];
  /** Command family whose positional subcommand was split into invalid tokens. */
  unknownSubcommandPath?: string;
  /** Rejected positional subcommand token or token sequence. */
  unknownSubcommandToken?: string;
  /** Complete declared subcommand vocabulary for the command family. */
  unknownSubcommandAllowedValues?: string[];
  /** Value that configures or reports suggested retry command for this contract. */
  suggestedRetryCommand?: string;
  /** Tokenized inspection retry that preserves a refusal without executing the guessed operation. */
  suggestedRetryArgs?: string[];
  /** Existing item id verified against the selected tracker for collection recovery. */
  verifiedCollectionItemId?: string;
  /** Installed extensions whose activation failed for this invocation. */
  failedExtensions?: Array<{ name: string }>;
}

// JSON/classification payloads are consumed heavily by agents; suppress common
// boilerplate rationale text there to reduce token overhead. Human display
// guidance still renders "Why" unchanged.
const STRUCTURED_WHY_SUPPRESSION_CODES = new Set<string>([
  "unknown_command",
  "unknown_option",
  "missing_required_option",
  "missing_required_argument",
  "invalid_argument_value",
  "invalid_command_usage",
  "command_failed",
]);

function includeWhyInStructuredGuidance(message: GuidanceMessage): boolean {
  if (!message.why) {
    return false;
  }
  if (message.recovery?.recovery_mode === "compact") {
    return false;
  }
  return !STRUCTURED_WHY_SUPPRESSION_CODES.has(message.code);
}

function errorType(code: string): string {
  return `urn:pm-cli:error:${code}`;
}

function makeGuidanceMessage(
  params: Omit<GuidanceMessage, "type">,
): GuidanceMessage {
  return {
    ...params,
    type: errorType(params.code),
  };
}

interface PackageCommandHint {
  /** Published package name shown to the user (e.g. @unbrained/pm-guide-shell). */
  packageName: string;
  /** Exact CLI command that installs the bundled package by its install alias. */
  installCommand: string;
}

// Catalog of command tokens that are provided by optional first-party packages
// rather than core. When an unknown-command error names one of these, we surface
// a concrete install hint so agents/humans aren't left guessing. The install
// command uses the bundled alias accepted by `pm install <alias>` (see
// packages/pm-*/package.json `pm.aliases` and extension.ts install_command).
const GUIDE_SHELL_HINT: PackageCommandHint = {
  packageName: "@unbrained/pm-guide-shell",
  installCommand: "pm install guide-shell",
};
const CALENDAR_HINT: PackageCommandHint = {
  packageName: "@unbrained/pm-calendar",
  installCommand: "pm install calendar",
};
const SEARCH_ADVANCED_HINT: PackageCommandHint = {
  packageName: "@unbrained/pm-search-advanced",
  installCommand: "pm install search-advanced",
};
const GOVERNANCE_AUDIT_HINT: PackageCommandHint = {
  packageName: "@unbrained/pm-governance-audit",
  installCommand: "pm install audit",
};

const KNOWN_PACKAGE_COMMAND_HINTS: Readonly<
  Record<string, PackageCommandHint>
> = {
  guide: GUIDE_SHELL_HINT,
  shell: GUIDE_SHELL_HINT,
  completion: GUIDE_SHELL_HINT,
  "completion-statuses": GUIDE_SHELL_HINT,
  "completion-tags": GUIDE_SHELL_HINT,
  "completion-types": GUIDE_SHELL_HINT,
  templates: {
    packageName: "@unbrained/pm-templates",
    installCommand: "pm install templates",
  },
  calendar: CALENDAR_HINT,
  cal: CALENDAR_HINT,
  reindex: SEARCH_ADVANCED_HINT,
  "search-advanced": SEARCH_ADVANCED_HINT,
  "test-runs": {
    packageName: "@unbrained/pm-linked-test-adapters",
    installCommand: "pm install linked-test-adapters",
  },
  "comments-audit": GOVERNANCE_AUDIT_HINT,
  "dedupe-audit": GOVERNANCE_AUDIT_HINT,
  "dedupe-merge": GOVERNANCE_AUDIT_HINT,
  normalize: GOVERNANCE_AUDIT_HINT,
};

function resolveKnownPackageCommandHint(
  commandToken: string,
): PackageCommandHint | undefined {
  const primary = commandToken.trim().split(/\s+/)[0]?.toLowerCase();
  if (!primary) {
    return undefined;
  }
  return KNOWN_PACKAGE_COMMAND_HINTS[primary];
}

function renderList(title: string, entries: string[]): string[] {
  if (entries.length === 0) {
    return [];
  }
  return [title, ...entries.map((entry) => `  - ${entry}`)];
}

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRecoveryCandidates(
  candidates: PmCliErrorRecoveryPayload["fallback_candidates"],
): PmCliErrorRecoveryPayload["fallback_candidates"] | undefined {
  if (!Array.isArray(candidates)) {
    return undefined;
  }
  const normalized = candidates
    .map((entry) => ({
      source: typeof entry?.source === "string" ? entry.source.trim() : "",
      command: typeof entry?.command === "string" ? entry.command.trim() : "",
      reason: typeof entry?.reason === "string" ? entry.reason.trim() : "",
    }))
    .filter(
      (entry) =>
        entry.source.length > 0 &&
        entry.command.length > 0 &&
        entry.reason.length > 0,
    );
  return normalized.length > 0 ? normalized : undefined;
}

function assignRecoveryString(
  normalized: PmCliErrorRecoveryPayload,
  key: "attempted_command" | "suggested_retry" | "next_best_command",
  value: unknown,
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    normalized[key] = value.trim();
  }
}

/** Preserve executable argument strings exactly; malformed vectors cannot be repaired by deleting tokens. */
function normalizeRecoveryArgs(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
    ? [...value] as string[] : undefined;
}

function assignRecoveryCollection(
  normalized: PmCliErrorRecoveryPayload,
  key:
    | "normalized_args"
    | "parsed_positionals"
    | "provided_fields"
    | "missing"
    | "missing_required_fields"
    | "suggested_flags"
    | "suggested_retry_args"
    | "allowed_values"
    | "candidate_commands",
  value: unknown,
): void {
  if (key === "normalized_args" || key === "suggested_retry_args") {
    const args = normalizeRecoveryArgs(value);
    if (args) normalized[key] = args;
    return;
  }
  if (key === "parsed_positionals") {
    if (!Array.isArray(value)) return;
    const parsedPositionals = value
      .map((entry) => ({
        role: typeof entry?.role === "string" ? entry.role.trim() : "",
        value: typeof entry?.value === "string" ? entry.value.trim() : "",
      }))
      .filter((entry) => entry.role.length > 0 && entry.value.length > 0);
    if (parsedPositionals.length > 0) {
      normalized.parsed_positionals = parsedPositionals;
    }
    return;
  }
  const values = normalizeStringArray(value);
  if (values) {
    normalized[key] = values;
  }
}

/** Retain only validated, bounded budget advice from a package-carried expected error. */
function assignRecoveryTokenBudget(target: PmCliErrorRecoveryPayload, value: unknown): void {
  if (!isPmTokenBudgetRecovery(value)) return;
  const { requested_tokens, feasible_tokens, minimum_feasible_tokens, minimum_status, basis, reason } = value;
  // This whitelist preserves the correlated fields already verified by the guard.
  target.token_budget = { requested_tokens, feasible_tokens, minimum_feasible_tokens, minimum_status, basis, reason } as typeof value;
}

/** Non-negative integer recovery counters, in render order. */
const RECOVERY_COUNTER_KEYS = [
  "retry_after_ms",
  "waited_ms",
  "owner_handoffs",
] as const;

/** Render each present recovery counter as one bundle line. */
function appendRecoveryCounterLines(
  lines: string[],
  normalized: PmCliErrorRecoveryPayload,
): void {
  for (const key of RECOVERY_COUNTER_KEYS) {
    if (typeof normalized[key] === "number") {
      lines.push(`  ${key}: ${normalized[key]}`);
    }
  }
}

/** Copy each recovery counter that is a non-negative safe integer. */
function assignRecoveryCounters(
  normalized: PmCliErrorRecoveryPayload,
  payload: PmCliErrorRecoveryPayload,
): void {
  for (const key of RECOVERY_COUNTER_KEYS) {
    const value = payload[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      normalized[key] = value;
    }
  }
}

/** Whitelist valid recovery fields before exposing them in public CLI diagnostics. */
function normalizeRecoveryPayload(
  payload: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const normalized: PmCliErrorRecoveryPayload = {};
  assignRecoveryTokenBudget(normalized, payload.token_budget);
  if (payload.recovery_mode === "compact") {
    normalized.recovery_mode = "compact";
  }
  assignRecoveryString(
    normalized,
    "attempted_command",
    payload.attempted_command,
  );
  assignRecoveryCollection(
    normalized,
    "normalized_args",
    payload.normalized_args,
  );
  assignRecoveryCollection(
    normalized,
    "parsed_positionals",
    payload.parsed_positionals,
  );
  assignRecoveryCollection(
    normalized,
    "provided_fields",
    payload.provided_fields,
  );
  assignRecoveryCollection(normalized, "missing", payload.missing);
  assignRecoveryCollection(
    normalized,
    "missing_required_fields",
    payload.missing_required_fields,
  );
  assignRecoveryCollection(
    normalized,
    "suggested_flags",
    payload.suggested_flags,
  );
  assignRecoveryCollection(
    normalized,
    "allowed_values",
    payload.allowed_values,
  );
  assignRecoveryCollection(
    normalized,
    "candidate_commands",
    payload.candidate_commands,
  );
  if (
    typeof payload.candidate_commands_total === "number" &&
    Number.isSafeInteger(payload.candidate_commands_total) &&
    payload.candidate_commands_total >= 0
  ) {
    normalized.candidate_commands_total = payload.candidate_commands_total;
  }
  if (payload.candidate_commands_truncated === true) {
    normalized.candidate_commands_truncated = true;
  }
  if (
    payload.option_scope === "declared_on_path" ||
    payload.option_scope === "declared_elsewhere" ||
    payload.option_scope === "declared_nowhere"
  ) {
    normalized.option_scope = payload.option_scope;
  }
  assignRecoveryString(normalized, "suggested_retry", payload.suggested_retry);
  assignRecoveryCollection(
    normalized,
    "suggested_retry_args",
    payload.suggested_retry_args,
  );
  assignRecoveryCounters(normalized, payload);
  const fallbackCandidates = normalizeRecoveryCandidates(
    payload.fallback_candidates,
  );
  if (fallbackCandidates) {
    normalized.fallback_candidates = fallbackCandidates;
  }
  assignRecoveryString(
    normalized,
    "next_best_command",
    payload.next_best_command,
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function appendRecoveryTextLine(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (value) {
    lines.push(`  ${label}: ${value}`);
  }
}

function appendRecoveryListLine(
  lines: string[],
  label: string,
  values: string[] | undefined,
  separator: string,
): void {
  if (values && values.length > 0) {
    lines.push(`  ${label}: ${values.join(separator)}`);
  }
}

/** Render normalized recovery fields and verified budget evidence as human guidance. */
function renderRecoveryBundle(
  recovery: PmCliErrorRecoveryPayload | undefined,
): string[] {
  const normalized = normalizeRecoveryPayload(recovery);
  if (!normalized) {
    return [];
  }
  const lines = ["Recovery bundle:"];
  if (normalized.token_budget) {
    const budget = normalized.token_budget;
    lines.push(`  requested_token_budget: ${budget.requested_tokens}`,
      `  feasible_token_budget: ${budget.feasible_tokens ?? "unavailable"}`,
      `  minimum_token_budget: ${budget.minimum_feasible_tokens ?? "not established"}`);
  }
  appendRecoveryTextLine(lines, "suggested_retry", normalized.suggested_retry);
  appendRecoveryTextLine(
    lines,
    "attempted_command",
    normalized.attempted_command,
  );
  appendRecoveryListLine(
    lines,
    "normalized_args",
    normalized.attempted_command ? undefined : normalized.normalized_args,
    " ",
  );
  if (
    normalized.parsed_positionals &&
    normalized.parsed_positionals.length > 0
  ) {
    lines.push("  parsed_positionals:");
    for (const positional of normalized.parsed_positionals) {
      lines.push(`    - ${positional.role}: ${positional.value}`);
    }
  }
  appendRecoveryListLine(
    lines,
    "provided_fields",
    normalized.provided_fields,
    ", ",
  );
  appendRecoveryListLine(lines, "missing", normalized.missing, ", ");
  appendRecoveryListLine(
    lines,
    "missing_required_fields",
    normalized.missing_required_fields,
    ", ",
  );
  appendRecoveryListLine(
    lines,
    "suggested_flags",
    normalized.suggested_flags,
    ", ",
  );
  appendRecoveryListLine(
    lines,
    "allowed_values",
    normalized.allowed_values,
    ", ",
  );
  appendRecoveryListLine(
    lines,
    "candidate_commands",
    normalized.candidate_commands,
    ", ",
  );
  if (typeof normalized.candidate_commands_total === "number") {
    lines.push(
      `  candidate_commands_total: ${String(normalized.candidate_commands_total)}`,
    );
  }
  if (normalized.candidate_commands_truncated === true) {
    lines.push("  candidate_commands_truncated: true");
  }
  if (normalized.option_scope !== undefined) {
    lines.push(`  option_scope: ${normalized.option_scope}`);
  }
  appendRecoveryCounterLines(lines, normalized);
  appendRecoveryTextLine(
    lines,
    "next_best_command",
    normalized.next_best_command,
  );
  if (
    normalized.fallback_candidates &&
    normalized.fallback_candidates.length > 0
  ) {
    lines.push("  fallback_candidates:");
    for (const candidate of normalized.fallback_candidates) {
      lines.push(
        `    - ${candidate.source}: ${candidate.command} (${candidate.reason})`,
      );
    }
  }
  return lines;
}

/** Presentation controls for text refusals. */
export interface RenderGuidanceOptions {
  /** Omit constant boilerplate and the invocation echo; keep code-specific recovery (GH-1610). */
  lean?: boolean;
}

/** Longest holder name the one-line text rendering prints; JSON keeps the full `claimed_by`. */
const CLAIM_HOLDER_TEXT_MAX_CODE_POINTS = 120;

/** Render the typed holder evidence of an already_claimed_by refusal on one line. */
function renderClaimHolderLine(message: GuidanceMessage): string | undefined {
  if (message.claimedBy === undefined) return undefined;
  const since = message.claimedAt ? ` since ${message.claimedAt}` : "";
  const holder = Array.from(message.claimedBy);
  const name =
    holder.length > CLAIM_HOLDER_TEXT_MAX_CODE_POINTS
      ? `${holder.slice(0, CLAIM_HOLDER_TEXT_MAX_CODE_POINTS).join("")}...`
      : message.claimedBy;
  return `Held by: ${name} (${message.claimSource ?? "unknown"}${since})`;
}

/** Headline, requirement, next steps, the non-duplicated detail and typed holder evidence. */
function renderGuidanceLead(message: GuidanceMessage, lean: boolean): string[] {
  const lines: string[] = [`Error: ${message.title}`];
  if (!lean || !isGenericRefusalRequired(message.required)) {
    lines.push("", "What is required:", `  ${message.required}`);
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    lines.push("");
    lines.push(...renderList("Next steps:", message.nextSteps));
  }
  // The headline already carries a single-line message; repeat it only when
  // the title is a classification that differs from what happened.
  if (message.happened !== message.title) {
    lines.push("", "What happened:", `  ${message.happened}`);
  }
  const holderLine = renderClaimHolderLine(message);
  if (holderLine !== undefined) lines.push("", holderLine);
  return lines;
}

/** Rationale, examples and verifier findings; lean output drops the constant rationale and generic examples. */
function renderGuidanceExplanation(message: GuidanceMessage, lean: boolean): string[] {
  const lines: string[] = [];
  if (message.why && !(lean && isGenericRefusalWhy(message.why))) {
    lines.push("", "Why:", `  ${message.why}`);
  }
  const examples = lean
    ? withoutGenericRefusalExamples(message.examples)
    : (message.examples ?? []);
  if (examples.length > 0) {
    lines.push("", ...renderList("Examples:", examples));
  }
  const verificationErrors = message.verificationErrors ?? [];
  if (verificationErrors.length > 0) {
    lines.push("", ...renderList("Verification errors:", verificationErrors));
  }
  return lines;
}

/** Implements render guidance message for the public runtime surface of this module. */
export function renderGuidanceMessage(
  message: GuidanceMessage,
  options: RenderGuidanceOptions = {},
): string {
  const lean = options.lean === true;
  const lines = [
    ...renderGuidanceLead(message, lean),
    ...renderGuidanceExplanation(message, lean),
  ];
  const recoveryLines = renderRecoveryBundle(
    lean ? projectLeanRecoveryPayload(message.recovery) : message.recovery,
  );
  if (recoveryLines.length > 0) {
    lines.push("");
    lines.push(...recoveryLines);
  }
  return lines.join("\n");
}

const TEXT_DIAGNOSTIC_OMISSION_NOTICE =
  "Some guidance was omitted to fit the diagnostic token ceiling; rerun with --json for the full recovery envelope.";
const TEXT_RECOVERY_RETRY_MAX_BYTES = 400;
const TEXT_HAPPENED_MAX_CODE_POINTS = 320;

/** Keep the retry coordinates once the full bundle, which echoes the attempted argv, no longer fits. */
function compactTextRecovery(
  recovery: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  const normalized = normalizeRecoveryPayload(recovery);
  if (!normalized) return undefined;
  const compact: PmCliErrorRecoveryPayload = {};
  if (
    normalized.suggested_retry &&
    Buffer.byteLength(normalized.suggested_retry, "utf8") <= TEXT_RECOVERY_RETRY_MAX_BYTES
  ) {
    compact.suggested_retry = normalized.suggested_retry;
  }
  for (const key of ["missing", "missing_required_fields", "allowed_values"] as const) {
    const values = normalized[key];
    if (values && values.length > 0) compact[key] = values.slice(0, 3);
  }
  if (normalized.next_best_command) compact.next_best_command = normalized.next_best_command;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/**
 * Walk the declared diagnostic ladder (explanation, collections, recovery) so
 * the specific "What happened" line survives an oversized echo; only text that
 * still overflows falls through to the action-only projection.
 */
function renderBoundedGuidanceMessage(
  message: GuidanceMessage,
  options: RenderGuidanceOptions = {},
): string {
  const full = renderGuidanceMessage(message, options);
  const budget =
    resolvePmDiagnosticOutputBudget("error").default_max_estimated_tokens_by_format.text;
  const fits = (text: string): boolean =>
    estimatePmOutputTokens(Buffer.byteLength(text, "utf8")) <= budget;
  if (fits(full)) return full;
  const withoutExplanation: GuidanceMessage = { ...message, why: undefined };
  const limitedCollections: GuidanceMessage = {
    ...withoutExplanation,
    examples: message.examples?.slice(0, 1),
    nextSteps: message.nextSteps?.slice(0, 1),
    verificationErrors: message.verificationErrors?.slice(0, 3),
  };
  const compactRecovery: GuidanceMessage = {
    ...limitedCollections,
    recovery: compactTextRecovery(message.recovery),
  };
  const happenedCodePoints = Array.from(message.happened);
  const boundedHappened: GuidanceMessage = {
    ...compactRecovery,
    examples: undefined,
    happened:
      happenedCodePoints.length > TEXT_HAPPENED_MAX_CODE_POINTS
        ? `${happenedCodePoints.slice(0, TEXT_HAPPENED_MAX_CODE_POINTS).join("")}...`
        : message.happened,
  };
  for (const candidate of [withoutExplanation, limitedCollections, compactRecovery, boundedHappened]) {
    const text = `${renderGuidanceMessage(candidate, options)}\n\n${TEXT_DIAGNOSTIC_OMISSION_NOTICE}`;
    if (fits(text)) return text;
  }
  return full;
}

/** Attach item-scoped tombstone and lost-lease evidence with the item identity. */
function attachItemDiagnostics(
  payload: JsonErrorEnvelope | ErrorClassification,
  message: GuidanceMessage,
): void {
  if (message.tombstone !== undefined) {
    payload.tombstone = message.tombstone;
    payload.item_id = message.itemId;
  }
  if (message.lease !== undefined) {
    payload.lease = message.lease;
    payload.current_owner = message.currentOwner ?? null;
    payload.item_id = message.itemId;
  }
  if (message.claimedBy !== undefined) {
    payload.claimed_by = message.claimedBy;
    payload.claimed_at = message.claimedAt ?? null;
    // An origin the producer did not prove is never reported as an explicit claim.
    payload.claim_source = message.claimSource ?? "unknown";
    payload.item_id = message.itemId;
  }
}

/** Attach optional actionable fields shared by JSON and classification envelopes. */
function attachStructuredGuidanceDetails<
  Payload extends JsonErrorEnvelope | ErrorClassification,
>(payload: Payload, message: GuidanceMessage): Payload {
  if (message.sideEffects !== undefined) payload.side_effects = message.sideEffects;
  if (message.previewStorage !== undefined) payload.preview_storage = message.previewStorage;
  if (message.transactionOperation !== undefined) {
    payload.transaction_operation = message.transactionOperation;
  }
  attachItemDiagnostics(payload, message);
  if (includeWhyInStructuredGuidance(message)) {
    payload.why = message.why;
  }
  if (message.examples && message.examples.length > 0) {
    payload.examples = message.examples;
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    payload.next_steps = message.nextSteps;
  }
  if (message.verificationErrors && message.verificationErrors.length > 0) {
    payload.verification_errors = message.verificationErrors;
  }
  if (message.flag !== undefined) payload.flag = message.flag;
  if (message.value !== undefined) payload.value = message.value;
  if (message.unmatchedSelectors !== undefined)
    payload.unmatched_selectors = message.unmatchedSelectors;
  if (message.availableDependencies !== undefined)
    payload.available_dependencies = message.availableDependencies;
  if (message.recovery) {
    payload.recovery = message.recovery;
  }
  return payload;
}

/** Prefer the producer flag, then an explicitly mentioned supplied flag; unrelated arguments cannot own a refusal. */
function resolveRefusalCandidateFlag(
  message: GuidanceMessage,
  normalizedArgs: readonly string[],
): string | undefined {
  if (message.flag) return message.flag;
  /** Admit a mentioned flag only when the invocation supplies it and it is not a presentation control. */
  const isAdmissibleCandidate = (flag: string): boolean => {
    const canonicalFlag = flag.split("=", 1)[0];
    return (
      stripGlobalBootstrapTokens([canonicalFlag]).length > 0 &&
      !["--help", "--no-changed-fields", "--version"].includes(canonicalFlag) &&
      normalizedArgs.some(
        (argument) =>
          argument === canonicalFlag ||
          argument.startsWith(`${canonicalFlag}=`),
      )
    );
  };
  const mentionedFlag = [
    ...`${message.title} ${message.happened}`.matchAll(
      /--[A-Za-z0-9][A-Za-z0-9_-]*/gu,
    ),
  ]
    .map((match) => match[0])
    .find((flag) => isAdmissibleCandidate(flag));
  return mentionedFlag;
}

/** Preserve producer scalars and intentional unknown values; infer an operand only when the surface came from legacy text guidance. */
function resolveRefusalRejectedValue(
  message: GuidanceMessage,
  normalizedArgs: readonly string[],
  candidateFlag: string | undefined,
): string | undefined {
  if (message.value !== undefined) return message.value;
  if (message.flag !== undefined) return undefined;
  if (candidateFlag) {
    const candidateArgument = normalizedArgs.find(
      (argument) =>
        argument === candidateFlag || argument.startsWith(`${candidateFlag}=`),
    );
    if (candidateArgument?.startsWith(`${candidateFlag}=`)) {
      return candidateArgument.slice(candidateFlag.length + 1);
    }
    const candidateIndex = normalizedArgs.indexOf(candidateFlag);
    // Legacy candidates have already been matched to supplied arguments; attached values returned above.
    return normalizedArgs[candidateIndex + 1];
  }
  return undefined;
}

/** Identify the actual refusal surface, prioritizing domain policy evidence over syntactically valid input flags. */
function buildRefusalEnvelope(
  message: GuidanceMessage,
  exitCode: number,
): PmRefusalEnvelope {
  if (message.policyViolations?.length) {
    return {
      surface: `policy:${message.policyViolations.map((policy) => policy.policy_id).join(",")}`,
      policies: message.policyViolations,
      policy_violation_count: message.policyViolationCount,
      missing_fields: [
        ...new Set(
          message.policyViolations.flatMap((policy) => policy.missing_fields),
        ),
      ],
      exit_code: exitCode,
    };
  }
  const invocationArgs = stripGlobalBootstrapTokens(
    message.recovery?.normalized_args ?? [],
  );
  const namespaced = findPmNamespacedCommand(invocationArgs);
  const normalizedArgs = namespaced
    ? [
        namespaced.alias,
        ...invocationArgs.slice(namespaced.canonical_argv.length),
      ]
    : invocationArgs;
  const candidateFlag = resolveRefusalCandidateFlag(message, normalizedArgs);
  const rejectedValue = resolveRefusalRejectedValue(
    message,
    normalizedArgs,
    candidateFlag,
  );
  return {
    surface:
      candidateFlag ??
      message.recovery?.missing?.[0] ??
      resolveRecoveryCommandName(normalizedArgs) ??
      "command",
    ...(rejectedValue !== undefined ? { rejected_value: rejectedValue } : {}),
    ...(message.recovery?.allowed_values?.length
      ? { legal_domain: message.recovery.allowed_values }
      : {}),
    exit_code: exitCode,
  };
}

/** Project guidance into JSON, preserving no-write evidence only when explicitly verified. */
function guidanceToJsonEnvelope(
  message: GuidanceMessage,
  exitCode: number,
): JsonErrorEnvelope {
  return attachStructuredGuidanceDetails(
    {
      type: message.type,
      code: message.code,
      title: message.title,
      detail: message.happened,
      required: message.required,
      exit_code: exitCode,
      refusal: buildRefusalEnvelope(message, exitCode),
      ...(message.changed === false ? { changed: false as const } : {}),
    },
    message,
  );
}

function projectJsonErrorGuidance(
  guidance: GuidanceMessage,
  exitCode: number,
): ProjectedJsonErrorEnvelope {
  const recovery = guidance.recovery;
  const hasActionableRecovery =
    Boolean(recovery?.suggested_retry) ||
    Boolean(recovery?.suggested_retry_args?.length) ||
    Boolean(recovery?.allowed_values?.length) ||
    Boolean(recovery?.candidate_commands?.length) ||
    Boolean(guidance.nextSteps?.length);
  return projectPmDiagnosticOutput(guidanceToJsonEnvelope(guidance, exitCode), {
    diagnosticClass: hasActionableRecovery ? "recovery_bundle" : "error",
  });
}

/** Classify guidance with the same optional refusal evidence as the JSON envelope. */
function guidanceToClassification(
  message: GuidanceMessage,
): ErrorClassification {
  return attachStructuredGuidanceDetails(
    {
      type: message.type,
      code: message.code,
      title: message.title,
      detail: message.happened,
      required: message.required,
      ...(message.changed === false ? { changed: false as const } : {}),
    },
    message,
  );
}

function normalizeMessage(message: string): string {
  return message.replace(/\(outputHelp\)/g, "").trim();
}

function isModuleResolutionErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot find module") ||
    normalized.includes("cannot find package") ||
    normalized.includes("err_module_not_found") ||
    normalized.includes("module_not_found")
  );
}

function normalizeContextList(
  values: string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function inferCommandNameFromRecovery(
  recovery: PmCliErrorRecoveryPayload | undefined,
): string | undefined {
  return resolveRecoveryCommandName(recovery?.normalized_args);
}

function inferAllowedValuesFromMessage(message: string): string[] {
  const match = message.match(/\bmust be one of:?\s+([A-Za-z0-9_.|,\- ]+)/i);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/[|,]/)
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z0-9_.-]+$/.test(entry));
}

function buildAllowedValueRetryCommand(
  recovery: PmCliErrorRecoveryPayload | undefined,
  allowedValues: string[],
): string | undefined {
  const args = recovery?.normalized_args;
  const fields = recovery?.provided_fields;
  const replacement = allowedValues[0];
  if (!Array.isArray(args) || !Array.isArray(fields) || !replacement) {
    return undefined;
  }
  for (const field of fields) {
    const index = args.findIndex((arg) => arg === field);
    if (
      index >= 0 &&
      index < args.length - 1 &&
      !args[index + 1]?.startsWith("-")
    ) {
      const nextArgs = [...args];
      nextArgs[index + 1] = replacement;
      return renderPmCommand(nextArgs);
    }
  }
  return undefined;
}

function buildFallbackTitleFromMessage(message: string): string | undefined {
  const firstLine = message.split(/\r?\n/)[0].trim();
  if (firstLine.length === 0) {
    return undefined;
  }
  if (firstLine.length <= 120) {
    return firstLine;
  }
  return `${firstLine.slice(0, 117)}...`;
}

function normalizeContextValue<Fallback extends string | undefined>(
  value: unknown,
  fallback: Fallback,
): string | Fallback {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

/** Match camelCase or snake_case SDK fields to supplied kebab-case flags, preserving explicit flag metadata. */
function resolveErrorContextFlag(context: PmCliErrorContext, recovery: PmCliErrorRecoveryPayload | undefined): string | undefined {
  if (context.flag !== undefined) return context.flag;
  if (context.field === undefined) return undefined;
  const flag = context.field.startsWith("--") ? context.field : `--${context.field
    .replaceAll(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase()}`;
  return recovery?.normalized_args?.some(/** Match only the supplied canonical spelling or its attached value; another valid flag cannot own this refusal. */ (argument) => argument === flag || argument.startsWith(`${flag}=`)) ? flag : undefined;
}

/** Merge SDK error evidence with CLI fallback guidance without discarding typed recovery or policy diagnostics. */
/** Merge typed SDK context into guidance without inferring mutation outcomes. */
function applyPmCliErrorContext(
  guidance: GuidanceMessage,
  rawMessage: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage {
  if (!context) {
    return guidance;
  }
  const normalizedRawMessage = normalizeMessage(rawMessage);
  const code = normalizeContextValue(context.code, guidance.code);
  const type = normalizeContextValue(context.type, errorType(code));
  const examples = normalizeContextList(context.examples) ?? guidance.examples;
  const nextSteps =
    normalizeContextList(context.nextSteps) ?? guidance.nextSteps;
  const verificationErrors =
    normalizeContextList(context.verification_errors) ??
    guidance.verificationErrors;
  const fallbackTitle =
    guidance.code === "command_failed" && context.code
      ? buildFallbackTitleFromMessage(normalizedRawMessage)
      : undefined;
  const contextRecovery = normalizeRecoveryPayload(context.recovery);
  const recovery =
    contextRecovery && guidance.recovery
      ? normalizeRecoveryPayload({ ...guidance.recovery, ...contextRecovery })
      : (contextRecovery ?? guidance.recovery);
  return {
    ...guidance,
    code,
    changed: context.changed,
    sideEffects: context.side_effects,
    type,
    title: fallbackTitle ?? guidance.title,
    happened:
      normalizedRawMessage.length > 0
        ? normalizedRawMessage
        : guidance.happened,
    required: normalizeContextValue(context.required, guidance.required),
    why: normalizeContextValue(context.why, guidance.why),
    examples,
    nextSteps,
    verificationErrors,
    policyViolations: context.policy_violations,
    policyViolationCount: context.policy_violation_count,
    flag: resolveErrorContextFlag(context, recovery) ?? guidance.flag,
    value: context.value ?? guidance.value,
    unmatchedSelectors: context.unmatched_selectors,
    itemId: context.item_id,
    transactionOperation: context.transaction_operation,
    previewStorage: context.preview_storage,
    tombstone: context.tombstone,
    lease: context.lease,
    currentOwner: context.current_owner,
    claimedBy: context.claimed_by,
    claimedAt: context.claimed_at,
    claimSource: context.claim_source,
    availableDependencies: context.available_dependencies,
    recovery,
  };
}

function buildTrackerNotInitializedGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  const trackerNotInitialized = message.match(
    /^Tracker is not initialized at (.+)\. (?:Run pm init first|Tracker root does not exist\. Run pm init first)\.$/,
  );
  if (!trackerNotInitialized) {
    return null;
  }
  const attemptedRoot = trackerNotInitialized[1];
  const nearbyRoot = discoverNearbyPmRoot(process.cwd(), attemptedRoot);
  if (nearbyRoot) {
    return applyPmCliErrorContext(
      makeGuidanceMessage({
        code: "tracker_not_initialized",
        title: "Tracker exists at a custom path",
        happened: `pm did not find initialized metadata at ${attemptedRoot}, but found a tracker at ${nearbyRoot}.`,
        required: "Select the existing tracker root explicitly.",
        why: "Implicit discovery checks the default .agents/pm layout and ancestor root-layout trackers, while custom nested roots require an explicit path.",
        examples: [
          `pm --pm-path ${nearbyRoot} <command>`,
          `PM_PATH=${nearbyRoot} pm <command>`,
        ],
        nextSteps: [
          `Re-run with "--pm-path ${nearbyRoot}" or export PM_PATH=${nearbyRoot}.`,
        ],
      }),
      rawMessage,
      context,
    );
  }
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "tracker_not_initialized",
      title: "Tracker is not initialized",
      happened: `pm data path does not contain initialized tracker metadata (${trackerNotInitialized[1]}).`,
      required:
        "Select an existing tracker with --pm-path/PM_PATH, or initialize the default .agents/pm storage.",
      why: "Most commands require settings in an explicitly selected root, an ancestor root-layout tracker, or the default .agents/pm directory.",
      examples: ["pm init", "pm init acme"],
      nextSteps: ['Run "pm init", then rerun your original command.'],
    }),
    rawMessage,
    context,
  );
}

/** Explain a failed item lookup with its actual ID operand and tracker-scope recovery. */
function buildItemNotFoundGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  const itemNotFound = message.match(/^Item ([^ ]+) not found$/);
  if (!itemNotFound) {
    return null;
  }
  const badId = itemNotFound[1];
  const isPlaceholder = /^(undefined|null|<.*>|\[.*\]|{.*}|)$/.test(badId);
  const happened = isPlaceholder
    ? `The item ID "${badId}" looks like a placeholder or unresolved variable. Ensure the ID argument is resolved before calling pm.`
    : `No item with id "${badId}" exists in the active tracker scope.`;
  const nextSteps = isPlaceholder
    ? [
        "Check that the variable holding the item ID is defined before passing it to pm.",
        'Use "pm list --status open --limit 20" to find valid IDs.',
      ]
    : ["Confirm the active --path/PM_PATH scope, then retry with a valid id."];
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "item_not_found",
      title: "Item ID not found",
      flag: "id",
      value: badId,
      happened,
      required: "Use an existing item ID from current tracker data.",
      why: "Mutation and read commands operate only on known IDs.",
      examples: [
        "pm list --status open --limit 20",
        'pm search "<keyword>" --limit 10',
      ],
      nextSteps,
    }),
    rawMessage,
    context,
  );
}

function buildOwnershipConflictGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  if (
    !message.includes("is assigned to") ||
    !message.includes("Use --force to override")
  ) {
    return null;
  }
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "ownership_conflict",
      title: "Ownership conflict",
      happened: message,
      required:
        "Run as the assigned owner, claim the item when appropriate, or use --force only for an approved override.",
      why: "Ownership checks prevent accidental concurrent mutations on claimed items and protect against conflicting writes.",
      examples: [
        "pm claim pm-a1b2",
        "pm update pm-a1b2 --status in_progress --force",
      ],
      nextSteps: [
        "Use --force for approved systematic metadata updates performed by leads or maintainers.",
        "Use --force when correcting known stale metadata after coordinating ownership changes.",
        'For non-terminal reassignment, prefer "pm claim <ID>" before running other mutations.',
      ],
    }),
    rawMessage,
    context,
  );
}

function buildLockConflictGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  if (!message.includes("is locked")) {
    return null;
  }
  const args = normalizeRecoveryArgs(context?.recovery?.normalized_args);
  const retry = args ? renderPmCommand(args) : undefined;
  const guidance = applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "lock_conflict",
      title: "Lock conflict",
      happened: message,
      required: "Wait for lock release, then retry the same operation. Set PM_LOCK_WAIT_MS to a larger bounded millisecond budget for expected contention.",
      why: "Locking protects item files from concurrent write races.",
      examples: retry ? [retry] : ["pm gc --scope locks --dry-run"],
    }),
    rawMessage,
    context,
  );
  if (args) {
    guidance.recovery = { ...guidance.recovery, suggested_retry: retry, suggested_retry_args: [...args] };
  }
  return guidance;
}

function buildPmMissingRequiredOptionGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  const missingRequiredOption = message.match(/^Missing required option /);
  const missingRequiredOptions = message.match(/^Missing required options /);
  if (!missingRequiredOption && !missingRequiredOptions) {
    return null;
  }
  const plural = Boolean(missingRequiredOptions);
  const missingOptionFlag = !plural
    ? message.replace(/^Missing required option\s+/, "").trim()
    : null;
  const missingOptionLabel = missingOptionFlag ?? "";
  const missingOptionRequired = missingOptionFlag
    ? `Pass ${missingOptionFlag} with a valid value before running the command.`
    : "Provide the required option for this command invocation.";
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "missing_required_option",
      title: plural
        ? "Missing required options"
        : `Missing required option ${missingOptionLabel}`,
      happened: message,
      required: plural
        ? "Provide every required option for this command invocation."
        : missingOptionRequired,
      why: "Required options define command intent and enforce deterministic write contracts.",
      examples: [
        'pm create --title "Task title" --description "Task details" --type Task --create-mode progressive',
        'pm create --title "Task title" --description "Task details" --type Task --status open --priority 1 --message "Create task" --dep "id=pm-epic01,kind=parent,created_at=now" --comment "created_at=now,text=Why this task exists." --note "created_at=now,text=Initial implementation note." --learning "created_at=now,text=Durable lesson placeholder." --file "path=src/example.ts,scope=project" --test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240" --doc "path=README.md,scope=project"',
      ],
      nextSteps: [
        'Run "pm <command> --help" to view required and recommended flags.',
        "For staged triage without placeholder linkage values, use --create-mode progressive.",
      ],
    }),
    rawMessage,
    context,
  );
}

function buildNoUpdateFieldsGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  if (!message.startsWith("No update flags provided")) {
    return null;
  }
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "no_update_fields",
      title: "No update fields supplied",
      happened:
        "The update command was called without any field-changing flags.",
      required:
        "Provide at least one field-changing flag such as --status, --priority, --title, --tags, --description, or --body. Use --message only to label a real mutation.",
      why: "pm update mutates existing item fields; no-op invocations are rejected to avoid ambiguous history.",
      examples: [
        'pm update pm-a1b2 --status in_progress --message "Start implementation"',
        'pm update pm-a1b2 --description "Clarified implementation scope" --message "Clarify task intent"',
        'pm append pm-a1b2 --body "Detailed progress notes" --message "Append progress notes"',
      ],
      nextSteps: [
        "Choose the item field you intend to change, then pair that change with --message for history context.",
        "Use pm comments, pm notes, pm learnings, or pm append when you only need to add narrative context.",
      ],
    }),
    rawMessage,
    context,
  );
}

function buildInvalidArgumentGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  if (
    !message.startsWith("Invalid ") &&
    !message.includes(" must be ") &&
    !message.includes(" requires ")
  ) {
    return null;
  }
  const recovery = normalizeRecoveryPayload(context?.recovery);
  const commandName = inferCommandNameFromRecovery(recovery);
  const helpExample = commandName
    ? `pm ${commandName} --help`
    : "pm <command> --help";
  const allowedValues = context?.allowed ?? inferAllowedValuesFromMessage(message);
  const enrichedRecovery = normalizeRecoveryPayload({
    ...recovery,
    allowed_values: recovery?.allowed_values ?? allowedValues,
  });
  const retryExample = buildAllowedValueRetryCommand(recovery, allowedValues);
  const examples = retryExample
    ? [retryExample, helpExample]
    : [helpExample, "pm contracts --command <command> --flags-only --json"];
  const nextSteps =
    allowedValues.length > 0
      ? [
          `Allowed values: ${allowedValues.join("|")}`,
          `Run "${helpExample}" to confirm command-specific constraints.`,
        ]
      : [
          "Check allowed values in command help, then rerun with corrected input.",
        ];
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "invalid_argument_value",
      title: "Invalid argument value",
      happened: message,
      required: "Use values that match documented command constraints.",
      why: "Validation protects data consistency and deterministic behavior across commands.",
      examples,
      nextSteps,
      recovery: enrichedRecovery,
    }),
    rawMessage,
    context,
  );
}

function buildPmCliErrorGuidance(
  rawMessage: string,
  context?: PmCliErrorContext,
): GuidanceMessage {
  const message = normalizeMessage(rawMessage);
  const guidance =
    buildTrackerNotInitializedGuidance(rawMessage, message, context) ??
    buildItemNotFoundGuidance(rawMessage, message, context) ??
    buildOwnershipConflictGuidance(rawMessage, message, context) ??
    buildLockConflictGuidance(rawMessage, message, context) ??
    buildPmMissingRequiredOptionGuidance(rawMessage, message, context) ??
    buildNoUpdateFieldsGuidance(rawMessage, message, context) ??
    buildInvalidArgumentGuidance(rawMessage, message, context);
  if (guidance) {
    return guidance;
  }

  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "command_failed",
      title: "Command failed",
      happened: message,
      required: "Adjust command input or tracker state and retry.",
      why: "pm enforces explicit, deterministic contracts for data and command semantics.",
      examples: ["pm --help", "pm <command> --help"],
    }),
    rawMessage,
    context,
  );
}

function commandExampleForRequiredOption(
  commandName: string | undefined,
  optionFlag: string,
  allowedTypes: string,
): string[] {
  if (commandName === "create" && optionFlag.startsWith("--type")) {
    const firstAllowed = allowedTypes.split("|")[0] || "Task";
    return [
      `pm create --title "Example title" --description "Example description" --type ${firstAllowed} --status open --priority 1 --message "Create item" --create-mode progressive`,
    ];
  }
  if (commandName === "update") {
    return [
      'pm update pm-a1b2 --status in_progress --message "Start implementation"',
    ];
  }
  return [`pm ${commandName ?? "<command>"} --help`];
}

function normalizeRequiredOptionLabel(rawValue: string): string {
  const normalized = rawValue.trim();
  const firstLongFlag = normalized.match(/--[A-Za-z0-9][A-Za-z0-9_-]*/)?.[0];
  return firstLongFlag ?? normalized;
}

function renderPmCommandFromArgs(
  argv: string[] | undefined,
): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) {
    return undefined;
  }
  return renderPmCommand(argv);
}

function normalizeOptionFlags(
  values: string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function buildCommanderRecoveryPayload(
  context: CommanderGuidanceContext | undefined,
  overrides: Partial<PmCliErrorRecoveryPayload> = {},
): PmCliErrorRecoveryPayload | undefined {
  const providedFields = normalizeOptionFlags(context?.providedOptionFlags);
  const normalizedArgs =
    Array.isArray(context?.normalizedInvocationArgs) &&
    context?.normalizedInvocationArgs.length > 0
      ? context.normalizedInvocationArgs
      : undefined;
  const attemptedCommand =
    typeof context?.attemptedCommand === "string"
      ? context.attemptedCommand
      : renderPmCommandFromArgs(normalizedArgs);
  const retryCommand =
    typeof context?.suggestedRetryCommand === "string"
      ? context.suggestedRetryCommand
      : undefined;
  return normalizeRecoveryPayload({
    attempted_command: attemptedCommand,
    normalized_args: normalizedArgs,
    provided_fields: providedFields,
    suggested_retry: retryCommand,
    suggested_retry_args: context?.suggestedRetryArgs,
    ...overrides,
  });
}

function appendIfMissing(
  entries: string[],
  value: string | undefined,
): string[] {
  if (!value || entries.includes(value)) {
    return entries;
  }
  return [...entries, value];
}

// Linked-test mutation flags on `pm test` whose values commonly contain spaces and
// nested "--" tokens (GH-191). Used to recognise the "too many arguments" failure
// shape produced when such a value is not quoted into a single shell token.
const LINKED_TEST_MUTATION_FLAGS = new Set(["--add", "--add-json", "--remove"]);
// Entry-identity keys eligible for the two-token form; mirrors
// LINKED_TEST_TWO_TOKEN_KEYS_BY_FLAG in bootstrap-args.ts.
const LINKED_TEST_RETRY_KEYS = new Set(["command", "cmd", "path"]);

function findLinkedTestMutationFlag(
  argv: string[] | undefined,
): string | undefined {
  if (!Array.isArray(argv)) {
    return undefined;
  }
  for (const token of argv) {
    if (!token.startsWith("--")) {
      continue;
    }
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    if (LINKED_TEST_MUTATION_FLAGS.has(flag)) {
      return flag;
    }
  }
  return undefined;
}

/** Synthesize a copy-pasteable retry for the unquoted linked-test value shape `pm test <id> --add command npm test -- parser` by re-joining the shell-split value tokens into the documented quoted `key=value` form. Only fires when the item id already precedes the flag (so trailing tokens unambiguously belong to the value) and the token after `--add`/`--remove` is an entry-identity key. */
export function buildLinkedTestQuotedRetryCommand(
  argv: string[] | undefined,
): string | undefined {
  if (!Array.isArray(argv)) {
    return undefined;
  }
  const commandIndex = argv.indexOf("test");
  if (commandIndex < 0) {
    return undefined;
  }
  const idToken = argv[commandIndex + 1];
  if (typeof idToken !== "string" || idToken.startsWith("-")) {
    return undefined;
  }
  for (let index = commandIndex + 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--add" && token !== "--remove") {
      continue;
    }
    const key = argv[index + 1];
    if (typeof key !== "string" || !LINKED_TEST_RETRY_KEYS.has(key)) {
      return undefined;
    }
    const valueTokens: string[] = [];
    for (let cursor = index + 2; cursor < argv.length; cursor += 1) {
      const candidate = argv[cursor];
      // A bare "--" belongs to the re-joined command value; real long flags end it.
      if (candidate.startsWith("--") && candidate.length > 2) {
        break;
      }
      valueTokens.push(candidate);
    }
    if (valueTokens.length < 2) {
      // Single-token values are auto-merged at bootstrap; nothing to repair here.
      return undefined;
    }
    const merged = `${key}=${valueTokens.join(" ")}`;
    const rewritten = [
      ...argv.slice(0, index + 1),
      merged,
      ...argv.slice(index + 2 + valueTokens.length),
    ];
    return renderPmCommand(rewritten);
  }
  return undefined;
}

function buildMissingRequiredOptionGuidance(
  message: string,
  commandName: string | undefined,
  allowedTypes: string,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const requiredOption = message.match(
    /required option '([^']+)' not specified/,
  );
  if (!requiredOption) {
    return null;
  }
  const optionFlag = normalizeRequiredOptionLabel(requiredOption[1]);
  const isType = optionFlag.startsWith("--type");
  const retryCommand = context?.suggestedRetryCommand;
  const providedFlags = normalizeOptionFlags(context?.providedOptionFlags);
  const missing = [optionFlag];
  const examples = commandExampleForRequiredOption(
    commandName,
    optionFlag,
    allowedTypes,
  );
  const examplesWithRetry = retryCommand
    ? appendIfMissing(examples, retryCommand)
    : examples;
  const nextStepsBase = isType
    ? [
        `Allowed type values: ${allowedTypes}`,
        `Run "pm ${commandName ?? "create"} --help --type <value>" for type-aware policy details.`,
      ]
    : [
        `Run "pm ${commandName ?? "<command>"} --help" for required option guidance.`,
      ];
  const nextStepsWithRetry = retryCommand
    ? appendIfMissing(
        nextStepsBase,
        `Replay with preserved arguments: ${retryCommand}`,
      )
    : nextStepsBase;
  const nextSteps =
    providedFlags && providedFlags.length > 0
      ? appendIfMissing(
          nextStepsWithRetry,
          `Already provided options: ${providedFlags.join(", ")}`,
        )
      : nextStepsWithRetry;
  return makeGuidanceMessage({
    code: "missing_required_option",
    title: `Missing required option ${optionFlag}`,
    happened: `Commander rejected the command because ${optionFlag} was not provided.`,
    required: `Pass ${optionFlag} with a valid value before running the command.`,
    why: isType
      ? "--type selects item contract and policy routing, including required/disabled option rules."
      : "Required flags define mandatory command intent and prevent ambiguous execution.",
    examples: examplesWithRetry,
    nextSteps,
    recovery: buildCommanderRecoveryPayload(context, { missing }),
  });
}

function buildMissingRequiredArgumentGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const missingArgument = message.match(/missing required argument '([^']+)'/);
  if (!missingArgument) {
    return null;
  }
  const argumentName = missingArgument[1];
  return makeGuidanceMessage({
    code: "missing_required_argument",
    title: `Missing required argument ${argumentName}`,
    happened: `Command invocation omitted positional argument ${argumentName}.`,
    required: `Provide ${argumentName} in the expected command position.`,
    why: "Positional arguments identify the target entity or action context for the command.",
    examples: [`pm ${commandName ?? "<command>"} --help`],
    recovery: buildCommanderRecoveryPayload(context, {
      missing: [argumentName],
    }),
  });
}

function buildUnsupportedUpdateOptionGuidance(
  optionName: string,
  context: CommanderGuidanceContext | undefined,
  suggestions: string[] | undefined,
): GuidanceMessage {
  return makeGuidanceMessage({
    code: "unsupported_update_option",
    title: `Unsupported option ${optionName} for update`,
    happened: `pm update does not accept ${optionName} for linked artifact mutations.`,
    required:
      "Use dedicated linked-artifact commands instead of pm update for files/docs changes.",
    why: "pm update manages scalar item metadata, while linked files/docs are managed by pm files and pm docs.",
    examples: [
      'pm files pm-a1b2 --add "path=src/cli/main.ts,scope=project,note=implementation surface"',
      'pm docs pm-a1b2 --add "path=README.md,scope=project,note=user-facing contract"',
    ],
    nextSteps: [
      'Run "pm files --help" and "pm docs --help" for add/remove payload formats.',
    ],
    recovery: buildCommanderRecoveryPayload(context, {
      suggested_flags: suggestions,
    }),
  });
}

const UNKNOWN_OPTION_REQUIRED_BY_SCOPE: Record<
  NonNullable<PmCliErrorRecoveryPayload["option_scope"]>,
  string
> = {
  declared_elsewhere:
    "Use an option declared on this path, or move the declared option to one of its accepting command paths.",
  declared_on_path:
    "Use the option with the value and syntax declared by this command path.",
  declared_nowhere:
    "Use a declared option on this command path; this spelling exists nowhere in the command lexicon.",
};

interface UnknownOptionCandidateContext {
  otherCommands: string[];
  optionScope: NonNullable<PmCliErrorRecoveryPayload["option_scope"]>;
  candidateTotal: number;
}

function resolveUnknownOptionCandidateContext(
  context: CommanderGuidanceContext,
): UnknownOptionCandidateContext {
  const otherCommands =
    normalizeContextList(context.unknownOptionOtherCommands) ?? [];
  return {
    otherCommands,
    optionScope:
      context.unknownOptionScope ??
      (otherCommands.length > 0 ? "declared_elsewhere" : "declared_nowhere"),
    candidateTotal:
      context.unknownOptionOtherCommandsTotal ?? otherCommands.length,
  };
}

function buildUnknownOptionNextSteps(
  optionName: string,
  commandName: string | undefined,
  suggestions: string[],
  candidateContext: UnknownOptionCandidateContext,
  retryCommand: string | undefined,
): string[] {
  const proseCommands = candidateContext.otherCommands.slice(0, 3);
  const proseRemainder = candidateContext.candidateTotal - proseCommands.length;
  const proseRemainderText =
    proseRemainder > 0
      ? ` and ${String(proseRemainder)} more command path(s)`
      : "";
  return [
    "Run command help to confirm the exact option contracts for this command path.",
    suggestions.length
      ? `Nearest supported options: ${suggestions.join(", ")}`
      : undefined,
    retryCommand ? undefined : describeSameCommandCompleteness(optionName, commandName),
    proseCommands.length
      ? `${optionName} is accepted by ${proseCommands.join(", ")}${proseRemainderText}. Inspect those command contracts only if you intended a different operation.`
      : undefined,
    isDashLeadingValue(optionName)
      ? `"${optionName}" contains spaces, so it is a value that starts with --, not an option. Pass it after a -- separator at the end of the command, or through the command's named value flag.`
      : candidateContext.optionScope === "declared_nowhere"
        ? `${optionName} is not declared on any command path. Use a nearest supported option on ${commandName ?? "the attempted command"}, or inspect that command's help.`
        : undefined,
    retryCommand
      ? `Replay with suggested correction: ${retryCommand}`
      : undefined,
  ].filter((entry): entry is string => typeof entry === "string");
}

const READ_COMPLETENESS_SPELLINGS = ["--brief", "--compact", "--standard", "--deep", "--full", "--summary", "--depth"];

/** Name the completeness controls the attempted read command accepts when no equivalent spelling exists there. */
function describeSameCommandCompleteness(optionName: string, commandName: string | undefined): string | undefined {
  if (commandName === undefined || !READ_COMPLETENESS_SPELLINGS.includes(optionName.split("=", 1)[0]!)) return undefined;
  const controls = resolveReadCompletenessControls(commandName);
  return controls === undefined
    ? undefined
    : `Completeness controls accepted by pm ${controls.command}: ${describeReadCompletenessControls(controls)}.`;
}

/** Recover read intent before lexical fallbacks can replace or discard it. */
function resolveReadIntentRetry(
  context: CommanderGuidanceContext,
  optionName: string,
  commandName: string | undefined,
): { retryCommand?: string; suggestedRetryArgs?: string[] } | undefined {
  const retry = resolveReadOptionRetryArgs(commandName ?? "", context.normalizedInvocationArgs ?? [], optionName);
  if (retry) return { retryCommand: renderPmCommand(retry), suggestedRetryArgs: retry };
  return [...READ_COMPLETENESS_SPELLINGS, "--toon", ...(commandName === "activity" ? ["--since"] : [])].includes(optionName.split("=", 1)[0]!) ? {} : undefined;
}

/** A rejected "option" containing whitespace is a value that starts with `--`, never an option spelling. */
function isDashLeadingValue(optionName: string): boolean {
  return /\s/u.test(optionName);
}

/** Pass a dash-leading value after `--`, only when every later token is an option so order and values survive. */
function resolveDashLeadingValueRetry(
  args: string[] | undefined,
  optionName: string,
): { retryCommand?: string; suggestedRetryArgs?: string[] } {
  const index = args?.indexOf(optionName) ?? -1;
  if (args === undefined || index < 0 || args.includes("--") || args.lastIndexOf(optionName) !== index) return {};
  if (args.slice(index + 1).some((token) => !token.startsWith("-"))) return {};
  const suggestedRetryArgs = [...stripGlobalBootstrapTokens(args.filter((_, position) => position !== index)), "--", optionName];
  return { retryCommand: renderPmCommand(suggestedRetryArgs), suggestedRetryArgs };
}

/** Keep unknown-option fallbacks from dropping presentation or preview intent. */
function resolveUnknownOptionRetry(
  context: CommanderGuidanceContext,
  optionName: string,
  commandName: string | undefined,
): { retryCommand?: string; suggestedRetryArgs?: string[] } {
  if (isDashLeadingValue(optionName)) return resolveDashLeadingValueRetry(context.normalizedInvocationArgs, optionName);
  if (
    ["--dry-run", "--check", "--check-only", "--plan", "--preview"].includes(
      optionName.split("=", 1)[0],
    )
  ) {
    return {};
  }
  const readRetry = resolveReadIntentRetry(context, optionName, commandName);
  if (readRetry) return readRetry;
  if (context.suggestedRetryCommand !== undefined) {
    return { retryCommand: context.suggestedRetryCommand };
  }
  if (isReadProjectionRecoveryFlag(optionName)) return {};
  const normalizedArgs = context.normalizedInvocationArgs;
  if (normalizedArgs === undefined) return {};
  if (
    normalizedArgs.filter(
      (argument) =>
        argument === optionName || argument.startsWith(`${optionName}=`),
    ).length !== 1
  ) {
    return {};
  }
  const optionIndex = normalizedArgs.findIndex(
    (argument) =>
      argument === optionName || argument.startsWith(`${optionName}=`),
  );
  if (
    optionIndex < 0 ||
    normalizedArgs.includes("--") ||
    (!normalizedArgs[optionIndex]?.includes("=") &&
      optionIndex !== normalizedArgs.length - 1 &&
      normalizedArgs[optionIndex + 1]?.startsWith("-") !== true)
  ) {
    return {};
  }
  const suggestedRetryArgs = stripGlobalBootstrapTokens(
    normalizedArgs.filter((_, index) => index !== optionIndex),
  );
  return {
    retryCommand: renderPmCommand(suggestedRetryArgs),
    suggestedRetryArgs,
  };
}

/** Build an option refusal with canonical help, declared alternatives and an unambiguous retry when available. */
function buildUnknownOptionGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const unknownOption = message.match(/unknown option '([^']+)'/);
  if (!unknownOption) {
    return null;
  }
  const guidanceContext = context ?? {};
  const optionName = unknownOption[1];
  const suggestions =
    normalizeOptionFlags(guidanceContext.unknownOptionSuggestions) ?? [];
  const { retryCommand, suggestedRetryArgs } = resolveUnknownOptionRetry(
    guidanceContext,
    optionName,
    commandName,
  );
  if (
    commandName === "update" &&
    (optionName === "--file" || optionName === "--doc")
  ) {
    return buildUnsupportedUpdateOptionGuidance(
      optionName,
      context,
      suggestions,
    );
  }
  const candidateContext =
    resolveUnknownOptionCandidateContext(guidanceContext);
  const nextSteps = buildUnknownOptionNextSteps(
    optionName,
    commandName,
    suggestions,
    candidateContext,
    retryCommand,
  );
  if (
    ["--dry-run", "--check", "--check-only", "--plan", "--preview"].includes(
      optionName.split("=", 1)[0],
    )
  ) {
    nextSteps.push(
      "The requested preview is unavailable on this path. Inspect the item with a read-only command or use a command that declares this option; do not replay this mutation without preview intent.",
    );
  }
  const examples = [
    retryCommand,
    commandName
      ? `pm ${resolvePmCommandAlias(commandName)?.canonical ?? commandName} --help`
      : "pm --help --all",
  ].filter((entry): entry is string => typeof entry === "string");
  return makeGuidanceMessage({
    code: "unknown_option",
    title: `Unknown option ${optionName}`,
    happened: `Commander does not recognize option ${optionName} for this command path.`,
    required: UNKNOWN_OPTION_REQUIRED_BY_SCOPE[candidateContext.optionScope],
    why: "Option contracts are command-specific and intentionally validated.",
    flag: optionName,
    value: optionName,
    examples,
    nextSteps,
    recovery: buildCommanderRecoveryPayload(context, {
      suggested_flags: suggestions.length > 0 ? suggestions : undefined,
      suggested_retry: retryCommand,
      suggested_retry_args: suggestedRetryArgs,
      candidate_commands: candidateContext.otherCommands,
      candidate_commands_total: candidateContext.candidateTotal || undefined,
      candidate_commands_truncated:
        guidanceContext.unknownOptionOtherCommandsTruncated,
      option_scope: candidateContext.optionScope,
    }),
  });
}

function buildKnownPackageCommandGuidance(
  commandToken: string,
  packageHint: PackageCommandHint,
  baseExamples: string[],
  baseNextSteps: string[],
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage {
  const installStep = `"${commandToken}" is provided by the ${packageHint.packageName} package. Install it with: ${packageHint.installCommand}`;
  // commander-usage may already append its generic "If this command comes from
  // an optional package…" step for the same alias; keep only the specific one.
  const nextSteps = baseNextSteps.filter(
    (step) => !step.endsWith(`: ${packageHint.installCommand}`),
  );
  return makeGuidanceMessage({
    code: "unknown_command",
    title: `Unknown command ${commandToken}`,
    happened: `pm does not expose command path "${commandToken}" in current runtime configuration. It is shipped by the optional ${packageHint.packageName} package.`,
    required: `Install the ${packageHint.packageName} package, or use a valid command name or subcommand path.`,
    why: "Command registry includes core commands plus active extension command handlers; package-provided commands appear only after the package is installed.",
    examples: dedupeStrings([packageHint.installCommand, ...baseExamples]),
    nextSteps: dedupeStrings([installStep, ...nextSteps]),
    recovery: buildCommanderRecoveryPayload(context),
  });
}

function buildUnknownCommandGuidance(
  message: string,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const unknownCommand = message.match(/unknown command '([^']+)'/);
  if (!unknownCommand) {
    return null;
  }
  const commandToken = unknownCommand[1];
  const runtimeExamples = normalizeContextList(context?.unknownCommandExamples);
  const runtimeNextSteps = normalizeContextList(
    context?.unknownCommandNextSteps,
  );
  const packageHint = resolveKnownPackageCommandHint(commandToken);
  const baseExamples = runtimeExamples ?? ["pm --help"];
  const baseNextSteps = runtimeNextSteps ?? [
    "Verify spelling and active extensions, then rerun.",
  ];
  const failedExtensionNames = new Set(
    context?.failedExtensions?.map((entry) => entry.name.trim().toLowerCase()),
  );
  const hintedExtensionName = packageHint?.packageName
    .replace(/^@unbrained\/pm-/, "")
    .toLowerCase();
  if (
    packageHint &&
    (!hintedExtensionName || !failedExtensionNames.has(hintedExtensionName))
  ) {
    return buildKnownPackageCommandGuidance(
      commandToken,
      packageHint,
      baseExamples,
      baseNextSteps,
      context,
    );
  }
  return makeGuidanceMessage({
    code: "unknown_command",
    title: `Unknown command ${commandToken}`,
    happened: `pm does not expose command path "${commandToken}" in current runtime configuration.`,
    required: "Use a valid command name or subcommand path.",
    why: "Command registry includes core commands plus active extension command handlers.",
    examples: baseExamples,
    nextSteps: baseNextSteps,
    recovery: buildCommanderRecoveryPayload(context),
  });
}

/** Explain a rejected positional action with its legal domain, canonical help path and any executable retry. */
function buildUnknownSubcommandGuidance(
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const commandPath = context?.unknownSubcommandPath?.trim();
  const token = context?.unknownSubcommandToken?.trim();
  const allowed = normalizeContextList(context?.unknownSubcommandAllowedValues);
  if (!commandPath || !token || !allowed) {
    return null;
  }
  const retryCommand = context?.suggestedRetryCommand;
  return makeGuidanceMessage({
    code: "unknown_subcommand",
    title: `Unknown ${commandPath} subcommand ${token}`,
    value: token,
    happened: `The positional token sequence "${token}" is not a declared ${commandPath} subcommand.`,
    required: `Use one of: ${allowed.join(", ")}.`,
    why: "Subcommands are single positional tokens; multi-word action names use hyphens.",
    examples: [
      ...(retryCommand ? [retryCommand] : []),
      `pm ${resolvePmCommandAlias(commandPath)?.canonical ?? commandPath} --help`,
    ],
    nextSteps: retryCommand
      ? [`Retry with the declared hyphenated action: ${retryCommand}`]
      : ["Choose one value from recovery.allowed_values."],
    recovery: buildCommanderRecoveryPayload(context, {
      allowed_values: allowed,
      suggested_retry: retryCommand,
    }),
  });
}

function buildLinkedTestValueNotQuotedGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  if (!/too many arguments/i.test(message) || commandName !== "test") {
    return null;
  }
  const argv = context?.normalizedInvocationArgs;
  const mutationFlag = findLinkedTestMutationFlag(argv);
  if (!mutationFlag) {
    return null;
  }
  const retryCommand = buildLinkedTestQuotedRetryCommand(argv);
  return makeGuidanceMessage({
    code: "linked_test_value_not_quoted",
    title: `Linked-test ${mutationFlag} value must be one argument`,
    happened: `Commander saw extra positional tokens after the item id — usually a ${mutationFlag} value containing spaces (for example a command with " -- ") that the shell split into multiple tokens.`,
    required: `Quote the whole ${mutationFlag} value as a single argument. Accepted forms: --add "command=npm test -- parser", --add command "npm test -- parser" (two-token form with the value quoted), or --add-json for complex commands.`,
    why: "The shell splits unquoted values before pm can see them, so pm cannot reassemble the intended command unambiguously.",
    examples: [
      ...(retryCommand ? [retryCommand] : []),
      'pm test pm-a1b2 --add "command=npm test -- parser"',
      'pm test pm-a1b2 --add command "npm test -- parser"',
      `pm test pm-a1b2 --add-json '{"command":"npm test -- parser"}'`,
    ],
    nextSteps: [
      ...(retryCommand
        ? [`Replay with the value re-joined into one argument: ${retryCommand}`]
        : []),
      "Prefer --add-json for commands containing commas, equals signs, or quotes.",
      'Run "pm test --help" for linked-test entry contracts.',
    ],
    recovery: buildCommanderRecoveryPayload(
      context,
      retryCommand ? { suggested_retry: retryCommand } : {},
    ),
  });
}

const TRANSPOSED_COLLECTION_COMMANDS = new Set([
  "comments",
  "docs",
  "files",
  "learnings",
  "notes",
  "test",
]);

/** Correct a misplaced resource value while refusing the original, unrequested mutation. */
function buildLinkedResourcePositionalGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  if (!/too many arguments/i.test(message)) return null;
  const recovery = resolveLinkedResourcePositionalRecovery(commandName, context?.normalizedInvocationArgs ?? []);
  if (!recovery) return null;
  const retry = recovery.retryArgs ? renderPmCommand(recovery.retryArgs) : undefined;
  const template = renderPmCommand(recovery.templateArgs ?? ["test", recovery.itemId, "--add", `command=<actual command>,${recovery.value}`]);
  return makeGuidanceMessage({
    code: "linked_resource_positional_value",
    title: "Linked-resource values require an explicit --add option",
    happened: `The value after the item id is not a positional argument of ${commandName}.`,
    required: retry
      ? `Retry the explicit collection mutation: ${retry}`
      : `Supply the actual command and its metadata together, for example ${template}.`,
    examples: [retry ?? template],
    recovery: buildCommanderRecoveryPayload(context, {
      suggested_retry: retry,
      suggested_retry_args: recovery.retryArgs,
    }),
  });
}

function buildTransposedCollectionActionGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  if (
    !/too many arguments/i.test(message) ||
    !TRANSPOSED_COLLECTION_COMMANDS.has(commandName ?? "")
  ) {
    return null;
  }
  const argv = context?.normalizedInvocationArgs ?? [];
  const commandIndex = argv.findIndex((token) => token === commandName);
  const action = argv[commandIndex + 1];
  const parsedItemId = argv[commandIndex + 2];
  const itemId = context?.verifiedCollectionItemId?.trim();
  if (
    action?.toLowerCase() !== "add" ||
    !parsedItemId ||
    parsedItemId.startsWith("-") ||
    !itemId ||
    itemId.toLowerCase() !== parsedItemId.toLowerCase()
  ) {
    return null;
  }
  const suggestedRetry = `pm ${commandName} ${itemId} --add <value>`;
  return makeGuidanceMessage({
    code: "collection_transposed_subcommand",
    title: `Transposed ${commandName} add syntax`,
    happened: `The positional token "add" occupied the item-id role and "${itemId}" occupied the next positional role. pm ${commandName} does not use an add subcommand.`,
    required: `Place the item id immediately after ${commandName}, then use --add for the value.`,
    why: "Collection mutations use object-first grammar: pm <collection> <item-id> --add <value>.",
    examples: [suggestedRetry, `pm ${commandName} --help`],
    recovery: buildCommanderRecoveryPayload(context, {
      parsed_positionals: [
        { role: "transposed_subcommand", value: action },
        { role: "item_id", value: itemId },
      ],
      suggested_retry: suggestedRetry,
    }),
  });
}

const CONTEXT_GUIDANCE_VALUE_FLAGS = new Set([
  "--activity-limit",
  "--assignee",
  "--assignee-filter",
  "--date",
  "--depth",
  "--fields",
  "--format",
  "--from",
  "--limit",
  "--parent",
  "--path",
  "--pm-path",
  "--priority",
  "--release",
  "--section",
  "--sprint",
  "--stale-threshold",
  "--tag",
  "--to",
  "--type",
]);
const CONTEXT_GUIDANCE_COMMAND_NAMES = new Set(["context", "ctx"]);

function buildContextItemArgumentGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  if (
    !/too many arguments/i.test(message) ||
    !CONTEXT_GUIDANCE_COMMAND_NAMES.has(commandName ?? "")
  ) {
    return null;
  }
  const argv = context?.normalizedInvocationArgs ?? [];
  const commandIndex = argv.findIndex((token) =>
    CONTEXT_GUIDANCE_COMMAND_NAMES.has(token),
  );
  const searchIndex = commandIndex === -1 ? 1 : commandIndex + 1;
  const match = message.match(/got \d+:\s*(\S+)/i);
  let positional = match ? match[1].replace(/\.$/, "") : undefined;
  if (positional === undefined) {
    let skipFlagValue = false;
    for (const token of argv.slice(searchIndex)) {
      if (skipFlagValue) {
        skipFlagValue = false;
        continue;
      }
      const flagName = token.split("=")[0];
      if (CONTEXT_GUIDANCE_VALUE_FLAGS.has(flagName)) {
        skipFlagValue = !token.includes("=");
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      positional = token;
      break;
    }
  }
  if (!positional) {
    return null;
  }
  const getCommand = `pm get ${positional}`;
  return makeGuidanceMessage({
    code: "context_takes_no_item_argument",
    title: "pm context takes no item argument",
    happened: `pm context renders a workspace-level snapshot and received the positional argument "${positional}".`,
    required: `Use ${getCommand} for one item's full details, or pm context --parent ${positional} to scope the snapshot to that item's subtree.`,
    why: "Item-level detail (pm get) and workspace-level context (pm context) are separate projections.",
    examples: [getCommand, `pm context --parent ${positional}`],
    recovery: buildCommanderRecoveryPayload(context, {
      suggested_retry: getCommand,
    }),
  });
}

function buildCommanderErrorGuidance(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
): GuidanceMessage {
  const message = normalizeMessage(rawMessage);
  const guidance =
    buildMissingRequiredOptionGuidance(
      message,
      commandName,
      allowedTypes,
      context,
    ) ??
    buildMissingRequiredArgumentGuidance(message, commandName, context) ??
    buildUnknownOptionGuidance(message, commandName, context) ??
    buildUnknownCommandGuidance(message, context) ??
    buildUnknownSubcommandGuidance(context) ??
    buildTransposedCollectionActionGuidance(message, commandName, context) ??
    buildLinkedTestValueNotQuotedGuidance(message, commandName, context) ??
    buildLinkedResourcePositionalGuidance(message, commandName, context) ??
    buildContextItemArgumentGuidance(message, commandName, context);
  if (guidance) {
    return guidance;
  }

  return makeGuidanceMessage({
    code: "invalid_command_usage",
    title: "Invalid command usage",
    happened: message,
    required: "Use the command with valid arguments and options.",
    why: "Commander validates CLI contracts before execution.",
    examples: ["pm --help", `pm ${commandName ?? "<command>"} --help`],
    recovery: buildCommanderRecoveryPayload(context),
  });
}

/** Render concise initialization recovery or the bounded diagnostic for other failures. */
export function formatPmCliErrorForDisplay(
  rawMessage: string,
  context?: PmCliErrorContext,
  options: RenderGuidanceOptions = {},
): string {
  const guidance = buildPmCliErrorGuidance(rawMessage, context);
  if (
    (context?.code === "tracker_root_missing" ||
      context?.code === "tracker_not_initialized") &&
    guidance.title === "Tracker is not initialized" &&
    guidance.recovery?.suggested_retry_args
  ) {
    return [
      `Error: ${guidance.title}`,
      `Run: ${renderPmCommand(guidance.recovery.suggested_retry_args)}`,
      "Use --json for full recovery details.",
    ].join("\n");
  }
  return renderBoundedGuidanceText(guidance, options);
}

/**
 * Render bounded refusal text. A default rendering that overflowed already
 * dropped its rationale, so it can be shorter than a lean one that kept a
 * code-specific why: lean output never prints more than the default.
 */
function renderBoundedGuidanceText(
  guidance: GuidanceMessage,
  options: RenderGuidanceOptions,
): string {
  const render = (renderOptions: RenderGuidanceOptions): string =>
    projectPmDiagnosticText(
      renderBoundedGuidanceMessage(guidance, renderOptions),
      guidance.required,
    ).output;
  const output = render(options);
  if (options.lean !== true) return output;
  const fallback = render({});
  return Buffer.byteLength(fallback, "utf8") < Buffer.byteLength(output, "utf8") ? fallback : output;
}

/** Implements classify pm cli error for the public runtime surface of this module. */
export function classifyPmCliError(
  rawMessage: string,
  context?: PmCliErrorContext,
): ErrorClassification {
  return guidanceToClassification(buildPmCliErrorGuidance(rawMessage, context));
}

/** Implements format pm cli error for json for the public runtime surface of this module. */
export function formatPmCliErrorForJson(
  rawMessage: string,
  exitCode: number,
  context?: PmCliErrorContext,
): ProjectedJsonErrorEnvelope {
  return projectJsonErrorGuidance(
    buildPmCliErrorGuidance(rawMessage, context),
    exitCode,
  );
}

/** Implements format commander error for display for the public runtime surface of this module. */
export function formatCommanderErrorForDisplay(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
  options: RenderGuidanceOptions = {},
): string {
  const guidance = buildCommanderErrorGuidance(
    rawMessage,
    commandName,
    allowedTypes,
    context,
  );
  return renderBoundedGuidanceText(guidance, options);
}

/** Implements classify commander error for the public runtime surface of this module. */
export function classifyCommanderError(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  context?: CommanderGuidanceContext,
): ErrorClassification {
  return guidanceToClassification(
    buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context),
  );
}

/** Implements format commander error for json for the public runtime surface of this module. */
export function formatCommanderErrorForJson(
  rawMessage: string,
  commandName: string | undefined,
  allowedTypes: string,
  exitCode: number,
  context?: CommanderGuidanceContext,
): ProjectedJsonErrorEnvelope {
  return projectJsonErrorGuidance(
    buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context),
    exitCode,
  );
}

/** Implements format unknown error for json for the public runtime surface of this module. */
export function formatUnknownErrorForJson(
  rawMessage: string,
  exitCode: number,
): ProjectedJsonErrorEnvelope {
  const guidance = buildUnknownErrorGuidance(rawMessage);
  return projectJsonErrorGuidance(guidance, exitCode);
}

function buildUnknownErrorGuidance(rawMessage: string): GuidanceMessage {
  const message = normalizeMessage(rawMessage);
  if (isModuleResolutionErrorMessage(message)) {
    return makeGuidanceMessage({
      code: "module_import_failed",
      title: "Module import failed",
      happened: message,
      required:
        "Ensure the active checkout is built and any package or extension entry file exists before retrying.",
      why: "Node could not resolve an imported module. In pm this usually means an extension/package entrypoint, build artifact, or dependency is missing from the active runtime.",
      examples: [
        "pnpm build",
        "pm package manage --doctor --project",
        "pm health --check-only --json",
      ],
      nextSteps: [
        "Rebuild the checkout or package that provides the missing module.",
        "Run package doctor for installed extensions when the failure follows package installation or activation.",
        "Rerun the original pm command after the runtime files are present.",
      ],
    });
  }

  return makeGuidanceMessage({
    code: "unknown_error",
    title: "Unhandled error",
    happened: message,
    required: "Inspect command input and runtime state, then retry.",
    why: "Unexpected runtime failures can occur from environment or extension-level issues.",
    examples: ["pm --help", "pm health --json"],
  });
}

/** Implements classify unknown error for the public runtime surface of this module. */
export function classifyUnknownError(rawMessage: string): ErrorClassification {
  return guidanceToClassification(buildUnknownErrorGuidance(rawMessage));
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  applyPmCliErrorContext,
  appendIfMissing,
  buildCommanderRecoveryPayload,
  buildFallbackTitleFromMessage,
  commandExampleForRequiredOption,
  dedupeStrings,
  guidanceToClassification,
  guidanceToJsonEnvelope,
  normalizeRecoveryPayload,
  renderList,
  resolveKnownPackageCommandHint,
};
