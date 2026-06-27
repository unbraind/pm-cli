/**
 * @module cli/commands/shared-unset-fields
 *
 * Single-sources unset-field metadata shared by create and update command handlers.
 */
import type { RuntimeFieldRegistry } from "../../core/schema/runtime-schema.js";

/**
 * Describes one command option that can be removed from item front matter through `--unset`.
 */
export interface CommandUnsetFieldDefinition {
  canonical: string;
  aliases: readonly string[];
  optionKey: string;
  frontMatterKey: string;
}

export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON: readonly CommandUnsetFieldDefinition[] = [
  { canonical: "tags", aliases: ["tags"], optionKey: "tags", frontMatterKey: "tags" },
] as const;

export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR: readonly CommandUnsetFieldDefinition[] = [
  { canonical: "deadline", aliases: ["deadline"], optionKey: "deadline", frontMatterKey: "deadline" },
  {
    canonical: "estimate",
    aliases: ["estimate", "estimated_minutes", "estimated-minutes"],
    optionKey: "estimatedMinutes",
    frontMatterKey: "estimated_minutes",
  },
  {
    canonical: "acceptance-criteria",
    aliases: ["acceptance_criteria", "acceptance-criteria", "ac"],
    optionKey: "acceptanceCriteria",
    frontMatterKey: "acceptance_criteria",
  },
  {
    canonical: "definition-of-ready",
    aliases: ["definition_of_ready", "definition-of-ready"],
    optionKey: "definitionOfReady",
    frontMatterKey: "definition_of_ready",
  },
  { canonical: "order", aliases: ["order", "rank"], optionKey: "order", frontMatterKey: "order" },
  { canonical: "goal", aliases: ["goal"], optionKey: "goal", frontMatterKey: "goal" },
  { canonical: "objective", aliases: ["objective"], optionKey: "objective", frontMatterKey: "objective" },
  { canonical: "value", aliases: ["value"], optionKey: "value", frontMatterKey: "value" },
  { canonical: "impact", aliases: ["impact"], optionKey: "impact", frontMatterKey: "impact" },
  { canonical: "outcome", aliases: ["outcome"], optionKey: "outcome", frontMatterKey: "outcome" },
  { canonical: "why-now", aliases: ["why_now", "why-now"], optionKey: "whyNow", frontMatterKey: "why_now" },
] as const;

export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR: readonly CommandUnsetFieldDefinition[] = [
  ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
] as const;

export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR: readonly CommandUnsetFieldDefinition[] = [
  { canonical: "assignee", aliases: ["assignee"], optionKey: "assignee", frontMatterKey: "assignee" },
  { canonical: "parent", aliases: ["parent"], optionKey: "parent", frontMatterKey: "parent" },
  { canonical: "reviewer", aliases: ["reviewer"], optionKey: "reviewer", frontMatterKey: "reviewer" },
  { canonical: "risk", aliases: ["risk"], optionKey: "risk", frontMatterKey: "risk" },
  { canonical: "confidence", aliases: ["confidence"], optionKey: "confidence", frontMatterKey: "confidence" },
  { canonical: "sprint", aliases: ["sprint"], optionKey: "sprint", frontMatterKey: "sprint" },
  { canonical: "release", aliases: ["release"], optionKey: "release", frontMatterKey: "release" },
  {
    canonical: "blocked-by",
    aliases: ["blocked_by", "blocked-by"],
    optionKey: "blockedBy",
    frontMatterKey: "blocked_by",
  },
  {
    canonical: "blocked-reason",
    aliases: ["blocked_reason", "blocked-reason"],
    optionKey: "blockedReason",
    frontMatterKey: "blocked_reason",
  },
  {
    canonical: "unblock-note",
    aliases: ["unblock_note", "unblock-note"],
    optionKey: "unblockNote",
    frontMatterKey: "unblock_note",
  },
  { canonical: "reporter", aliases: ["reporter"], optionKey: "reporter", frontMatterKey: "reporter" },
  { canonical: "severity", aliases: ["severity"], optionKey: "severity", frontMatterKey: "severity" },
  {
    canonical: "environment",
    aliases: ["environment"],
    optionKey: "environment",
    frontMatterKey: "environment",
  },
  {
    canonical: "repro-steps",
    aliases: ["repro_steps", "repro-steps"],
    optionKey: "reproSteps",
    frontMatterKey: "repro_steps",
  },
  {
    canonical: "resolution",
    aliases: ["resolution"],
    optionKey: "resolution",
    frontMatterKey: "resolution",
  },
  {
    canonical: "expected-result",
    aliases: ["expected_result", "expected-result"],
    optionKey: "expectedResult",
    frontMatterKey: "expected_result",
  },
  {
    canonical: "actual-result",
    aliases: ["actual_result", "actual-result"],
    optionKey: "actualResult",
    frontMatterKey: "actual_result",
  },
  {
    canonical: "affected-version",
    aliases: ["affected_version", "affected-version"],
    optionKey: "affectedVersion",
    frontMatterKey: "affected_version",
  },
  {
    canonical: "fixed-version",
    aliases: ["fixed_version", "fixed-version"],
    optionKey: "fixedVersion",
    frontMatterKey: "fixed_version",
  },
  { canonical: "component", aliases: ["component"], optionKey: "component", frontMatterKey: "component" },
  { canonical: "regression", aliases: ["regression"], optionKey: "regression", frontMatterKey: "regression" },
  {
    canonical: "customer-impact",
    aliases: ["customer_impact", "customer-impact"],
    optionKey: "customerImpact",
    frontMatterKey: "customer_impact",
  },
] as const;

/**
 * Result of matching a runtime schema field against a command `--unset` token.
 */
export interface RuntimeUnsetFieldDefinition {
  optionKey: string;
  frontMatterKey: string;
}

/**
 * Resolve a runtime-schema field definition from a command `--unset` token.
 */
export function resolveRuntimeUnsetFieldDefinition(
  token: string,
  runtimeFieldRegistry: RuntimeFieldRegistry | undefined,
): RuntimeUnsetFieldDefinition | undefined {
  if (!runtimeFieldRegistry) {
    return undefined;
  }
  for (const definition of runtimeFieldRegistry.definitions) {
    if (definition.allow_unset === false) {
      continue;
    }
    const candidates = new Set<string>([
      definition.key,
      definition.metadata_key,
      definition.cli_flag.replaceAll("-", "_"),
      definition.cli_flag,
      ...definition.cli_aliases.map((alias) => alias.replaceAll("-", "_")),
      ...definition.cli_aliases,
    ]);
    if (!candidates.has(token)) {
      continue;
    }
    return {
      optionKey: definition.key,
      frontMatterKey: definition.metadata_key,
    };
  }
  return undefined;
}
