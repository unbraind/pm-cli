/**
 * @module sdk/lifecycle/shared-unset-fields
 *
 * Single-sources unset-field metadata shared by create and update command handlers.
 */
import {
  type RuntimeFieldCommand,
  type RuntimeFieldRegistry,
  EXIT_CODE,
  PmCliError,
} from "../runtime-primitives.js";
import { isLegacyNoneToken } from "./legacy-none-tokens.js";

/** Describes one command option that can be removed from item metadata through `--unset`. */
export interface CommandUnsetFieldDefinition {
  /** Value that configures or reports canonical for this contract. */
  canonical: string;
  /** Value that configures or reports aliases for this contract. */
  aliases: readonly string[];
  /** Value that configures or reports option key for this contract. */
  optionKey: string;
  /** Value that configures or reports item metadata key for this contract. */
  metadataKey: string;
}

/** `--unset` spellings that clear `close_reason`, shared by the update parser and the routed-close governance guard. */
export const CLOSE_REASON_UNSET_ALIASES: readonly string[] = ["close_reason", "close-reason"];

/** Public contract for common unset field definitions before close reason, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON =
  [
    {
      canonical: "tags",
      aliases: ["tags"],
      optionKey: "tags",
      metadataKey: "tags",
    },
  ] as const satisfies readonly CommandUnsetFieldDefinition[];

/** Public contract for common unset field definitions after close reason before author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR =
  [
    {
      canonical: "deadline",
      aliases: ["deadline"],
      optionKey: "deadline",
      metadataKey: "deadline",
    },
    {
      canonical: "estimate",
      aliases: ["estimate", "estimated_minutes", "estimated-minutes"],
      optionKey: "estimatedMinutes",
      metadataKey: "estimated_minutes",
    },
    {
      canonical: "acceptance-criteria",
      aliases: ["acceptance_criteria", "acceptance-criteria", "ac"],
      optionKey: "acceptanceCriteria",
      metadataKey: "acceptance_criteria",
    },
    {
      canonical: "definition-of-ready",
      aliases: ["definition_of_ready", "definition-of-ready"],
      optionKey: "definitionOfReady",
      metadataKey: "definition_of_ready",
    },
    {
      canonical: "order",
      aliases: ["order", "rank"],
      optionKey: "order",
      metadataKey: "order",
    },
    {
      canonical: "goal",
      aliases: ["goal"],
      optionKey: "goal",
      metadataKey: "goal",
    },
    {
      canonical: "objective",
      aliases: ["objective"],
      optionKey: "objective",
      metadataKey: "objective",
    },
    {
      canonical: "value",
      aliases: ["value"],
      optionKey: "value",
      metadataKey: "value",
    },
    {
      canonical: "impact",
      aliases: ["impact"],
      optionKey: "impact",
      metadataKey: "impact",
    },
    {
      canonical: "outcome",
      aliases: ["outcome"],
      optionKey: "outcome",
      metadataKey: "outcome",
    },
    {
      canonical: "why-now",
      aliases: ["why_now", "why-now"],
      optionKey: "whyNow",
      metadataKey: "why_now",
    },
  ] as const satisfies readonly CommandUnsetFieldDefinition[];

/** Public contract for common unset field definitions before author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR =
  [
    ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
    ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
  ] as const satisfies readonly CommandUnsetFieldDefinition[];

/** Public contract for common unset field definitions after author, shared by SDK and presentation-layer consumers. */
export const COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR =
  [
    {
      canonical: "assignee",
      aliases: ["assignee"],
      optionKey: "assignee",
      metadataKey: "assignee",
    },
    {
      canonical: "parent",
      aliases: ["parent"],
      optionKey: "parent",
      metadataKey: "parent",
    },
    {
      canonical: "reviewer",
      aliases: ["reviewer"],
      optionKey: "reviewer",
      metadataKey: "reviewer",
    },
    {
      canonical: "risk",
      aliases: ["risk"],
      optionKey: "risk",
      metadataKey: "risk",
    },
    {
      canonical: "confidence",
      aliases: ["confidence"],
      optionKey: "confidence",
      metadataKey: "confidence",
    },
    {
      canonical: "sprint",
      aliases: ["sprint"],
      optionKey: "sprint",
      metadataKey: "sprint",
    },
    {
      canonical: "release",
      aliases: ["release"],
      optionKey: "release",
      metadataKey: "release",
    },
    {
      canonical: "blocked-by",
      aliases: ["blocked_by", "blocked-by"],
      optionKey: "blockedBy",
      metadataKey: "blocked_by",
    },
    {
      canonical: "blocked-reason",
      aliases: ["blocked_reason", "blocked-reason"],
      optionKey: "blockedReason",
      metadataKey: "blocked_reason",
    },
    {
      canonical: "unblock-note",
      aliases: ["unblock_note", "unblock-note"],
      optionKey: "unblockNote",
      metadataKey: "unblock_note",
    },
    {
      canonical: "reporter",
      aliases: ["reporter"],
      optionKey: "reporter",
      metadataKey: "reporter",
    },
    {
      canonical: "severity",
      aliases: ["severity"],
      optionKey: "severity",
      metadataKey: "severity",
    },
    {
      canonical: "environment",
      aliases: ["environment"],
      optionKey: "environment",
      metadataKey: "environment",
    },
    {
      canonical: "repro-steps",
      aliases: ["repro_steps", "repro-steps"],
      optionKey: "reproSteps",
      metadataKey: "repro_steps",
    },
    {
      canonical: "resolution",
      aliases: ["resolution"],
      optionKey: "resolution",
      metadataKey: "resolution",
    },
    {
      canonical: "expected-result",
      aliases: ["expected_result", "expected-result"],
      optionKey: "expectedResult",
      metadataKey: "expected_result",
    },
    {
      canonical: "actual-result",
      aliases: ["actual_result", "actual-result"],
      optionKey: "actualResult",
      metadataKey: "actual_result",
    },
    {
      canonical: "affected-version",
      aliases: ["affected_version", "affected-version"],
      optionKey: "affectedVersion",
      metadataKey: "affected_version",
    },
    {
      canonical: "fixed-version",
      aliases: ["fixed_version", "fixed-version"],
      optionKey: "fixedVersion",
      metadataKey: "fixed_version",
    },
    {
      canonical: "component",
      aliases: ["component"],
      optionKey: "component",
      metadataKey: "component",
    },
    {
      canonical: "regression",
      aliases: ["regression"],
      optionKey: "regression",
      metadataKey: "regression",
    },
    {
      canonical: "customer-impact",
      aliases: ["customer_impact", "customer-impact"],
      optionKey: "customerImpact",
      metadataKey: "customer_impact",
    },
  ] as const satisfies readonly CommandUnsetFieldDefinition[];

