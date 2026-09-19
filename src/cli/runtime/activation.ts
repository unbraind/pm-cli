/**
 * @module cli/runtime/activation
 * Selects extension activation from static contributions and the requested command path.
 */
import { Command } from "commander";
import { resolvePmCommandOperation } from "../../sdk/cli-contracts/command-aliases.js";
import {
  type ExtensionDiscoveryResult
} from "../../sdk/runtime-primitives.js";
import {
  parseBootstrapHelpRequest,
  stripGlobalBootstrapTokens
} from "../bootstrap-args.js";
import {
  normalizeExtensionCommandPath
} from "../extension-command-help.js";
import {
  getCommandPath
} from "../registration-helpers.js";

/** Normalized command path, arguments and provided options used to select extension activation without importing extension code. */
interface RuntimeExtensionActivationProbe {
  commandPath?: string;
  commandArgs?: string[];
  allowCommandPrefixMatch?: boolean;
}

/** Collect positional words before the first option to probe the requested command path. */
function collectLeadingCommandArgs(commandArgs: readonly string[] | undefined): string[] {
  const leading: string[] = [];
  for (const arg of commandArgs ?? []) {
    if (arg.startsWith("-")) {
      break;
    }
    const normalized = normalizeExtensionCommandPath(arg);
    if (normalized.length === 0) {
      continue;
    }
    leading.push(normalized);
  }
  return leading;
}

/* c8 ignore start */

/** Match leading command paths against both native history spellings and stable extension operation identities. */
function collectActivationCommandCandidates(probe: RuntimeExtensionActivationProbe): string[] {
  /* c8 ignore next */
  const commandPath = normalizeExtensionCommandPath(probe.commandPath ?? "");
  if (commandPath.length === 0) {
    return [];
  }
  const candidates = [commandPath];
  const parts = commandPath.split(" ").filter((part) => part.length > 0);
  for (const arg of collectLeadingCommandArgs(probe.commandArgs)) {
    parts.push(...arg.split(" ").filter((part) => part.length > 0));
    candidates.push(parts.join(" "));
  }
  return [...new Set(candidates.flatMap((candidate) => [candidate, resolvePmCommandOperation(candidate)]))];
}

/** Compare an extension activation command with the normalized invocation probe. */
function activationCommandMatchesProbe(command: string, probe: RuntimeExtensionActivationProbe): boolean {
  const normalized = normalizeExtensionCommandPath(command);
  if (normalized.length === 0) {
    return false;
  }
  const candidates = collectActivationCommandCandidates(probe);
  for (const candidate of candidates) {
    if (candidate === normalized || candidate.startsWith(`${normalized} `)) {
      return true;
    }
  }
  if (probe.allowCommandPrefixMatch === true) {
    return candidates.some((candidate) => normalized.startsWith(`${candidate} `));
  }
  return false;
}

/** Read and normalize the command paths declared by an extension activation manifest. */
function extensionActivationCommands(extension: ExtensionDiscoveryResult["effective"][number]): string[] {
  const explicitCommands = extension.activation?.commands;
  if (explicitCommands) {
    return explicitCommands;
  }
  const contributions = extension.contributions;
  if (!contributions) {
    return [];
  }
  return [
    ...entriesOrEmpty(contributions.commands),
    ...entriesOrEmpty(contributions.command_handlers),
    ...entriesOrEmpty(contributions.command_overrides),
    ...entriesOrEmpty(contributions.flag_commands),
    ...entriesOrEmpty(contributions.parser_overrides),
    ...ownershipCommands(contributions.preflight_ownership),
    ...ownershipCommands(contributions.renderer_ownership),
  ];
}

/** Treat an absent registration collection as empty without copying an existing readonly collection. */
function entriesOrEmpty<T>(entries: readonly T[] | undefined): readonly T[] {
  return entries ?? [];
}

/** Flatten declared command ownership so activation can select only packages relevant to an invocation. */
function ownershipCommands(entries: readonly { commands: readonly string[] }[] | undefined): string[] {
  return entriesOrEmpty(entries).flatMap((entry) => entry.commands);
}

/** Collect the capabilities declared by one discovered extension. */
function extensionCapabilities(extension: ExtensionDiscoveryResult["effective"][number]): Set<string> {
  /* c8 ignore next */
  return new Set((extension.capabilities ?? []).map((capability) => capability.trim().toLowerCase()));
}

const GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES = new Set(["hooks", "parser", "preflight", "renderers"]);

// Capabilities that register command handlers whose names are not statically
// known without declared `activation.commands`, so the extension must activate
// for any command probe. `importers`/`exporters` register their import/export as
// command handlers, so they belong here alongside commands/schema/services.
const CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES = new Set(["commands", "schema", "services", "importers"]);

