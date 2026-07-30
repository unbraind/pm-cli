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

const BOOLEAN_FLAG_PREFIXES = [
  "--allow-",
  "--check-",
  "--dry-run",
  "--explain",
  "--filter-",
  "--full",
  "--has-",
  "--include-",
  "--json",
  "--no-",
  "--only",
  "--quiet",
  "--require-",
  "--runtime-only",
  "--schema-only",
  "--stream",
  "--strict-",
  "--summary",
  "--today",
  "--verbose",
] as const;

function resolveFlagInputSources(
  command: string,
  flag: string,
): CliFlagInputSource[] {
  if (flag === "--stdin" || flag === "--stdin-json") return ["stdin"];
  if (flag.endsWith("-file")) return ["argv", "file"];
  if (STDIN_TOKEN_FLAGS.has(flag) && STDIN_VALUE_COMMANDS.has(command)) {
    return ["argv", "stdin"];
  }
  return ["argv"];
}

function flagTakesValue(contract: CliFlagContract): boolean {
  const explicitlyValued =
    contract.value_name !== undefined ||
    contract.value_type === "string" ||
    contract.value_type === "number" ||
    contract.list === true ||
    contract.repeatable === true;
  const inferredBoolean =
    contract.flag === "--stdin" ||
    contract.flag === "--stdin-json" ||
    BOOLEAN_FLAG_PREFIXES.some((prefix) => contract.flag.startsWith(prefix));
  return explicitlyValued || !inferredBoolean;
}

/** Enrich one vocabulary row with deterministic invocation and input-channel metadata. */
export function enrichCliFlagInvocationContract(
  command: string,
  contract: CliFlagContract,
): CliFlagInvocationContract {
  const takesValue = flagTakesValue(contract);
  const inputSources = resolveFlagInputSources(command, contract.flag);
  const description =
    contract.description ??
    FLAG_DESCRIPTIONS[contract.flag] ??
    `${takesValue ? "Set" : "Enable"} ${contract.flag.slice(2).replaceAll("-", " ")}.`;
  return {
    ...contract,
    description,
    takes_value: takesValue,
    value_required: takesValue,
    ...(takesValue
      ? { value_name: contract.value_name ?? "value" }
      : {}),
    value_type: takesValue ? (contract.value_type ?? "string") : "boolean",
    required: contract.required === true,
    repeatable: contract.repeatable === true || contract.list === true,
    input_sources: inputSources,
    ...(inputSources.includes("stdin") &&
    contract.flag !== "--stdin" &&
    contract.flag !== "--stdin-json"
      ? { stdin_token: "-" as const }
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