/** Every field `pm create --unset` (and the SDK `unset` option on create) can clear. */
export const CREATE_UNSET_FIELD_DEFINITIONS = [
  ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR,
  {
    canonical: "author",
    aliases: ["author"],
    optionKey: "author",
    metadataKey: "author",
  },
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
] as const satisfies readonly CommandUnsetFieldDefinition[];

/** Every field `pm update --unset` (and the SDK `unset` option on update) can clear. */
export const UPDATE_UNSET_FIELD_DEFINITIONS = [
  ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
  {
    canonical: "close-reason",
    aliases: CLOSE_REASON_UNSET_ALIASES,
    optionKey: "closeReason",
    metadataKey: "close_reason",
  },
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
] as const satisfies readonly CommandUnsetFieldDefinition[];

/**
 * Option keys a typed caller may clear with `null` (GH-1655): every option the
 * command's `unset` table covers, derived from that table, except the `author`
 * attribution, which names who performs the write.
 */
export type NullClearableOptionKey<Table extends readonly { optionKey: string }[]> = Exclude<Table[number]["optionKey"], "author">;

/** Let the listed keys also take `null`, the typed clear, while every other key keeps its exact value type and optionality. */
export type WithNullClears<Shape, Keys extends PropertyKey> = {
  [Key in keyof Shape]: Key extends Keys ? Shape[Key] | null : Shape[Key];
};

