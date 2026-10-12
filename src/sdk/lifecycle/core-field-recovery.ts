/**
 * @module sdk/lifecycle/core-field-recovery
 * Resolves core-field refusal guidance from executable mutation registrations.
 */
import type { PmCliErrorContext } from "../../core/shared/errors.js";
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
