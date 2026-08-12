/**
 * @module sdk/command-recovery
 *
 * Builds executable recovery commands from tokenized argv and declared CLI
 * flag domains. Display labels are normalized back to real flag tokens and
 * supplied arguments are preserved byte-for-token.
 */
import { renderPmCommand } from "../command-line.js";
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts.js";
import { parseBootstrapCommandName } from "../cli-bootstrap.js";

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
