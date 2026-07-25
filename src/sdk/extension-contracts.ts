/**
 * @module sdk/extension-contracts
 *
 * Publishes the stable extension capability vocabulary without loading the
 * aggregate SDK entrypoint.
 */
import {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_TRUST_MODES,
  type FlagDefinition,
} from "../core/extensions/loader.js";
import {
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  type CommanderOptionAliasContract,
} from "./cli-contracts/commander-types.js";
import {
  compactFlagAliasContracts,
  LIST_FILTER_FLAG_CONTRACTS,
  SEARCH_FLAG_CONTRACTS,
  type CliFlagContract,
} from "./cli-contracts/flag-contracts.js";

/**
 * Canonical extension capability names accepted by pm.
 *
 * Extension manifests should declare one or more of these values in
 * `capabilities`.
 */
export const EXTENSION_CAPABILITIES = KNOWN_EXTENSION_CAPABILITIES;

/** Restricts extension capability values accepted by command, SDK, and storage contracts. */
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

/** Canonical extension governance policy modes. */
export const EXTENSION_POLICY_MODES = KNOWN_EXTENSION_POLICY_MODES;

/** Canonical extension registration surfaces governed by policy. */
export const EXTENSION_POLICY_SURFACES = KNOWN_EXTENSION_POLICY_SURFACES;

/** Canonical extension trust modes shared by authoring and runtime consumers. */
export const EXTENSION_TRUST_MODES = KNOWN_EXTENSION_TRUST_MODES;

/** Canonical extension sandbox profiles shared by authoring and runtime consumers. */
export const EXTENSION_SANDBOX_PROFILES = KNOWN_EXTENSION_SANDBOX_PROFILES;

/** Restricts extension policy mode values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicyMode = (typeof EXTENSION_POLICY_MODES)[number];

/** Restricts extension policy surface values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicySurface = (typeof EXTENSION_POLICY_SURFACES)[number];

/** Restricts extension trust mode values accepted by command, SDK, and storage contracts. */
export type ExtensionTrustMode = (typeof EXTENSION_TRUST_MODES)[number];

/** Restricts extension sandbox profile values accepted by command, SDK, and storage contracts. */
export type ExtensionSandboxProfile =
  (typeof EXTENSION_SANDBOX_PROFILES)[number];

/** Build one canonical or alias flag definition from a shared CLI contract. */
function toExtensionFlagDefinition(
  contract: CliFlagContract,
  long: string,
  stringOptionKeys: ReadonlySet<string>,
  short?: string,
): FlagDefinition {
  const normalizedKey = contract.flag
    .slice(2)
    .replace(/[-_]([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );
  const stringValued = stringOptionKeys.has(normalizedKey);
  return {
    long,
    ...(short ? { short } : {}),
    description:
      contract.description ?? `Standard pm ${contract.flag} option.`,
    ...(contract.required === true ? { required: true } : {}),
    ...(contract.list === true ? { list: true } : {}),
    ...(contract.repeatable === true ? { repeatable: true } : {}),
    value_type: stringValued ? "string" : "boolean",
    ...(stringValued
      ? { value_name: contract.value_name ?? "value" }
      : {}),
  };
}

/**
 * Convert canonical CLI flag contracts into extension command definitions.
 *
 * Alias rows are expanded because extension registration deliberately stores
 * one long spelling per definition. String-valued options come from the same
 * Commander option contracts the CLI parser consumes; every other contract is
 * boolean. This keeps aliases, list accumulation, requiredness, and value
 * behavior single-sourced while giving package authors the exact shape
 * accepted by `api.registerCommand` and `api.registerFlags`.
 */
export function toExtensionFlagDefinitions(
  contracts: readonly CliFlagContract[],
  stringOptions: readonly CommanderOptionAliasContract[] = [],
): FlagDefinition[] {
  const stringOptionKeys = new Set(
    stringOptions.flatMap((contract) => contract.keys),
  );
  const definitions: FlagDefinition[] = [];
  for (const contract of compactFlagAliasContracts(
    contracts.map((entry) => ({ ...entry })),
  )) {
    definitions.push(
      toExtensionFlagDefinition(
        contract,
        contract.flag,
        stringOptionKeys,
        contract.short,
      ),
    );
    for (const alias of contract.aliases ?? []) {
      definitions.push(
        toExtensionFlagDefinition(contract, alias, stringOptionKeys),
      );
    }
  }
  return definitions;
}

/** Extension-ready form of the canonical list/filter flag baseline. */
export const LIST_FILTER_EXTENSION_FLAG_DEFINITIONS =
  toExtensionFlagDefinitions(
    LIST_FILTER_FLAG_CONTRACTS,
    LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  );

/** Extension-ready form of the canonical search flag baseline. */
export const SEARCH_EXTENSION_FLAG_DEFINITIONS =
  toExtensionFlagDefinitions(
    SEARCH_FLAG_CONTRACTS,
    SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  );

/** Versioned capability contract metadata emitted by runtime diagnostics. */
export {
  EXTENSION_CAPABILITY_CONTRACT,
  EXTENSION_CAPABILITY_CONTRACT_VERSION,
  EXTENSION_CAPABILITY_LEGACY_ALIASES,
};
