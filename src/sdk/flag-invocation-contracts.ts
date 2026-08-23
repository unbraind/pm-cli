/**
 * @module sdk/flag-invocation-contracts
 *
 * Compiles flag vocabulary into a complete machine-readable invocation model.
 */
import type { CliFlagContract } from "./cli-contracts.js";

/** Supported channels through which a flag obtains its value. */
export type CliFlagInputSource = "argv" | "file" | "stdin";

/** Complete invocation semantics for one accepted CLI flag. */
export interface CliFlagInvocationContract extends CliFlagContract {
  /** Human-readable behavior, always present for generated surfaces. */
  description: string;
  /** Whether the option consumes a value token. */
  takes_value: boolean;
  /** Whether omission of the consumed value is invalid. */
  value_required: boolean;
  /** Machine value type after CLI parsing. */
  value_type: "string" | "number" | "boolean";
  /** Whether the option itself is required. */
  required: boolean;
  /** Whether repeated occurrences accumulate. */
  repeatable: boolean;
  /** Accepted value channels. */
  input_sources: CliFlagInputSource[];
  /** Sentinel that redirects the argv value to stdin. */
  stdin_token?: "-";
  /** Prefix that redirects the argv value to a file path. */
  file_token_prefix?: "@";
}

/** Executable option arity observed from the registered Commander program. */
export interface CliFlagArityObservation {
  /** Canonical command path owning the option. */
  command: string;
  /** Long option spelling. */
  flag: string;
  /** Whether the option consumes a value token. */
  takes_value: boolean;
  /** Whether the consumed value is mandatory. */
  value_required: boolean;
  /** Whether repeated values accumulate. */
  repeatable: boolean;
}

/** One machine-readable mismatch between declared and executable flag arity. */
export interface CliFlagInvocationParityFinding {
  /** Stable finding code. */
  code:
    | "duplicate_observation"
    | "missing_observation"
    | "takes_value_mismatch"
    | "value_required_mismatch"
    | "repeatable_mismatch"
    | "undeclared_observation";
  /** Canonical command path. */
  command: string;
  /** Long option spelling. */
  flag: string;
  /** Human-readable mismatch detail. */
  detail: string;
}

/** Complete parity receipt for one command's declared and executable flags. */
export interface CliFlagInvocationParityReport {
  /** Whether the two surfaces agree exactly. */
  ok: boolean;
  /** Number of declared invocation rows. */
  declared_count: number;
  /** Number of executable observations. */
  observed_count: number;
  /** Stable mismatch list. */
  findings: CliFlagInvocationParityFinding[];
}

const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "--body": "Set the item body.",
  "--body-file": "Read the item body from a file.",
  "--description": "Set the item description.",
  "--stdin": "Read the value from stdin.",
  "--stdin-json": "Read a complete JSON document from stdin.",
});

const STDIN_TOKEN_FLAGS = new Set([
  "--add",
  "--body",
  "--comment",
  "--dep",
  "--description",
  "--doc",
  "--field",
  "--file",
  "--learning",
  "--note",
  "--remove",
  "--test",
  "--type-option",
]);

const STDIN_VALUE_COMMANDS = new Set([
  "append",
  "comments",
  "create",
  "docs",
  "files",
  "learnings",
  "notes",
  "test",
  "update",
]);

const FILE_OR_STDIN_COMMAND_FLAGS = new Set([
  "close-many:--ids",
  "comments:--file",
  "create:--body-file",
  "history-compact:--ids",
  "learnings:--file",
  "notes:--file",
  "update:--body-file",
  "update-many:--ids",
]);

const AT_PATH_FILE_COMMAND_FLAGS = new Set([
  "close-many:--ids",
  "history-compact:--ids",
  "update-many:--ids",
]);

const BOOLEAN_FLAG_PREFIXES = [
  "--allow-",
  "--check-",
  "--dry-run",
  "--explain",
  "--fail-",
  "--fix-",
  "--full",
  "--has-",
  "--include-",
  "--json",
  "--no-",
  "--prune-",
  "--quiet",
  "--refresh-",
  "--require-",
  "--runtime-only",
  "--schema-only",
  "--skip-",
  "--stream",
  "--strict-",
  "--summary",
  "--today",
  "--verbose",
] as const;

