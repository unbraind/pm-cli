/**
 * @module sdk/lifecycle/core-field-recovery
 * Resolves core-field refusal guidance from executable mutation registrations.
 */
import type { PmCliErrorContext } from "../../core/shared/errors.js";
import type { RuntimeFieldRegistry } from "../../core/schema/runtime-schema.js";
import { normalizeStatusToken } from "../../core/schema/status-token.js";
import { commanderOptionAttribute, readRuntimeFieldOptionValue, runtimeFieldCliFlagRoute, runtimeFieldFlagToken, runtimeFieldSdkOptionName } from "../../core/schema/runtime-field-values.js";
import { GLOBAL_FLAG_CONTRACTS, resolveSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";
import type { UpdateCommandOptions } from "./update.js";

/**
 * Update options the host reads that no CLI flag declares: a routing hint
 * must never name them. A spec pins this set against the keys
 * normalizeUpdateOptions writes, so a new internal key cannot be missed.
 */
const UPDATE_SDK_ONLY_OPTION_KEYS = [
  "documentAnnotationSnapshot",
  "runtimeFieldCommands",
  "ownershipMetadataBypass",
  "ownershipDependencyBypass",
] as const satisfies ReadonlyArray<keyof UpdateCommandOptions>;
import { ITEM_MUTATION_FACET_OPTION_MAPPINGS } from "./mutation-facet-contracts.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
} from "../cli-contracts/commander-mutation-options.js";

