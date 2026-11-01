/**
 * @module sdk/lifecycle/core-field-recovery
 * Resolves core-field refusal guidance from executable mutation registrations.
 */
import type { PmCliErrorContext } from "../../core/shared/errors.js";
import type { RuntimeFieldRegistry } from "../../core/schema/runtime-schema.js";
import { normalizeStatusToken } from "../../core/schema/status-token.js";
import { runtimeFieldSdkOptionName } from "../../core/schema/runtime-field-values.js";
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

/**
 * Route a `--field` key that the project schema declares (pm-wftvem): such
 * keys are set through their declared CLI flag or SDK option, never through
 * the extension item-field channel. Returns undefined for undeclared keys so
 * extension-field admission keeps its own refusal.
 */
export function createSchemaFieldRecoveryResolver(
  registry: RuntimeFieldRegistry,
  command: "create" | "update",
): (field: string) => Pick<PmCliErrorContext, "recovery" | "nextSteps"> | undefined {
  return (field) => {
    // Declared keys are stored normalized, so compare through the same normalizer.
    const token = normalizeStatusToken(field);
    const definition = registry.definitions.find(
      (candidate) => candidate.metadata_key === token || candidate.key === token,
    );
    if (definition === undefined) return undefined;
    const flag = `--${definition.cli_flag}`;
    const inspect = `Inspect the value contract with: pm schema show-field ${definition.key}`;
    if (!definition.commands.includes(command)) {
      return {
        recovery: { provided_fields: [field] },
        nextSteps: [
          `The project schema declares "${definition.key}" for ${definition.commands.join(", ")} only; ${command} cannot set it.`,
          inspect,
        ],
      };
    }
    return {
      recovery: { provided_fields: [field], suggested_flags: [flag] },
      nextSteps: [
        `Use the declared project-schema flag: pm ${command}${command === "update" ? " <id>" : ""} ${flag} <value>`,
        `SDK: pass ${runtimeFieldSdkOptionName(definition)} in the ${command} options.`,
        inspect,
      ],
    };
  };
}
