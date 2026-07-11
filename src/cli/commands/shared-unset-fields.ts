/**
 * @module cli/commands/shared-unset-fields
 *
 * Single-sources unset-field metadata shared by create and update command handlers.
 */
import type {
  RuntimeFieldCommand,
  RuntimeFieldRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isLegacyNoneToken } from "./legacy-none-tokens.js";

/** Describes one command option that can be removed from item front matter through `--unset`. */
export interface CommandUnsetFieldDefinition {
  /** Value that configures or reports canonical for this contract. */
  canonical: string;
  /** Value that configures or reports aliases for this contract. */
  aliases: readonly string[];
  /** Value that configures or reports option key for this contract. */
  optionKey: string;
  /** Value that configures or reports front matter key for this contract. */
  frontMatterKey: string;
}

/** Public contract for common unset field definitions before close reason, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON: readonly CommandUnsetFieldDefinition[] =
  [
    {
      canonical: "tags",
      aliases: ["tags"],
      optionKey: "tags",
      frontMatterKey: "tags",
    },
  ] as const;

/** Public contract for common unset field definitions after close reason before author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR: readonly CommandUnsetFieldDefinition[] =
  [
    {
      canonical: "deadline",
      aliases: ["deadline"],
      optionKey: "deadline",
      frontMatterKey: "deadline",
    },
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
    {
      canonical: "order",
      aliases: ["order", "rank"],
      optionKey: "order",
      frontMatterKey: "order",
    },
    {
      canonical: "goal",
      aliases: ["goal"],
      optionKey: "goal",
      frontMatterKey: "goal",
    },
    {
      canonical: "objective",
      aliases: ["objective"],
      optionKey: "objective",
      frontMatterKey: "objective",
    },
    {
      canonical: "value",
      aliases: ["value"],
      optionKey: "value",
      frontMatterKey: "value",
    },
    {
      canonical: "impact",
      aliases: ["impact"],
      optionKey: "impact",
      frontMatterKey: "impact",
    },
    {
      canonical: "outcome",
      aliases: ["outcome"],
      optionKey: "outcome",
      frontMatterKey: "outcome",
    },
    {
      canonical: "why-now",
      aliases: ["why_now", "why-now"],
      optionKey: "whyNow",
      frontMatterKey: "why_now",
    },
  ] as const;

/** Public contract for common unset field definitions before author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR: readonly CommandUnsetFieldDefinition[] =
  [
    ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
    ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
  ] as const;

/** Public contract for common unset field definitions after author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR: readonly CommandUnsetFieldDefinition[] =
  [
    {
      canonical: "assignee",
      aliases: ["assignee"],
      optionKey: "assignee",
      frontMatterKey: "assignee",
    },
    {
      canonical: "parent",
      aliases: ["parent"],
      optionKey: "parent",
      frontMatterKey: "parent",
    },
    {
      canonical: "reviewer",
      aliases: ["reviewer"],
      optionKey: "reviewer",
      frontMatterKey: "reviewer",
    },
    {
      canonical: "risk",
      aliases: ["risk"],
      optionKey: "risk",
      frontMatterKey: "risk",
    },
    {
      canonical: "confidence",
      aliases: ["confidence"],
      optionKey: "confidence",
      frontMatterKey: "confidence",
    },
    {
      canonical: "sprint",
      aliases: ["sprint"],
      optionKey: "sprint",
      frontMatterKey: "sprint",
    },
    {
      canonical: "release",
      aliases: ["release"],
      optionKey: "release",
      frontMatterKey: "release",
    },
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
    {
      canonical: "reporter",
      aliases: ["reporter"],
      optionKey: "reporter",
      frontMatterKey: "reporter",
    },
    {
      canonical: "severity",
      aliases: ["severity"],
      optionKey: "severity",
      frontMatterKey: "severity",
    },
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
    {
      canonical: "component",
      aliases: ["component"],
      optionKey: "component",
      frontMatterKey: "component",
    },
    {
      canonical: "regression",
      aliases: ["regression"],
      optionKey: "regression",
      frontMatterKey: "regression",
    },
    {
      canonical: "customer-impact",
      aliases: ["customer_impact", "customer-impact"],
      optionKey: "customerImpact",
      frontMatterKey: "customer_impact",
    },
  ] as const;

/** Result of matching a runtime schema field against a command `--unset` token. */
export interface RuntimeUnsetFieldDefinition {
  /** Value that configures or reports option key for this contract. */
  optionKey: string;
  /** Value that configures or reports front matter key for this contract. */
  frontMatterKey: string;
}

