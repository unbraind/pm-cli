/**
 * @module sdk/command-recovery
 *
 * Builds executable recovery commands from tokenized argv and declared CLI
 * flag domains. Display labels are normalized back to real flag tokens and
 * supplied arguments are preserved byte-for-token.
 */
import { renderPmCommand } from "../command-line.js";
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";
import { parseBootstrapCommandName } from "../cli-contracts/bootstrap-command-scanner.js";
import { READ_OUTPUT_DIMENSION_FLAGS, READ_OUTPUT_COMPOSITION_FLAGS } from "../read-output/options.js";

const READ_PROJECTION_FLAGS = new Set<string>([...Object.values(READ_OUTPUT_DIMENSION_FLAGS), ...READ_OUTPUT_COMPOSITION_FLAGS, "--full", "--brief", "--compact", "--summary", "--fields", "--section", "--token-budget"]);
const MUTATION_RECEIPT_FLAGS = new Set(["--full-changed-fields", "--no-changed-fields", "--id-only"]);

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