const SEARCH_EXTENSION_ACTIVATION_COMMANDS = new Set(["reindex", "search", "search-advanced"]);

const CREATE_TEMPLATE_FLAGS = new Set(["--template"]);

/** Test whether any declared capability belongs to the capability family required by an invocation. */
function hasAnyCapability(capabilities: Set<string>, expected: Set<string>): boolean {
  for (const capability of expected) {
    if (capabilities.has(capability)) {
      return true;
    }
  }
  return false;
}

/** Identify command paths that require search provider or vector-store registrations. */
function commandPathNeedsSearchExtensions(commandPath: string | undefined): boolean {
  const normalized = normalizeExtensionCommandPath(commandPath ?? "");
  if (normalized.length === 0) {
    return false;
  }
  const [topLevel] = normalized.split(" ");
  /* c8 ignore next */
  return SEARCH_EXTENSION_ACTIVATION_COMMANDS.has(topLevel ?? normalized);
}

/** Check the provided invocation flags against one activation-sensitive flag family. */
function probeUsesAnyFlag(probe: RuntimeExtensionActivationProbe, flags: Set<string>): boolean {
  /* c8 ignore next */
  for (const arg of probe.commandArgs ?? []) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [flagName] = arg.split("=", 1);
    if (flags.has(flagName)) {
      return true;
    }
  }
  return false;
}

/* c8 ignore stop */

/** Identify invocations that consume extension-provided create templates. */
function commandPathNeedsTemplateExtensions(probe: RuntimeExtensionActivationProbe): boolean {
  return normalizeExtensionCommandPath(probe.commandPath ?? "") === "create" && probeUsesAnyFlag(probe, CREATE_TEMPLATE_FLAGS);
}

/** Recognize runtime template contributions that require extension activation. */
function extensionProvidesTemplatesRuntime(commands: readonly string[]): boolean {
  return commands.some((command) => {
    const normalized = normalizeExtensionCommandPath(command);
    return normalized === "templates" || normalized.startsWith("templates ");
  });
}

/** Match direct command paths plus the built-in create-template bridge. */
function matchesStaticExtensionCommand(commands: readonly string[], probe: RuntimeExtensionActivationProbe): boolean {
  return commands.some((command) => activationCommandMatchesProbe(command, probe)) || (commandPathNeedsTemplateExtensions(probe) && extensionProvidesTemplatesRuntime(commands));
}

/** Identify contribution surfaces that participate in global runtime behavior. */
function hasGlobalExtensionContributions(contributions: NonNullable<ExtensionDiscoveryResult["effective"][number]["contributions"]>): boolean {
  const contributionCounts = [
    entriesOrEmpty(contributions.hooks).length,
    (contributions.preflight_overrides ?? 0) - entriesOrEmpty(contributions.preflight_ownership).length,
    entriesOrEmpty(contributions.item_types).length,
    entriesOrEmpty(contributions.item_fields).length,
    entriesOrEmpty(contributions.relationship_kinds).length,
    entriesOrEmpty(contributions.service_overrides).length,
    entriesOrEmpty(contributions.assurance_providers).length,
    entriesOrEmpty(contributions.renderer_overrides).length - entriesOrEmpty(contributions.renderer_ownership).length,
  ];
  return contributionCounts.some((count) => count > 0);
}

/** Resolve an exact activation verdict from declared commands and contributions. */
function resolveStaticExtensionActivationDecision(extension: ExtensionDiscoveryResult["effective"][number], probe: RuntimeExtensionActivationProbe): boolean | undefined {
  const explicitCommands = extension.activation?.commands ?? [];
  if (explicitCommands.length > 0) {
    return matchesStaticExtensionCommand(explicitCommands, probe);
  }
  const commands = extensionActivationCommands(extension);
  if (matchesStaticExtensionCommand(commands, probe)) return true;
  if (extensionCapabilities(extension).has("search") && commandPathNeedsSearchExtensions(probe.commandPath)) {
    return true;
  }
  if (extension.contributions) {
    return hasGlobalExtensionContributions(extension.contributions);
  }
  return undefined;
}

/** Combine static contributions and capability fallbacks to decide whether one extension must activate. */
function extensionNeedsActivationForProbe(extension: ExtensionDiscoveryResult["effective"][number], probe: RuntimeExtensionActivationProbe): boolean {
  const staticDecision = resolveStaticExtensionActivationDecision(extension, probe);
  if (staticDecision !== undefined) return staticDecision;
  const capabilities = extensionCapabilities(extension);

  if (hasAnyCapability(capabilities, GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES)) {
    return true;
  }

  // Without declared activation commands the contributed command names are
  // unknown, so any command-bearing capability (commands/schema/services and
  // importers/exporters, all of which register command handlers) must activate
  // for the probe — the invoked command could be one it registers. Activation
  // stays lazy once the extension declares `activation.commands` (handled by the
  // exact-match path above).
  if (hasAnyCapability(capabilities, CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES)) {
    return true;
  }

  return false;
}