/** Name only declared mutation routes; storage keys never imply CLI flags. */
export function resolveCoreFieldRecovery(field: string): Pick<PmCliErrorContext, "recovery" | "nextSteps"> {
  const target = ITEM_MUTATION_FACET_OPTION_MAPPINGS.find(([metadataKey]) => metadataKey === field)?.[1]
    ?? field.replaceAll(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const routes = ([
    ["update", UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS],
    ["create", CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS],
  ] as const).flatMap(([command, contracts]) => contracts.flatMap((contract) => {
    if (contract.target !== target) return [];
    const flag = contract.option.match(/--[a-z][a-z0-9-]*/u)![0];
    return [{ command, flag }];
  }));
  return {
    recovery: {
      provided_fields: [field],
      ...(routes.length > 0 ? { suggested_flags: [...new Set(routes.map((route) => route.flag))] } : {}),
    },
    nextSteps: routes.length > 0
      ? routes.map(({ command, flag }) => `Use the declared core mutation: pm ${command}${command === "update" ? " <id>" : ""} ${flag} <value>; inspect its help for other required options.`)
      : [`No dedicated create/update CLI mutation flag is declared for "${field}". Use its owning lifecycle, evidence, or importer API; --field cannot mutate core metadata.`],
  };
}

/** Mutation scopes whose `--field` refusals route project-schema keys. */
type SchemaFieldRecoveryCommand = "create" | "update" | "update_many";

/** How each scope is invoked: CLI command, its usage shape, and where SDK options go. */
const SCHEMA_FIELD_COMMAND_SURFACE: Readonly<Record<SchemaFieldRecoveryCommand, { name: string; usage: string; sdkScope: string }>> = {
  create: { name: "create", usage: "pm create", sdkScope: "create options" },
  update: { name: "update", usage: "pm update <id>", sdkScope: "update options" },
  update_many: { name: "update-many", usage: "pm update-many <selection flags>", sdkScope: "update options of the update-many request" },
};

/** Long, short and alias spellings a list of flag contracts declares. */
function contractFlagSpellings(contracts: ReadonlyArray<{ flag: string; short?: string; aliases?: readonly string[] }>): string[] {
  return contracts.flatMap((contract) => [contract.flag, ...(contract.short === undefined ? [] : [contract.short]), ...(contract.aliases ?? [])]);
}

/**
 * Option names and long flags the host itself owns for a mutation command:
 * every flag the command's contract declares (including directly registered
 * controls such as --force and --clear-tests), global flags, the option
 * registration targets, and SDK-only option keys. Bulk update rows run
 * through pm update's option surface, so update-many reserves that set plus
 * its own selection flags.
 */
export function hostOwnedOptions(command: SchemaFieldRecoveryCommand): { options: ReadonlySet<string>; flags: ReadonlySet<string> } {
  if (command === "update_many") {
    const row = hostOwnedOptions("update");
    const bulkFlags = contractFlagSpellings(resolveSubcommandFlagContractsForCommand("update-many"));
    return {
      options: new Set([...row.options, ...bulkFlags.map((flag) => commanderOptionAttribute(flag))]),
      flags: new Set([...row.flags, ...bulkFlags]),
    };
  }
  const contracts = command === "update" ? UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS : CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS;
  const flags = contractFlagSpellings([
    ...resolveSubcommandFlagContractsForCommand(command),
    ...GLOBAL_FLAG_CONTRACTS,
  ]);
  const options = [
    ...contracts.flatMap((contract) => [contract.target, ...contract.keys]),
    ...flags.map((flag) => commanderOptionAttribute(flag)),
    ...(command === "update" ? UPDATE_SDK_ONLY_OPTION_KEYS : []),
  ];
  return { options: new Set(options), flags: new Set(flags) };
}

/** Name the SDK option only when it selects this field alone. */
function sdkOptionHint(option: string | undefined, command: SchemaFieldRecoveryCommand): string {
  const surface = SCHEMA_FIELD_COMMAND_SURFACE[command];
  return option === undefined
    ? `SDK: every option name for this field is shared with another declared field or an option of pm ${surface.name}; no SDK option sets it alone.`
    : `SDK: pass ${option} in the ${surface.sdkScope}.`;
}

/**
 * Whether the invocation already sets this storage key through a declared
 * spelling, read exactly as the mutation reads it (any flag, alias, or SDK
 * option of any declaration this scope applies).
 */
function invocationSetsStorageKey(
  registry: RuntimeFieldRegistry,
  definition: RuntimeFieldRegistry["definitions"][number],
  command: SchemaFieldRecoveryCommand,
  invocationOptions: Record<string, unknown>,
): boolean {
  return registry.definitions.some((candidate) =>
    candidate.metadata_key === definition.metadata_key &&
    candidate.commands.includes(command) &&
    readRuntimeFieldOptionValue(invocationOptions, candidate) !== undefined);
}

/**
 * Route a `--field` key that the project schema declares (pm-wftvem): such
 * keys are set through their declared CLI flag or SDK option, never through
 * the extension item-field channel. Returns undefined for undeclared keys so
 * extension-field admission keeps its own refusal. When the invocation's
 * options are supplied and, apart from the refused `--field` input itself,
 * already set the key through a declared spelling, no route is advertised: a
 * retry would carry two values for one field.
 */
export function createSchemaFieldRecoveryResolver(
  registry: RuntimeFieldRegistry,
  command: SchemaFieldRecoveryCommand,
  invocationOptions?: Record<string, unknown>,
): (field: string) => Pick<PmCliErrorContext, "recovery" | "nextSteps"> | undefined {
  const surface = SCHEMA_FIELD_COMMAND_SURFACE[command];
  // The refused --field input is not an independent value: a declaration that
  // reads the `field` option would otherwise find the assignment being refused.
  const independentOptions = invocationOptions === undefined
    ? undefined
    : Object.fromEntries(Object.entries(invocationOptions).filter(([key]) => key !== "field"));
  return (field) => {
    // Declared keys are stored normalized, so compare through the same normalizer.
    const token = normalizeStatusToken(field);
    const matches = registry.definitions.filter(
      (candidate) => candidate.metadata_key === token || candidate.key === token,
    );
    // Several declarations can share a storage key; route through one this command may set.
    const definition = matches.find((candidate) => candidate.commands.includes(command)) ?? matches[0];
    if (definition === undefined) return undefined;
    const inspect = `Inspect the value contract with: pm schema show-field ${definition.key}`;
    if (!definition.commands.includes(command)) {
      return {
        recovery: { provided_fields: [field] },
        nextSteps: [
          `The project schema declares "${definition.key}" for ${definition.commands.join(", ")} only; ${surface.name} cannot set it.`,
          inspect,
        ],
      };
    }
    if (independentOptions !== undefined && invocationSetsStorageKey(registry, definition, command, independentOptions)) {
      return {
        recovery: { provided_fields: [field] },
        nextSteps: [
          `This invocation already sets "${definition.key}" through a declared flag or option; drop the --field ${field} assignment so the field receives one value.`,
          inspect,
        ],
      };
    }
    // Advertise only routes that set this field alone: no other declared field
    // and no host option may read the same parsed option name.
    const host = hostOwnedOptions(command);
    const route = runtimeFieldCliFlagRoute(definition, registry, host, command);
    const cliStep = route === undefined
      ? `Every CLI spelling of "${definition.key}" is shared with another declared field or an option of pm ${surface.name}; give it a distinct cli_flag in the project schema.`
      : `Use the declared project-schema flag: ${surface.usage} ${runtimeFieldFlagToken(route)} <value>`;
    return {
      recovery: { provided_fields: [field], ...(route === undefined ? {} : { suggested_flags: [runtimeFieldFlagToken(route)] }) },
      nextSteps: [cliStep, sdkOptionHint(runtimeFieldSdkOptionName(definition, registry, host.options, command), command), inspect],
    };
  };
}