/**
 * Create option keys that accept the typed `null` clear, spelled out so the SDK
 * surface snapshot records the set (it prints alias text, not resolved types).
 * tests/types/typed-action-inputs.test-d.ts keeps it equal to
 * `NullClearableOptionKey<typeof CREATE_UNSET_FIELD_DEFINITIONS>`.
 */
export type CreateNullClearableOptionKey =
  | "acceptanceCriteria"
  | "actualResult"
  | "affectedVersion"
  | "assignee"
  | "blockedBy"
  | "blockedReason"
  | "component"
  | "confidence"
  | "customerImpact"
  | "deadline"
  | "definitionOfReady"
  | "environment"
  | "estimatedMinutes"
  | "expectedResult"
  | "fixedVersion"
  | "goal"
  | "impact"
  | "objective"
  | "order"
  | "outcome"
  | "parent"
  | "regression"
  | "release"
  | "reporter"
  | "reproSteps"
  | "resolution"
  | "reviewer"
  | "risk"
  | "severity"
  | "sprint"
  | "tags"
  | "unblockNote"
  | "value"
  | "whyNow";

/** Update option keys that accept the typed `null` clear: the create set plus `closeReason`, kept equal to the update unset table by the same type test. */
export type UpdateNullClearableOptionKey = CreateNullClearableOptionKey | "closeReason";

/** Spellings that once cleared a field on every surface and now persist literally from typed callers. */
const FORMER_CLEAR_SENTINELS = new Set(["none", "null", "-"]);

function unsetDefinitionsFor(action: "create" | "update"): readonly CommandUnsetFieldDefinition[] {
  return action === "create" ? CREATE_UNSET_FIELD_DEFINITIONS : UPDATE_UNSET_FIELD_DEFINITIONS;
}

/**
 * Treat a typed `null` on a clearable option as an explicit clear (GH-1655):
 * `{ parent: null }` becomes `unset: ["parent"]`. Options `unset` cannot clear
 * keep their `null`, so value validation refuses them by name, and so does
 * `author`: on the SDK it names who performs the write, not a stored field.
 * Mutates the bag, which must be a caller-private copy; an `unset` that is
 * neither absent, a string nor an array is left for value validation to refuse.
 */
export function foldNullClearsIntoUnset(action: "create" | "update", options: Record<string, unknown>): void {
  const current = options.unset;
  if (current !== undefined && typeof current !== "string" && !Array.isArray(current)) return;
  const tokens: string[] = [];
  for (const definition of unsetDefinitionsFor(action)) {
    if (definition.optionKey === "author" || !Object.hasOwn(options, definition.optionKey) || options[definition.optionKey] !== null) continue;
    Reflect.deleteProperty(options, definition.optionKey);
    tokens.push(definition.canonical);
  }
  if (tokens.length === 0) return;
  options.unset = [...(current === undefined ? [] : typeof current === "string" ? [current] : current), ...tokens];
}

function isFormerClearSentinel(value: unknown): value is string {
  return typeof value === "string" && FORMER_CLEAR_SENTINELS.has(value.trim().toLowerCase());
}

/**
 * Advisory warnings for typed input that stored a former clear sentinel
 * literally (GH-1614 keeps `assignee: "none"` as a person called none). Each
 * names the field and the clear form: `literal_sentinel_stored:<field>:<value>`,
 * cleared with `unset: ["<field>"]` or `null`. A field is advised only when the
 * resulting `stored` item still holds that sentinel, so a value a lifecycle
 * transition removed is never reported as stored. CLI input is never advised:
 * its adapter still maps the sentinels to clears.
 */
export function literalSentinelAdvisories(action: "create" | "update", options: Record<string, unknown>, literal: boolean, stored: Record<string, unknown>): string[] {
  if (!literal) return [];
  return unsetDefinitionsFor(action).flatMap((definition) => {
    const value = options[definition.optionKey];
    const kept = stored[definition.metadataKey];
    // A CSV option such as tags is stored as an array; any element still holding the sentinel counts.
    return isFormerClearSentinel(value) && (isFormerClearSentinel(kept) || (Array.isArray(kept) && kept.some(isFormerClearSentinel)))
      ? [`literal_sentinel_stored:${definition.canonical}:${value.trim()}`]
      : [];
  });
}

