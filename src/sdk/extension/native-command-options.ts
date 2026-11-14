/**
 * @module sdk/extension/native-command-options
 *
 * The native flags a host command path owns, in the definition shape the
 * direct-caller option normalizer reads (pm-gh1727). CLI dispatch validates an
 * extension's contributed flags together with the native command's own, so a
 * direct caller (`PmClient.run`, the extension test harness) gets the same
 * allowance when an extension overrides or extends a native command.
 */
import { resolveSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";
import type { LooseCommandFlagDefinition } from "./command-options.js";

/**
 * Native flag definitions for a command path; an extension-created path
 * resolves to the shared global flags only. Every spelling Commander accepts
 * is admitted: the canonical flag with its short letter, each alias, and the
 * positive handler key a `--no-*` flag sets (`--no-truncate` sets `truncate`).
 */
export function resolveNativeCommandOptionDefinitions(commandPath: string): LooseCommandFlagDefinition[] {
  return resolveSubcommandFlagContractsForCommand(commandPath).flatMap((contract) =>
    [contract.flag, ...(contract.aliases ?? [])].flatMap((long, index): LooseCommandFlagDefinition[] => [
      index === 0 ? { long, short: contract.short } : { long },
      ...(long.startsWith("--no-") ? [{ long: `--${long.slice(5)}` }] : []),
    ]),
  );
}