/** Decide whether installed providers must activate for a targeted invocation or complete command discovery. */
function discoveryNeedsActivationForProbe(discovery: ExtensionDiscoveryResult, probe: RuntimeExtensionActivationProbe): boolean {
  if (discovery.effective.length === 0) {
    return false;
  }
  const hasCommandProbe = buildRuntimeExtensionActivationScope(probe) !== "all";
  if (!hasCommandProbe) {
    return discovery.effective.some((extension) => {
      const capabilities = extensionCapabilities(extension);
      return (
        extensionActivationCommands(extension).length > 0 ||
        hasAnyCapability(capabilities, GLOBAL_EXTENSION_ACTIVATION_CAPABILITIES) ||
        hasAnyCapability(capabilities, CONSERVATIVE_EXTENSION_ACTIVATION_CAPABILITIES) ||
        capabilities.has("search")
      );
    });
  }
  return discovery.effective.some((extension) => extensionNeedsActivationForProbe(extension, probe));
}

/** Build a deterministic activation scope; completion and unconstrained discovery include every installed command provider. */
function buildRuntimeExtensionActivationScope(probe: RuntimeExtensionActivationProbe): string {
  // Completion discovers every installed command, including commands owned by
  // packages other than the package providing the completion renderer.
  if (normalizeExtensionCommandPath(probe.commandPath ?? "").split(" ")[0] === "completion") {
    return "all";
  }
  const commandPath =
    collectActivationCommandCandidates(probe)
      .filter((candidate) => candidate.split(" ").every((part) => !part.startsWith("-")))
      .sort((left, right) => right.length - left.length)[0] ?? normalizeExtensionCommandPath(probe.commandPath ?? "");
  if (commandPath.length === 0) {
    return "all";
  }
  const args = commandPathNeedsTemplateExtensions(probe) ? "--template" : "";
  const prefix = probe.allowCommandPrefixMatch === true ? "prefix" : "exact";
  return `${prefix}:${commandPath}:${args}`;
}

/** Create the loader predicate for extensions needed by the current invocation. */
function buildRuntimeExtensionFilterForProbe(probe: RuntimeExtensionActivationProbe): ((extension: ExtensionDiscoveryResult["effective"][number]) => boolean) | undefined {
  return buildRuntimeExtensionActivationScope(probe) === "all" ? undefined : (extension) => extensionNeedsActivationForProbe(extension, probe);
}

/** Build an activation probe from bootstrap argv before Commander registration. */
function buildBootstrapActivationProbe(invocationArgv: string[]): RuntimeExtensionActivationProbe {
  const helpRequest = parseBootstrapHelpRequest(invocationArgv);
  if (helpRequest.requested && helpRequest.commandPathTokens.length > 0) {
    const [commandPath, ...commandArgs] = helpRequest.commandPathTokens;
    return {
      commandPath,
      commandArgs,
      allowCommandPrefixMatch: true,
    };
  }

  const stripped = stripGlobalBootstrapTokens(invocationArgv);
  const commandIndex = stripped.findIndex((token) => token.trim().length > 0 && !token.startsWith("-"));
  if (commandIndex < 0) {
    return {};
  }
  return {
    commandPath: stripped[commandIndex],
    commandArgs: stripped.slice(commandIndex + 1),
    allowCommandPrefixMatch: helpRequest.requested,
  };
}

/* c8 ignore start */

/** Collect the command arguments retained by Commander for an activation probe. */
function collectParsedActivationCommandArgs(command: Command): string[] {
  const commandArgs = command.args.map(String);
  const commandPath = normalizeExtensionCommandPath(getCommandPath(command));
  if (commandPath === "create") {
    const options = command.optsWithGlobals() as Record<string, unknown>;
    /* c8 ignore next */
    if (typeof options.template === "string" && options.template.trim().length > 0) {
      commandArgs.push("--template");
    }
  }
  return commandArgs;
}

/* c8 ignore stop */

export { RuntimeExtensionActivationProbe,activationCommandMatchesProbe,buildBootstrapActivationProbe,buildRuntimeExtensionActivationScope,buildRuntimeExtensionFilterForProbe,collectActivationCommandCandidates,collectLeadingCommandArgs,collectParsedActivationCommandArgs,commandPathNeedsSearchExtensions,commandPathNeedsTemplateExtensions,discoveryNeedsActivationForProbe,extensionActivationCommands,extensionCapabilities,extensionNeedsActivationForProbe,extensionProvidesTemplatesRuntime,hasAnyCapability,hasGlobalExtensionContributions,matchesStaticExtensionCommand,probeUsesAnyFlag,resolveStaticExtensionActivationDecision };