/** Result of matching a runtime schema field against a command `--unset` token. */
export interface RuntimeUnsetFieldDefinition {
  /** Value that configures or reports option key for this contract. */
  optionKey: string;
  /** Value that configures or reports item metadata key for this contract. */
  metadataKey: string;
}

/** Result of parsing command-level `--unset` tokens into metadata and option-key sets. */
export interface ParsedCommandUnsetTargets {
  /** Value that configures or reports item metadata keys for this contract. */
  metadataKeys: Set<string>;
  /** Value that configures or reports option keys for this contract. */
  optionKeys: Set<string>;
}

/** Resolve one normalized `--unset` token to a item-metadata/option pair. */
export type CommandUnsetTargetResolver = (
  trimmedToken: string,
) => RuntimeUnsetFieldDefinition | undefined;

/**
 * Expand repeated and comma-separated `--unset` values into one token per
 * field. An entry that resolves as a whole is kept intact first, so a legacy
 * field key registered with a comma (before schema add-field refused them)
 * stays clearable; only unresolved entries split on commas.
 */
export function expandUnsetFieldTokens(
  raw: readonly string[],
  resolvesWhole: (entry: string) => boolean,
): string[] {
  return raw.flatMap((entry) =>
    entry.includes(",") && resolvesWhole(entry) ? [entry] : entry.split(","),
  );
}

/** Parse and validate common command `--unset` tokens while preserving command-specific field resolution. */
export function parseCommandUnsetTargets(options: {
  readonly raw: readonly string[] | undefined;
  readonly resolveDefinition: CommandUnsetTargetResolver;
  readonly supportedFields: string;
}): ParsedCommandUnsetTargets {
  const metadataKeys = new Set<string>();
  const optionKeys = new Set<string>();
  if (!options.raw || options.raw.length === 0) {
    return { metadataKeys, optionKeys };
  }

  const tokens = expandUnsetFieldTokens(
    options.raw,
    (entry) => options.resolveDefinition(entry.trim().toLowerCase()) !== undefined,
  );
  for (const entry of tokens) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) {
      throw new PmCliError(
        "--unset values must not be empty; name each field once, for example --unset parent,release",
        EXIT_CODE.USAGE,
      );
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
    metadataKeys.add(definition.metadataKey);
    optionKeys.add(definition.optionKey);
  }

  return { metadataKeys, optionKeys };
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
      metadataKey: definition.metadata_key,
    };
  }
  return undefined;
}

/** Create's own unset aliases, resolved before schema fields, so a core spelling always wins. */
const CREATE_UNSET_ALIAS_MAP: Map<string, RuntimeUnsetFieldDefinition> = (() => {
  const map = new Map<string, RuntimeUnsetFieldDefinition>();
  for (const definition of CREATE_UNSET_FIELD_DEFINITIONS) {
    for (const alias of definition.aliases) {
      map.set(alias, { optionKey: definition.optionKey, metadataKey: definition.metadataKey });
    }
  }
  return map;
})();

const CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS =
  CREATE_UNSET_FIELD_DEFINITIONS.map((definition) => definition.canonical)
    .sort((left, right) => left.localeCompare(right))
    .join(", ");

/**
 * Parse create `--unset` tokens exactly as create resolves them: core aliases
 * first, then schema fields, with whole-token expansion. Shared by create and
 * the stdin-json document adapter, so both agree on what an unset names.
 */
export function parseCreateUnsetTargets(
  raw: readonly string[] | undefined,
  runtimeFieldRegistry?: RuntimeFieldRegistry,
): { metadataKeys: Set<string>; optionKeys: Set<string> } {
  return parseCommandUnsetTargets({
    raw,
    supportedFields: CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS,
    resolveDefinition: (trimmed) =>
      CREATE_UNSET_ALIAS_MAP.get(trimmed) ??
      resolveRuntimeUnsetFieldDefinition(trimmed, "create", runtimeFieldRegistry),
  });
}