const BOOLEAN_FLAG_NAMES = new Set([
  "--activate",
  "--active-only",
  "--adopt",
  "--adopt-all",
  "--all",
  "--all-actionable",
  "--all-affected-ids",
  "--all-day",
  "--all-streams",
  "--acknowledge-linked-tests",
  "--append-stable",
  "--auto-fix",
  "--auto-pm-context",
  "--availability-only",
  "--background",
  "--brief",
  "--by-assignee",
  "--by-priority",
  "--by-tag",
  "--catalog",
  "--claim",
  "--clear",
  "--clear-comments",
  "--clear-criteria",
  "--clear-deps",
  "--clear-docs",
  "--clear-events",
  "--clear-files",
  "--clear-learnings",
  "--clear-notes",
  "--clear-reminders",
  "--clear-tests",
  "--clear-type-options",
  "--cli-only",
  "--closed",
  "--compact",
  "--completion",
  "--count",
  "--counts",
  "--deactivate",
  "--declarative",
  "--defaults",
  "--describe",
  "--diff",
  "--doctor",
  "--empty-body",
  "--explore",
  "--field-utilization",
  "--filter-empty-body",
  "--flags-only",
  "--follow",
  "--force",
  "--global",
  "--highlight",
  "--hybrid",
  "--id-only",
  "--if-available",
  "--ignore-global",
  "--include_unparented",
  "--infer",
  "--init",
  "--install",
  "--isolated",
  "--lean",
  "--list",
  "--local",
  "--manage",
  "--markdown",
  "--metadata-coverage",
  "--next",
  "--normalize-provenance",
  "--only",
  "--only-last",
  "--output-row-contract",
  "--override-linked-pm-context",
  "--override-linked-workspace-context",
  "--packages-only",
  "--past",
  "--phrase-exact",
  "--profile",
  "--progress",
  "--project",
  "--promote-to-item-dep",
  "--provenance",
  "--provenance-summary",
  "--raw",
  "--ready-only",
  "--ready_only",
  "--rebuild",
  "--recent",
  "--reload",
  "--repair",
  "--replace-deps",
  "--replace-docs",
  "--replace-files",
  "--replace-tests",
  "--required",
  "--required-on-create",
  "--run",
  "--runtime-probe",
  "--save-baseline",
  "--scaffold",
  "--semantic",
  "--shared-host-safe",
  "--storage",
  "--title-exact",
  "--token-accounting",
  "--trace",
  "--tree",
  "--unbounded",
  "--uninstall",
  "--validate-paths",
  "--verify",
  "--watch",
  "--with-packages",
]);

const VALUE_FLAG_NAMES = new Set(["--only-index"]);

const VALUE_COMMAND_FLAGS = new Set([
  "activity:--stream",
  "eval:--fail-under",
  "validate:--fix-scope",
]);

const OPTIONAL_VALUE_COMMAND_FLAGS = new Set([
  "activity:--stream",
  "close:--validate-close",
  "close-many:--validate-close",
  "comments:--author",
  "learnings:--author",
  "notes:--author",
]);

const OPTIONAL_VALUE_FLAGS = new Set(["--regression"]);

function resolveFlagInputSources(
  command: string,
  flag: string,
): CliFlagInputSource[] {
  if (flag === "--stdin" || flag === "--stdin-json") return ["stdin"];
  if (FILE_OR_STDIN_COMMAND_FLAGS.has(`${command}:${flag}`)) {
    return ["argv", "file", "stdin"];
  }
  if (flag.endsWith("-file")) return ["argv", "file"];
  if (STDIN_TOKEN_FLAGS.has(flag) && STDIN_VALUE_COMMANDS.has(command)) {
    return ["argv", "stdin"];
  }
  return ["argv"];
}

function flagTakesValue(command: string, contract: CliFlagContract): boolean {
  const explicitlyValued =
    VALUE_COMMAND_FLAGS.has(`${command}:${contract.flag}`) ||
    contract.value_name !== undefined ||
    contract.value_type === "string" ||
    contract.value_type === "number" ||
    contract.list === true ||
    contract.repeatable === true;
  const inferredBoolean =
    contract.value_type === "boolean" ||
    contract.flag === "--stdin" ||
    contract.flag === "--stdin-json" ||
    (contract.flag.startsWith("--filter-") &&
      (contract.flag.endsWith("-missing") ||
        contract.flag.startsWith("--filter-has-") ||
        contract.flag.startsWith("--filter-no-"))) ||
    BOOLEAN_FLAG_PREFIXES.some((prefix) => contract.flag.startsWith(prefix));
  return (
    explicitlyValued ||
    VALUE_FLAG_NAMES.has(contract.flag) ||
    (!BOOLEAN_FLAG_NAMES.has(contract.flag) && !inferredBoolean)
  );
}

