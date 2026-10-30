/**
 * @module sdk/command-recovery
 *
 * Builds executable recovery commands from tokenized argv and declared CLI
 * flag domains. Display labels are normalized back to real flag tokens and
 * supplied arguments are preserved byte-for-token.
 */
import { renderPmCommand } from "../command-line.js";
export { resolveLinkedResourcePositionalRecovery } from "./linked-resource-recovery.js";
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";
import { findBootstrapCommandTokenIndex, parseBootstrapCommandName } from "../cli-contracts/bootstrap-command-scanner.js";
import { READ_OUTPUT_DIMENSION_FLAGS, READ_OUTPUT_COMPOSITION_FLAGS } from "../read-output/options.js";
import { resolvePmCommandOperation } from "../cli-contracts/command-aliases.js";
import { PM_READ_OUTPUT_SURFACE_CONTRACTS, resolveReadOutputSurface } from "../read-output-contracts.js";

const READ_PROJECTION_FLAGS = new Set<string>([...Object.values(READ_OUTPUT_DIMENSION_FLAGS), ...READ_OUTPUT_COMPOSITION_FLAGS, "--full", "--brief", "--compact", "--summary", "--fields", "--section", "--token-budget"]);
const MUTATION_RECEIPT_FLAGS = new Set(["--full-changed-fields", "--no-changed-fields", "--id-only"]);

/** Explain unsupported lifecycle verbs using declared mutation flags, without authorizing or executing a guessed mutation. */
export function resolveLifecycleVerbRecovery(
  verb: string,
  availablePaths: readonly string[],
): { examples: string[][]; nextSteps: string[] } | undefined {
  if (!["block", "unblock"].includes(verb) || availablePaths.includes(verb) || !availablePaths.includes("update")) return undefined;
  const flags = new Set(resolveSubcommandFlagContractsForCommand("update").map((entry) => entry.flag));
  const requiredFlags = verb === "block" ? ["--blocked-by", "--blocked-reason"] : ["--unset", "--unblock-note"];
  if (!requiredFlags.every((flag) => flags.has(flag))) return undefined;
  return verb === "block" ? {
    examples: [["update", "<item-id>", "--blocked-by", "<blocker-id>", "--blocked-reason", "<reason>"]],
    nextSteps: ["Choose the actual item and blocker identifiers before running update. --blocked-by records the blocker field and its blocked_by relationship."],
  } : {
    examples: [["update", "<item-id>", "--unset", "blocked-by", "--unset", "blocked-reason", "--unblock-note", "<note>"]],
    nextSteps: ["Inspect the item's blockers before running update. --unset blocked-by removes the blocker field and all blocked_by relationships; --unset blocked-reason clears the stale reason. --unblock-note alone records a note and does not unblock the item.", "If your project also uses a blocked lifecycle status, choose its appropriate next status separately with update --status."],
  };
}

/** Preserve the lower time bound when activity receives the event-stream spelling. */
function activitySinceCorrection(token: string, next: string | undefined): { consumed: number; replacement: string[]; conflicts: string[] } | undefined {
  const inline = token.includes("=");
  const value = inline ? token.slice(token.indexOf("=") + 1) : next;
  if (!value || value.startsWith("--")) return undefined;
  return { consumed: inline ? 1 : 2, replacement: ["--from", value], conflicts: ["--from"] };
}

/** Completeness controls one read command declares, derived from its read-output surface and flag contracts. */
export interface ReadCompletenessControls {
  /** Canonical read-output surface. */
  command: string;
  /** Projection modes the command spells as boolean `--<mode>` flags. */
  modes: string[];
  /** Closed `--depth` value domain, empty when the command declares no detail depth. */
  depth_values: string[];
  /** Every declared flag spelling, used to refuse corrections for options the command already accepts. */
  declared_flags: string[];
}

const COMPLETENESS_CONFLICT_FLAGS = ["--depth", "--output-include", "--fields", "--section", "--for"];