/** Result of parsing command-level `--unset` tokens into metadata and option-key sets. */
export interface ParsedCommandUnsetTargets {
  /** Value that configures or reports front matter keys for this contract. */
  frontMatterKeys: Set<string>;
  /** Value that configures or reports option keys for this contract. */
  optionKeys: Set<string>;
}

/** Resolve one normalized `--unset` token to a front-matter/option pair. */
export type CommandUnsetTargetResolver = (
  trimmedToken: string,
) => RuntimeUnsetFieldDefinition | undefined;

/** Parse and validate common command `--unset` tokens while preserving command-specific field resolution. */
export function parseCommandUnsetTargets(options: {
  readonly raw: readonly string[] | undefined;
  readonly resolveDefinition: CommandUnsetTargetResolver;
  readonly supportedFields: string;
}): ParsedCommandUnsetTargets {
  const frontMatterKeys = new Set<string>();
  const optionKeys = new Set<string>();
  if (!options.raw || options.raw.length === 0) {
    return { frontMatterKeys, optionKeys };
  }

  for (const entry of options.raw) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) {
      throw new PmCliError("--unset values must not be empty", EXIT_CODE.USAGE);
    }
    if (isLegacyNoneToken(trimmed)) {
      throw new PmCliError(
        '--unset no longer accepts "none" or "null". Specify concrete field names such as --unset deadline',
        EXIT_CODE.USAGE,
      );
    }
    const definition = options.resolveDefinition(trimmed);
    if (!definition) {
      throw new PmCliError(
        `Unsupported --unset field "${entry}". Supported fields: ${options.supportedFields}`,
        EXIT_CODE.USAGE,
      );
    }
    frontMatterKeys.add(definition.frontMatterKey);
    optionKeys.add(definition.optionKey);
  }

  return { frontMatterKeys, optionKeys };
}

/** Resolve a runtime-schema field definition from a command `--unset` token. */
export function resolveRuntimeUnsetFieldDefinition(
  token: string,
  command: RuntimeFieldCommand,
  runtimeFieldRegistry: RuntimeFieldRegistry | undefined,
): RuntimeUnsetFieldDefinition | undefined {
  const normalizedToken = token.trim().toLowerCase();
  if (!runtimeFieldRegistry) {
    return undefined;
  }
  const definitions =
    runtimeFieldRegistry.command_to_fields?.get(command) ?? [];
  for (const definition of definitions) {
    if (definition.allow_unset === false) {
      continue;
    }
    const candidates = new Set<string>();
    if (typeof definition.key === "string" && definition.key.length > 0) {
      candidates.add(definition.key.toLowerCase());
    }
    if (
      typeof definition.metadata_key === "string" &&
      definition.metadata_key.length > 0
    ) {
      candidates.add(definition.metadata_key.toLowerCase());
    }
    if (
      typeof definition.cli_flag === "string" &&
      definition.cli_flag.length > 0
    ) {
      candidates.add(definition.cli_flag.replaceAll("-", "_").toLowerCase());
      candidates.add(definition.cli_flag.toLowerCase());
    }
    if (Array.isArray(definition.cli_aliases)) {
      for (const alias of definition.cli_aliases) {
        if (typeof alias !== "string" || alias.length === 0) {
          continue;
        }
        candidates.add(alias.replaceAll("-", "_").toLowerCase());
        candidates.add(alias.toLowerCase());
      }
    }
    if (!candidates.has(normalizedToken)) {
      continue;
    }
    return {
      optionKey: definition.key,
      frontMatterKey: definition.metadata_key,
    };
  }
  return undefined;
}