/** Enrich one vocabulary row with deterministic invocation and input-channel metadata. */
export function enrichCliFlagInvocationContract(
  command: string,
  contract: CliFlagContract,
): CliFlagInvocationContract {
  const takesValue = flagTakesValue(command, contract);
  const inputSources = resolveFlagInputSources(command, contract.flag);
  const description =
    contract.description ??
    FLAG_DESCRIPTIONS[contract.flag] ??
    `${takesValue ? "Set" : "Enable"} ${contract.flag.slice(2).replaceAll("-", " ")}.`;
  return {
    ...contract,
    description,
    takes_value: takesValue,
    value_required:
      takesValue &&
      !OPTIONAL_VALUE_FLAGS.has(contract.flag) &&
      !OPTIONAL_VALUE_COMMAND_FLAGS.has(`${command}:${contract.flag}`),
    ...(takesValue ? { value_name: contract.value_name ?? "value" } : {}),
    value_type: takesValue ? (contract.value_type ?? "string") : "boolean",
    required: contract.required === true,
    repeatable: contract.repeatable === true || contract.list === true,
    input_sources: inputSources,
    ...(inputSources.includes("stdin") &&
    contract.flag !== "--stdin" &&
    contract.flag !== "--stdin-json"
      ? { stdin_token: "-" as const }
      : {}),
    ...(AT_PATH_FILE_COMMAND_FLAGS.has(`${command}:${contract.flag}`)
      ? { file_token_prefix: "@" as const }
      : {}),
  };
}

/** Enrich a complete command flag table without mutating package-owned rows. */
export function enrichCliFlagInvocationContracts(
  command: string,
  contracts: readonly CliFlagContract[],
): CliFlagInvocationContract[] {
  return contracts.map((contract) =>
    enrichCliFlagInvocationContract(command, contract),
  );
}

/** Compare generated invocation rows with independently observed executable arity. */
export function verifyCliFlagInvocationParity(
  command: string,
  declarations: readonly CliFlagInvocationContract[],
  observations: readonly CliFlagArityObservation[],
): CliFlagInvocationParityReport {
  const normalizedCommand = command.trim().toLowerCase();
  const findings: CliFlagInvocationParityFinding[] = [];
  const observedByFlag = new Map<string, CliFlagArityObservation>();
  let matchingObservationCount = 0;
  for (const observation of observations) {
    if (observation.command.trim().toLowerCase() !== normalizedCommand)
      continue;
    matchingObservationCount += 1;
    if (observedByFlag.has(observation.flag)) {
      findings.push({
        code: "duplicate_observation",
        command: normalizedCommand,
        flag: observation.flag,
        detail: `${normalizedCommand} ${observation.flag} was observed more than once.`,
      });
      continue;
    }
    observedByFlag.set(observation.flag, observation);
  }
  const declaredFlags = new Set(declarations.map(({ flag }) => flag));
  for (const declaration of declarations) {
    const observation = observedByFlag.get(declaration.flag);
    if (!observation) {
      findings.push({
        code: "missing_observation",
        command: normalizedCommand,
        flag: declaration.flag,
        detail: `${normalizedCommand} ${declaration.flag} has no executable option observation.`,
      });
      continue;
    }
    for (const [field, code] of [
      ["takes_value", "takes_value_mismatch"],
      ["value_required", "value_required_mismatch"],
      ["repeatable", "repeatable_mismatch"],
    ] as const) {
      if (declaration[field] === observation[field]) continue;
      findings.push({
        code,
        command: normalizedCommand,
        flag: declaration.flag,
        detail: `${normalizedCommand} ${declaration.flag} declares ${field}=${String(declaration[field])} but the executable option reports ${String(observation[field])}.`,
      });
    }
  }
  for (const observation of observedByFlag.values()) {
    if (declaredFlags.has(observation.flag)) continue;
    findings.push({
      code: "undeclared_observation",
      command: normalizedCommand,
      flag: observation.flag,
      detail: `${normalizedCommand} ${observation.flag} is executable but absent from invocation contracts.`,
    });
  }
  findings.sort(
    (left, right) =>
      left.flag.localeCompare(right.flag) ||
      left.code.localeCompare(right.code),
  );
  return {
    ok: findings.length === 0,
    declared_count: declarations.length,
    observed_count: matchingObservationCount,
    findings,
  };
}