/** Resolve the completeness spellings a read command accepts, so recovery never guesses from another command's vocabulary. */
export function resolveReadCompletenessControls(commandName: string): ReadCompletenessControls | undefined {
  const surface = resolveReadOutputSurface(commandName);
  const contract = PM_READ_OUTPUT_SURFACE_CONTRACTS.find((entry) => entry.command === surface);
  if (surface === undefined || contract === undefined) return undefined;
  const flags = resolveSubcommandFlagContractsForCommand(surface);
  const declared = flags.flatMap((entry) => [entry.flag, ...(entry.aliases ?? [])]);
  const modes = (contract.projection_modes ?? []).filter((mode) => declared.includes(`--${mode}`));
  const depthValues = [...(flags.find((entry) => entry.flag === "--depth")?.values ?? [])];
  if (modes.length === 0 && depthValues.length === 0) return undefined;
  return { command: surface, modes, depth_values: depthValues, declared_flags: declared };
}

/** Render one command's completeness controls as the flags an agent can type on that same command. */
export function describeReadCompletenessControls(controls: ReadCompletenessControls): string {
  return [
    ...(controls.depth_values.length > 0 ? [`--depth ${controls.depth_values.join("|")}`] : []),
    ...controls.modes.map((mode) => `--${mode}`),
  ].join(", ");
}

/** Map a completeness level between its `--<level>` and `--depth <level>` spellings on the attempted command only. */
function completenessCorrection(command: string, flag: string, token: string, next: string | undefined): { consumed: number; replacement: string[]; conflicts: string[] } | undefined {
  const controls = resolveReadCompletenessControls(command);
  if (controls === undefined || controls.declared_flags.includes(flag)) return undefined;
  const conflicts = [...COMPLETENESS_CONFLICT_FLAGS, ...controls.modes.map((mode) => `--${mode}`)].filter((entry) => entry !== flag);
  if (flag === "--depth") {
    const inline = token.includes("=");
    const value = (inline ? token.slice(token.indexOf("=") + 1) : next)?.trim().toLowerCase();
    if (!value) return undefined;
    const consumed = inline ? 1 : 2;
    if (controls.modes.includes(value)) return { consumed, replacement: [`--${value}`], conflicts };
    return value === "standard" ? { consumed, replacement: [], conflicts } : undefined;
  }
  const level = flag.slice(2);
  return token === flag && controls.depth_values.includes(level)
    ? { consumed: 1, replacement: ["--depth", level], conflicts }
    : undefined;
}

/** Keep completeness corrections distinct from detail-depth and encoding controls. */
function readOptionCorrection(command: string, flag: string, token: string, next: string | undefined): { consumed: number; replacement: string[]; conflicts: string[] } | undefined {
  if (flag === "--since" && command === "activity") return activitySinceCorrection(token, next);
  return flag === "--toon" && token === flag
    ? { consumed: 1, replacement: ["--output-format", "toon"], conflicts: ["--json", "--format", "--output-format", "--stream"] }
    : completenessCorrection(command, flag, token, next);
}

/** Resolve the invoked command, including canonical noun-first paths such as `item deps` that argv normalization emits for aliases. */
function resolveInvokedCommand(argv: readonly string[]): string | undefined {
  const index = findBootstrapCommandTokenIndex(argv);
  if (index === undefined) return undefined;
  const root = argv[index]!.trim().toLowerCase();
  const path = `${root} ${argv[index + 1]?.trim().toLowerCase() ?? ""}`;
  const namespaced = resolvePmCommandOperation(path);
  if (namespaced !== path.trim()) return namespaced;
  return root === "ctx" ? "context" : resolvePmCommandOperation(root);
}

