/**
 * @module cli/error-guidance
 *
 * Provides CLI runtime support for Error Guidance.
 */
import type {
  PmCliErrorContext,
  PmCliErrorRecoveryPayload,
} from "../core/shared/errors.js";
import { renderPmCommand } from "./argv-utils.js";
import { discoverNearbyPmRoot } from "../sdk/tracker-root-discovery.js";

interface GuidanceMessage {
  code: string;
  type: string;
  title: string;
  happened: string;
  required: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
}

/** Documents the json error envelope payload exchanged by command, SDK, and package integrations. */
export interface JsonErrorEnvelope {
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
  /** Value that configures or reports recovery for this contract. */
  recovery?: PmCliErrorRecoveryPayload;
}

/** Compact an error envelope to fields that change the caller's next action. */
export function projectLeanErrorEnvelope(
  envelope: JsonErrorEnvelope,
): Omit<JsonErrorEnvelope, "required" | "why" | "title"> {
  const {
    required: _required,
    why: _why,
    title: _title,
    ...actionable
  } = envelope;
  return actionable;
}

/** Documents the error classification payload exchanged by command, SDK, and package integrations. */
export interface ErrorClassification {
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
  /** Value that configures or reports suggested retry command for this contract. */
  suggestedRetryCommand?: string;
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

function assignRecoveryStringArray(
  normalized: PmCliErrorRecoveryPayload,
  key:
    | "normalized_args"
    | "provided_fields"
    | "missing"
    | "missing_required_fields"
    | "suggested_flags",
  value: unknown,
): void {
  const values = normalizeStringArray(value);
  if (values) {
    normalized[key] = values;
  }
}

function normalizeRecoveryPayload(
  payload: PmCliErrorRecoveryPayload | undefined,
): PmCliErrorRecoveryPayload | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const normalized: PmCliErrorRecoveryPayload = {};
  if (payload.recovery_mode === "compact") {
    normalized.recovery_mode = "compact";
  }
  assignRecoveryString(
    normalized,
    "attempted_command",
    payload.attempted_command,
  );
  assignRecoveryStringArray(
    normalized,
    "normalized_args",
    payload.normalized_args,
  );
  assignRecoveryStringArray(
    normalized,
    "provided_fields",
    payload.provided_fields,
  );
  assignRecoveryStringArray(normalized, "missing", payload.missing);
  assignRecoveryStringArray(
    normalized,
    "missing_required_fields",
    payload.missing_required_fields,
  );
  assignRecoveryStringArray(
    normalized,
    "suggested_flags",
    payload.suggested_flags,
  );
  assignRecoveryString(normalized, "suggested_retry", payload.suggested_retry);
  if (
    typeof payload.retry_after_ms === "number" &&
    Number.isSafeInteger(payload.retry_after_ms) &&
    payload.retry_after_ms >= 0
  ) {
    normalized.retry_after_ms = payload.retry_after_ms;
  }
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

function renderRecoveryBundle(
  recovery: PmCliErrorRecoveryPayload | undefined,
): string[] {
  const normalized = normalizeRecoveryPayload(recovery);
  if (!normalized) {
    return [];
  }
  const lines = ["Recovery bundle:"];
  appendRecoveryTextLine(
    lines,
    "attempted_command",
    normalized.attempted_command,
  );
  appendRecoveryListLine(
    lines,
    "normalized_args",
    normalized.normalized_args,
    " ",
  );
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
  appendRecoveryTextLine(lines, "suggested_retry", normalized.suggested_retry);
  if (typeof normalized.retry_after_ms === "number") {
    lines.push(`  retry_after_ms: ${normalized.retry_after_ms}`);
  }
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

/** Implements render guidance message for the public runtime surface of this module. */
export function renderGuidanceMessage(message: GuidanceMessage): string {
  const lines: string[] = [
    `Error: ${message.title}`,
    "",
    "What happened:",
    `  ${message.happened}`,
    "",
    "What is required:",
    `  ${message.required}`,
  ];
  if (message.why) {
    lines.push("", "Why:");
    lines.push(`  ${message.why}`);
  }
  if (message.examples && message.examples.length > 0) {
    lines.push("");
    lines.push(...renderList("Examples:", message.examples));
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    lines.push("");
    lines.push(...renderList("Next steps:", message.nextSteps));
  }
  const recoveryLines = renderRecoveryBundle(message.recovery);
  if (recoveryLines.length > 0) {
    lines.push("");
    lines.push(...recoveryLines);
  }
  return lines.join("\n");
}

function guidanceToJsonEnvelope(
  message: GuidanceMessage,
  exitCode: number,
): JsonErrorEnvelope {
  const payload: JsonErrorEnvelope = {
    type: message.type,
    code: message.code,
    title: message.title,
    detail: message.happened,
    required: message.required,
    exit_code: exitCode,
  };
  if (includeWhyInStructuredGuidance(message)) {
    payload.why = message.why;
  }
  if (message.examples && message.examples.length > 0) {
    payload.examples = message.examples;
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    payload.next_steps = message.nextSteps;
  }
  if (message.recovery) {
    payload.recovery = message.recovery;
  }
  return payload;
}

function guidanceToClassification(
  message: GuidanceMessage,
): ErrorClassification {
  const payload: ErrorClassification = {
    type: message.type,
    code: message.code,
    title: message.title,
    detail: message.happened,
    required: message.required,
  };
  if (includeWhyInStructuredGuidance(message)) {
    payload.why = message.why;
  }
  if (message.examples && message.examples.length > 0) {
    payload.examples = message.examples;
  }
  if (message.nextSteps && message.nextSteps.length > 0) {
    payload.next_steps = message.nextSteps;
  }
  if (message.recovery) {
    payload.recovery = message.recovery;
  }
  return payload;
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
  const args = recovery?.normalized_args;
  if (!Array.isArray(args) || args.length === 0) {
    return undefined;
  }
  const firstCommandArg = args.find(
    (arg) => arg.trim().length > 0 && !arg.startsWith("-"),
  );
  return firstCommandArg?.trim();
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
  const fallbackTitle =
    guidance.code === "command_failed" && context.code
      ? buildFallbackTitleFromMessage(normalizedRawMessage)
      : undefined;
  const recovery =
    normalizeRecoveryPayload(context.recovery) ?? guidance.recovery;
  return {
    ...guidance,
    code,
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
    recovery,
  };
}

function buildTrackerNotInitializedGuidance(
  rawMessage: string,
  message: string,
  context: PmCliErrorContext | undefined,
): GuidanceMessage | null {
  const trackerNotInitialized = message.match(
    /^Tracker is not initialized at (.+)\. Run pm init first\.$/,
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
        'Use "pm list-open --limit 20" to find valid IDs.',
      ]
    : ["Confirm the active --path/PM_PATH scope, then retry with a valid id."];
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "item_not_found",
      title: "Item ID not found",
      happened,
      required: "Use an existing item ID from current tracker data.",
      why: "Mutation and read commands operate only on known IDs.",
      examples: ["pm list-open --limit 20", 'pm search "<keyword>" --limit 10'],
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
        'pm claim pm-a1b2 --author "codex-agent"',
        "pm update pm-a1b2 --status in_progress --force",
      ],
      nextSteps: [
        "Use --force for approved systematic metadata updates performed by leads or maintainers.",
        "Use --force when correcting known stale metadata after coordinating ownership changes.",
        'For non-terminal reassignment, prefer "pm claim <ID> --author <you>" before running other mutations.',
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
  return applyPmCliErrorContext(
    makeGuidanceMessage({
      code: "lock_conflict",
      title: "Lock conflict",
      happened: message,
      required:
        "Wait for lock release, or use --force where supported if lock is stale and safe to override.",
      why: "Locking protects item files from concurrent write races.",
      examples: [
        'pm update pm-a1b2 --status in_progress --force --author "codex-agent"',
      ],
    }),
    rawMessage,
    context,
  );
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
        'pm create --title "Task title" --description "Task details" --type Task --status open --priority 1 --message "Create task" --dep "id=pm-epic01,kind=parent,author=codex-agent,created_at=now" --comment "author=codex-agent,created_at=now,text=Why this task exists." --note "author=codex-agent,created_at=now,text=Initial implementation note." --learning "author=codex-agent,created_at=now,text=Durable lesson placeholder." --file "path=src/example.ts,scope=project" --test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240" --doc "path=README.md,scope=project"',
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
  const allowedValues = inferAllowedValuesFromMessage(message);
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

function buildUnknownOptionGuidance(
  message: string,
  commandName: string | undefined,
  context: CommanderGuidanceContext | undefined,
): GuidanceMessage | null {
  const unknownOption = message.match(/unknown option '([^']+)'/);
  if (!unknownOption) {
    return null;
  }
  const optionName = unknownOption[1];
  const suggestions = normalizeOptionFlags(context?.unknownOptionSuggestions);
  const retryCommand = context?.suggestedRetryCommand;
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
  const otherCommands = normalizeContextList(
    context?.unknownOptionOtherCommands,
  );
  const nextSteps = [
    "Run command help to confirm the exact option contracts for this command path.",
    ...(suggestions && suggestions.length > 0
      ? [`Nearest supported options: ${suggestions.join(", ")}`]
      : []),
    ...(otherCommands && otherCommands.length > 0
      ? [
          `${optionName} is a valid option on: ${otherCommands.join(", ")}. If you meant one of those, run that command instead.`,
        ]
      : []),
    ...(retryCommand
      ? [`Replay with suggested correction: ${retryCommand}`]
      : []),
  ];
  const examples = [
    ...(retryCommand ? [retryCommand] : []),
    `pm ${commandName ?? "<command>"} --help`,
  ];
  return makeGuidanceMessage({
    code: "unknown_option",
    title: `Unknown option ${optionName}`,
    happened: `Commander does not recognize option ${optionName} for this command path.`,
    required:
      "Use supported options only, or move option to the correct subcommand.",
    why: "Option contracts are command-specific and intentionally validated.",
    examples,
    nextSteps,
    recovery: buildCommanderRecoveryPayload(context, {
      suggested_flags: suggestions,
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
  if (packageHint) {
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

function buildLinkedTestValueNotQuotedGuidance(
  message: string,
  commandName: string | undefined,
  allowedTypes: string,
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
    buildLinkedTestValueNotQuotedGuidance(
      message,
      commandName,
      allowedTypes,
      context,
    ) ??
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

/** Implements format pm cli error for display for the public runtime surface of this module. */
export function formatPmCliErrorForDisplay(
  rawMessage: string,
  context?: PmCliErrorContext,
): string {
  return renderGuidanceMessage(buildPmCliErrorGuidance(rawMessage, context));
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
): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(
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
): string {
  return renderGuidanceMessage(
    buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context),
  );
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
): JsonErrorEnvelope {
  return guidanceToJsonEnvelope(
    buildCommanderErrorGuidance(rawMessage, commandName, allowedTypes, context),
    exitCode,
  );
}

/** Implements format unknown error for json for the public runtime surface of this module. */
export function formatUnknownErrorForJson(
  rawMessage: string,
  exitCode: number,
): JsonErrorEnvelope {
  const guidance = buildUnknownErrorGuidance(rawMessage);
  return guidanceToJsonEnvelope(guidance, exitCode);
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
