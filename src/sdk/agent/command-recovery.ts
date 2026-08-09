/**
 * @module sdk/command-recovery
 *
 * Builds executable recovery commands from tokenized argv and declared CLI
 * flag domains. Display labels are normalized back to real flag tokens and
 * supplied arguments are preserved byte-for-token.
 */
import { renderPmCommand } from "../command-line.js";
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts.js";

function normalizeMissingFlag(label: string): string | undefined {
  const match = label.trim().match(/--[a-z0-9][a-z0-9_-]*/i);
  return match?.[0]?.replaceAll("_", "-").toLowerCase();
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

/** Preserve an attempted argv vector and append each missing option once. */
export function renderMissingOptionRetry(
  invocationArgv: string[],
  commandName: string,
  missingLabels: string[],
): string | undefined {
  const retry = [...invocationArgv];
  for (const label of missingLabels) {
    const flag = normalizeMissingFlag(label);
    if (
      !flag ||
      retry.some((token) => token === flag || token.startsWith(`${flag}=`))
    ) {
      continue;
    }
    retry.push(flag);
    const placeholder = resolveMissingOptionPlaceholder(commandName, flag);
    if (placeholder) retry.push(placeholder);
  }
  return retry.length === invocationArgv.length
    ? undefined
    : renderPmCommand(retry);
}