/** Derive a same-command read retry for known completeness and encoding mistakes without discarding intent. */
export function resolveReadOptionRetryArgs(commandName: string, invocationArgv: readonly string[], unknownOption: string): string[] | undefined {
  const command = commandName === "ctx" ? "context" : resolvePmCommandOperation(commandName);
  if (resolveReadOutputSurface(command) === undefined || invocationArgv.includes("--")) return undefined;
  if (resolveInvokedCommand(invocationArgv) !== command) return undefined;
  const flag = unknownOption.split("=", 1)[0]!;
  const indices = invocationArgv.flatMap((token, index) => token === flag || token.startsWith(`${flag}=`) ? [index] : []);
  if (indices.length !== 1) return undefined;
  const index = indices[0]!;
  const correction = readOptionCorrection(command, flag, invocationArgv[index]!, invocationArgv[index + 1]);
  if (!correction) return undefined;
  const { replacement, consumed, conflicts } = correction;
  if (invocationArgv.some((argument) => conflicts.includes(argument.split("=", 1)[0]!))) return undefined;
  return [...invocationArgv.slice(0, index), ...replacement, ...invocationArgv.slice(index + consumed)];
}

/** Identify presentation intent that must not be silently dropped from an unknown-option retry. */
export function isReadProjectionRecoveryFlag(flag: string): boolean {
  const normalized = flag.split("=", 1)[0]!.replaceAll("_", "-");
  return READ_PROJECTION_FLAGS.has(normalized) || (normalized.length >= 5 && [...READ_PROJECTION_FLAGS].some((candidate) => candidate.startsWith(normalized)));
}

/** Keep lexical corrections within read projection or mutation receipt semantics. */
export function isCompatibleRecoveryFlag(requested: string, candidate: string): boolean {
  const unknownFlag = requested.split("=", 1)[0]!.replaceAll("_", "-");
  if (isReadProjectionRecoveryFlag(unknownFlag)) return !MUTATION_RECEIPT_FLAGS.has(candidate);
  if (MUTATION_RECEIPT_FLAGS.has(unknownFlag)) return !isReadProjectionRecoveryFlag(candidate);
  return true;
}

function normalizeMissingFlag(label: string): string | undefined {
  const match = label.trim().match(/--[a-z0-9][a-z0-9_-]*/i);
  return match?.[0]?.replaceAll("_", "-").toLowerCase();
}

/** Resolve a recovery command without interpreting global option values as command tokens. */
export function resolveRecoveryCommandName(
  invocationArgv: string[] | undefined,
): string | undefined {
  if (!Array.isArray(invocationArgv) || invocationArgv.length === 0) {
    return undefined;
  }
  return parseBootstrapCommandName(invocationArgv);
}

/** Resolve the truthful placeholder for a missing flag from its contract. */
export function resolveMissingOptionPlaceholder(
  commandName: string,
  missingLabel: string,
): string | null | undefined {
  const flag = normalizeMissingFlag(missingLabel);
  if (!flag) return undefined;
  const contract = resolveSubcommandFlagContractsForCommand(commandName).find(
    (entry) => entry.flag === flag || entry.aliases?.includes(flag),
  );
  if (!contract) return "<value>";
  if (contract.value_type === "boolean") {
    return null;
  }
  return `<${contract.value_name ?? "value"}>`;
}

/** Preserve an attempted argv vector and insert each missing option before `--`. */
export function renderMissingOptionRetry(
  invocationArgv: string[],
  commandName: string,
  missingLabels: string[],
): string | undefined {
  const retry = [...invocationArgv];
  const terminatorIndex = retry.indexOf("--");
  let insertionIndex = terminatorIndex < 0 ? retry.length : terminatorIndex;
  for (const label of missingLabels) {
    const flag = normalizeMissingFlag(label);
    if (
      !flag ||
      retry
        .slice(0, insertionIndex)
        .some((token) => token === flag || token.startsWith(`${flag}=`))
    ) {
      continue;
    }
    const placeholder = resolveMissingOptionPlaceholder(commandName, flag);
    const recoveredOption = placeholder ? [flag, placeholder] : [flag];
    retry.splice(insertionIndex, 0, ...recoveredOption);
    insertionIndex += recoveredOption.length;
  }
  return retry.length === invocationArgv.length
    ? undefined
    : renderPmCommand(retry);
}
