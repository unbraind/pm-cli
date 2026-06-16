import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import {
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import { createStdinTokenResolver, mergeAdditiveTags, parseCsvKv, parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { getFocusedItem } from "../../core/session/session-state.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { CREATE_DIRECT_CLOSE_REASON_DEFAULT } from "../../core/shared/constants.js";
import {
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  resolveItemTypeRegistry,
  resolveCommandOptionPolicyState,
  type ResolvedItemTypeDefinition,
  resolveTypeDefinition,
  resolveTypeName,
  validateTypeOptions,
} from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { printError } from "../../core/output/output.js";
import { buildInvalidTypeError } from "../../core/schema/item-types-file.js";
import { resolveTypeSynonym } from "../../core/item/type-synonyms.js";
import { collectRuntimeCreateFieldValues } from "../../core/schema/runtime-field-values.js";
import {
  type RuntimeFieldRegistry,
  resolveItemTypesFilePath,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import {
  getActiveExtensionRegistrations,
  projectAfterCommandItemSnapshot,
  recordAfterCommandAffectedItem,
  runActiveCommandHandler,
  runActiveOnWriteHooks,
} from "../../core/extensions/index.js";
import {
  collectRegisteredItemFieldNames,
  applyRegisteredItemFieldDefaultsAndValidation,
  parseRegisteredItemFieldAssignments,
} from "../../core/extensions/item-fields.js";
import { locateItem } from "../../core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import {
  normalizeRiskInput,
  normalizeSeverityInput,
  parseConfidenceInput,
  parseRegressionInput,
} from "./metadata-normalizers.js";
import { assertNoLegacyNoneToken, assertNoLegacyNoneTokens, isLegacyNoneToken } from "./legacy-none-tokens.js";
import {
  parseLinkedTestAssertionEqualsMap,
  parseLinkedTestAssertionGteMap,
  parseLinkedTestBoolean,
  parseLinkedTestContextMode,
  parseLinkedTestEnvClear,
  parseLinkedTestEnvSet,
  parseLinkedTestMinLines,
  parseLinkedTestRegexList,
  parseLinkedTestStringList,
} from "./linked-test-parsers.js";
import { looksLikeStructuredLinkedTestEntry, normalizeStructuredLinkedTestEntry } from "./linked-test-entry.js";
import { ensureEnumValue } from "./recurrence-parsers.js";
import {
  parseEventEntries,
  parseReminderEntries,
  parseTypeOptionEntries,
} from "./repeatable-metadata-parsers.js";
import type {
  CalendarEvent,
  Comment,
  Dependency,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  Reminder,
} from "../../types/index.js";
import {
  DEPENDENCY_KIND_VALUES,
  ISSUE_SEVERITY_VALUES,
  RISK_VALUES,
  SCOPE_VALUES,
} from "../../types/index.js";

export interface CreateCommandOptions {
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  tags?: string;
  addTags?: string[];
  body?: string;
  deadline?: string;
  estimatedMinutes?: string;
  acceptanceCriteria?: string;
  definitionOfReady?: string;
  order?: string;
  rank?: string;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  whyNow?: string;
  author?: string;
  message?: string;
  assignee?: string;
  parent?: string;
  allowMissingParent?: boolean;
  reviewer?: string;
  risk?: string;
  confidence?: string;
  sprint?: string;
  release?: string;
  blockedBy?: string;
  blockedReason?: string;
  unblockNote?: string;
  reporter?: string;
  severity?: string;
  environment?: string;
  reproSteps?: string;
  resolution?: string;
  expectedResult?: string;
  actualResult?: string;
  affectedVersion?: string;
  fixedVersion?: string;
  component?: string;
  regression?: string;
  customerImpact?: string;
  dep?: string[];
  comment?: string[];
  note?: string[];
  learning?: string[];
  file?: string[];
  test?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
  field?: string[];
  template?: string;
  createMode?: string;
  schedulePreset?: string;
  unset?: string[];
  clearDeps?: boolean;
  clearComments?: boolean;
  clearNotes?: boolean;
  clearLearnings?: boolean;
  clearFiles?: boolean;
  clearTests?: boolean;
  clearDocs?: boolean;
  clearReminders?: boolean;
  clearEvents?: boolean;
  clearTypeOptions?: boolean;
  [key: string]: unknown;
}

export interface CreateResult {
  item: ItemMetadata;
  changed_fields: string[];
  warnings: string[];
  // GH-161: set to "focus" when the item's parent was inherited from the
  // session focused item (`pm focus <id>`) rather than an explicit --parent.
  parent_source?: "focus";
}

type CreateMode = "strict" | "progressive";
const CREATE_MODE_VALUES = ["strict", "progressive"] as const;
type ScheduleCreatePreset = "lightweight";
const SCHEDULE_CREATE_PRESET_VALUES = ["lightweight"] as const;
const SCHEDULE_CREATE_PRESET_TYPES = new Set(["Reminder", "Meeting", "Event"]);
const LOG_SEED_ALLOWED_KEYS = new Set(["author", "created_at", "text"]);

interface CreateUnsetFieldDefinition {
  optionKey: string;
  frontMatterKey: string;
}

const CREATE_UNSET_FIELD_DEFINITIONS: ReadonlyArray<{
  canonical: string;
  aliases: readonly string[];
  optionKey: string;
  frontMatterKey: string;
}> = [
  { canonical: "tags", aliases: ["tags"], optionKey: "tags", frontMatterKey: "tags" },
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
  { canonical: "author", aliases: ["author"], optionKey: "author", frontMatterKey: "author" },
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
];

const CREATE_UNSET_ALIAS_MAP: Map<string, CreateUnsetFieldDefinition> = (() => {
  const map = new Map<string, CreateUnsetFieldDefinition>();
  for (const definition of CREATE_UNSET_FIELD_DEFINITIONS) {
    for (const alias of definition.aliases) {
      map.set(alias, {
        optionKey: definition.optionKey,
        frontMatterKey: definition.frontMatterKey,
      });
    }
  }
  return map;
})();

const CREATE_OPTION_KEY_TO_UNSET_CANONICAL = new Map<string, string>(
  CREATE_UNSET_FIELD_DEFINITIONS.map((definition) => [definition.optionKey, definition.canonical]),
);

const CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS = CREATE_UNSET_FIELD_DEFINITIONS.map((definition) => definition.canonical)
  .sort((left, right) => left.localeCompare(right))
  .join(", ");

function buildInvalidLogSeedKeysMessage(
  optionName: "--comment" | "--note" | "--learning",
  unsupportedKeys: string[],
): string {
  const sortedUnsupported = [...unsupportedKeys].sort((left, right) => left.localeCompare(right));
  const keyLabel = sortedUnsupported.length === 1 ? "key" : "keys";
  return (
    `${optionName} supports only author, created_at, and text seed fields. ` +
    `Found unsupported ${keyLabel}: ${sortedUnsupported.join(", ")}. ` +
    `If text contains comma-separated key:value-like fragments, wrap text in quotes ` +
    '(for example text="first,scope:project"), use markdown-style key/value input, ' +
    `or pass ${optionName} - with piped stdin.`
  );
}

function parseStatusValue(value: string, statusRegistry: RuntimeStatusRegistry): ItemStatus {
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(`Invalid status value "${value}". Allowed: ${allowedStatuses.join(", ")}`, EXIT_CODE.USAGE);
  }
  return normalized;
}

/**
 * Resolve the create-time status when `--status` is omitted: a config-driven
 * per-type `default_status` (from `pm schema add-type --default-status`) wins,
 * then the workflow open status. An unknown configured value degrades to the
 * open status rather than blocking the create (never-block-the-agent).
 */
function resolveCreateDefaultStatus(
  typeDefinition: ResolvedItemTypeDefinition,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus {
  const configured = typeDefinition.default_status;
  if (configured !== undefined) {
    const normalized = normalizeStatusInput(configured, statusRegistry);
    if (normalized) {
      return normalized;
    }
  }
  return statusRegistry.open_status;
}

function parseCreatedAt(value: string | undefined, currentIso: string): string {
  if (!value || value.trim() === "" || value.trim().toLowerCase() === "now") {
    return currentIso;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(`Invalid created_at timestamp "${value}"`, EXIT_CODE.USAGE);
  }
  return new Date(parsed).toISOString();
}

interface LegacyNoneCollectionNormalizationDefinition {
  optionKey: keyof CreateCommandOptions;
  clearFlagKey: keyof CreateCommandOptions;
  valueFlag: string;
  clearFlag: string;
}

const CREATE_LEGACY_NONE_COLLECTION_NORMALIZERS: ReadonlyArray<LegacyNoneCollectionNormalizationDefinition> = [
  { optionKey: "dep", clearFlagKey: "clearDeps", valueFlag: "--dep", clearFlag: "--clear-deps" },
  { optionKey: "comment", clearFlagKey: "clearComments", valueFlag: "--comment", clearFlag: "--clear-comments" },
  { optionKey: "note", clearFlagKey: "clearNotes", valueFlag: "--note", clearFlag: "--clear-notes" },
  { optionKey: "learning", clearFlagKey: "clearLearnings", valueFlag: "--learning", clearFlag: "--clear-learnings" },
  { optionKey: "file", clearFlagKey: "clearFiles", valueFlag: "--file", clearFlag: "--clear-files" },
  { optionKey: "test", clearFlagKey: "clearTests", valueFlag: "--test", clearFlag: "--clear-tests" },
  { optionKey: "doc", clearFlagKey: "clearDocs", valueFlag: "--doc", clearFlag: "--clear-docs" },
  { optionKey: "reminder", clearFlagKey: "clearReminders", valueFlag: "--reminder", clearFlag: "--clear-reminders" },
  { optionKey: "event", clearFlagKey: "clearEvents", valueFlag: "--event", clearFlag: "--clear-events" },
  { optionKey: "typeOption", clearFlagKey: "clearTypeOptions", valueFlag: "--type-option", clearFlag: "--clear-type-options" },
];

function normalizeLegacyNoneCreateOptions(options: CreateCommandOptions): CreateCommandOptions {
  const normalized: CreateCommandOptions = {
    ...options,
    unset: options.unset ? [...options.unset] : undefined,
  };
  /* c8 ignore start -- unset dedupe helper branch permutations are covered by legacy option compatibility suites. */
  const appendUnsetTarget = (value: string): void => {
    const current = normalized.unset ? [...normalized.unset] : [];
    if (!current.includes(value)) {
      current.push(value);
    }
    normalized.unset = current;
  };
  /* c8 ignore stop */

  if (isLegacyNoneToken(normalized.template)) {
    normalized.template = undefined;
  }

  const scalarOptionKeys = new Set<string>([...CREATE_OPTION_KEY_TO_UNSET_CANONICAL.keys(), "rank"]);
  for (const optionKey of scalarOptionKeys) {
    const candidate = normalized[optionKey];
    if (typeof candidate !== "string" || !isLegacyNoneToken(candidate)) {
      continue;
    }
    /* c8 ignore start -- rank alias canonicalization is exercised in legacy-option compatibility tests. */
    const canonicalUnset = optionKey === "rank" ? "order" : (CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey);
    appendUnsetTarget(canonicalUnset);
    normalized[optionKey] = undefined;
    /* c8 ignore stop */
  }

  for (const definition of CREATE_LEGACY_NONE_COLLECTION_NORMALIZERS) {
    const entries = normalized[definition.optionKey];
    if (!Array.isArray(entries) || entries.length === 0) {
      continue;
    }
    const hasLegacy = entries.some((entry) => isLegacyNoneToken(entry));
    if (!hasLegacy) {
      continue;
    }
    const concreteEntries = entries.filter((entry) => !isLegacyNoneToken(entry));
    if (concreteEntries.length > 0) {
      throw new PmCliError(
        `Cannot mix legacy clear token "none"/"null" with concrete ${definition.valueFlag} entries. Use ${definition.clearFlag} to clear or provide explicit entries.`,
        EXIT_CODE.USAGE,
      );
    }
    normalized[definition.optionKey] = undefined;
    normalized[definition.clearFlagKey] = true;
  }

  return normalized;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value;
}

function resolveRuntimeCreateUnsetDefinition(
  token: string,
  runtimeFieldRegistry: RuntimeFieldRegistry | undefined,
): CreateUnsetFieldDefinition | undefined {
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

function parseCreateUnsetTargets(
  raw: string[] | undefined,
  runtimeFieldRegistry?: RuntimeFieldRegistry,
): { frontMatterKeys: Set<string>; optionKeys: Set<string> } {
  const frontMatterKeys = new Set<string>();
  const optionKeys = new Set<string>();
  if (!raw || raw.length === 0) {
    return { frontMatterKeys, optionKeys };
  }

  for (const entry of raw) {
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
    const definition = CREATE_UNSET_ALIAS_MAP.get(trimmed) ?? resolveRuntimeCreateUnsetDefinition(trimmed, runtimeFieldRegistry);
    if (!definition) {
      throw new PmCliError(
        `Unsupported --unset field "${entry}". Supported fields: ${CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS}`,
        EXIT_CODE.USAGE,
      );
    }
    frontMatterKeys.add(definition.frontMatterKey);
    optionKeys.add(definition.optionKey);
  }

  return { frontMatterKeys, optionKeys };
}

function parseDependencies(
  raw: string[] | undefined,
  nowValue: string,
  prefix: string,
): { values: Dependency[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--dep", "Use --clear-deps to clear dependencies.");
  const values: Dependency[] = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredEntry(trimmedEntry, ["id", "kind", "type", "author", "created_at"])
      ? parseCsvKv(entry, "--dep")
      : { id: trimmedEntry, kind: "related" };
    const id = parseOptionalString(kv.id);
    const kind = normalizeDependencyKindInput(parseOptionalString(kv.kind ?? kv.type));
    if (!id || !kind) {
      throw new PmCliError("--dep requires id and kind, or a bare item id to create a related dependency", EXIT_CODE.USAGE);
    }
    if (id.trim().toLowerCase() === "undefined") {
      throw new PmCliError(
        `--dep id must not use placeholder token "${id}". Use --clear-deps to clear dependencies.`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      id: normalizeItemId(id, prefix),
      kind: ensureEnumValue(kind, DEPENDENCY_KIND_VALUES, "dependency kind"),
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author),
    };
  });
  return { values, explicitEmpty: false };
}

const DEPENDENCY_KIND_INPUT_ALIASES: Readonly<Record<string, string>> = {
  "blocked-by": "blocked_by",
  depends_on: "blocked_by",
  "depends-on": "blocked_by",
};

function normalizeDependencyKindInput(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return raw;
  }
  const alias = DEPENDENCY_KIND_INPUT_ALIASES[raw.toLowerCase()];
  return alias ?? raw;
}

function looksLikeStructuredEntry(raw: string, keys: readonly string[]): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^(?:[-*+]\\s+)?(?:${keyPattern})\\s*[:=]`, "i").test(raw);
}

export function parseLogSeed(
  optionName: "--comment" | "--note" | "--learning",
  raw: string[] | undefined,
  nowValue: string,
  fallbackAuthor: string,
): { values: LogNote[] | Comment[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  const clearHint =
    optionName === "--comment"
      ? "Use --clear-comments to clear comments."
      : optionName === "--note"
        ? "Use --clear-notes to clear notes."
        : "Use --clear-learnings to clear learnings.";
  assertNoLegacyNoneTokens(raw, optionName, clearHint);
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const buildPlainTextCommentSeed = (): Comment => {
      /* c8 ignore start -- empty plaintext fallback is guarded by option parsing before create execution. */
      if (trimmedEntry.length === 0) {
        throw new PmCliError(`${optionName} requires text=<value>`, EXIT_CODE.USAGE);
      }
      /* c8 ignore stop */
      return {
        created_at: nowValue,
        author: fallbackAuthor,
        text: trimmedEntry,
      };
    };
    let kv: Record<string, string>;
    try {
      kv = parseCsvKv(entry, optionName);
    } catch (error: unknown) {
      /* c8 ignore start -- optionName is type-narrowed to --comment/--note/--learning, so this branch is always true and the rethrow is unreachable. */
      if (optionName === "--comment" || optionName === "--note" || optionName === "--learning") {
        return buildPlainTextCommentSeed();
      }
      throw error;
      /* c8 ignore stop */
    }
    const unsupportedKeys = Object.keys(kv).filter((key) => !LOG_SEED_ALLOWED_KEYS.has(key));
    if (unsupportedKeys.length > 0) {
      return {
        created_at: parseCreatedAt(kv.created_at, nowValue),
        author: parseOptionalString(kv.author) ?? fallbackAuthor,
        text: trimmedEntry,
      };
    }
    const text = kv.text ?? "";
    if (text === "") {
      throw new PmCliError(`${optionName} requires text=<value>`, EXIT_CODE.USAGE);
    }
    return {
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author) ?? fallbackAuthor,
      text,
    };
  });
  return { values, explicitEmpty: false };
}

export function parseFiles(raw: string[] | undefined): { values: LinkedFile[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--file", "Use --clear-files to clear linked files.");
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredEntry(trimmedEntry, ["path", "scope", "note"])
      ? parseCsvKv(entry, "--file")
      : { path: trimmedEntry };
    if (!kv.path) {
      throw new PmCliError("--file requires path=<value> or a bare file path", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "file scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

export function parseTests(raw: string[] | undefined): { values: LinkedTest[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--test", "Use --clear-tests to clear linked tests.");
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredLinkedTestEntry(trimmedEntry)
      ? normalizeStructuredLinkedTestEntry(parseCsvKv(entry, "--test"), "--test")
      : { command: trimmedEntry };
    const command = parseOptionalString(kv.command);
    const filePath = parseOptionalString(kv.path);
    if (!command) {
      throw new PmCliError("--test requires command=<value> or a bare command (path=<value> is optional metadata)", EXIT_CODE.USAGE);
    }
    const timeoutSecondsRaw = parseOptionalString(kv.timeout_seconds);
    const timeoutAliasRaw = parseOptionalString(kv.timeout);
    if (timeoutSecondsRaw && timeoutAliasRaw && timeoutSecondsRaw !== timeoutAliasRaw) {
      throw new PmCliError("--test timeout and timeout_seconds must match when both are provided", EXIT_CODE.USAGE);
    }
    const timeoutRaw = timeoutSecondsRaw ?? timeoutAliasRaw;
    return {
      command,
      path: filePath,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "test scope"),
      timeout_seconds: timeoutRaw ? parseOptionalNumber(timeoutRaw, "timeout_seconds") : undefined,
      pm_context_mode: parseLinkedTestContextMode(kv.pm_context_mode, "--test"),
      env_set: parseLinkedTestEnvSet(kv.env_set, "--test"),
      env_clear: parseLinkedTestEnvClear(kv.env_clear, "--test"),
      shared_host_safe: parseLinkedTestBoolean(kv.shared_host_safe, "--test", "shared_host_safe"),
      assert_stdout_contains: parseLinkedTestStringList(kv.assert_stdout_contains),
      assert_stdout_regex: parseLinkedTestRegexList(kv.assert_stdout_regex, "--test", "assert_stdout_regex"),
      assert_stderr_contains: parseLinkedTestStringList(kv.assert_stderr_contains),
      assert_stderr_regex: parseLinkedTestRegexList(kv.assert_stderr_regex, "--test", "assert_stderr_regex"),
      assert_stdout_min_lines: parseLinkedTestMinLines(kv.assert_stdout_min_lines, "--test"),
      assert_json_field_equals: parseLinkedTestAssertionEqualsMap(kv.assert_json_field_equals, "--test"),
      assert_json_field_gte: parseLinkedTestAssertionGteMap(kv.assert_json_field_gte, "--test"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

export function parseDocs(raw: string[] | undefined): { values: LinkedDoc[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--doc", "Use --clear-docs to clear linked docs.");
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredEntry(trimmedEntry, ["path", "scope", "note"])
      ? parseCsvKv(entry, "--doc")
      : { path: trimmedEntry };
    if (!kv.path) {
      throw new PmCliError("--doc requires path=<value> or a bare doc path", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "doc scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseReminders(raw: string[] | undefined, nowValue: string): { values: Reminder[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--reminder", "Use --clear-reminders to clear reminders.");
  return {
    values: parseReminderEntries(raw, new Date(nowValue), { valueMode: "raw" }),
    explicitEmpty: false,
  };
}

function parseEvents(raw: string[] | undefined, nowValue: string): { values: CalendarEvent[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(raw, "--event", "Use --clear-events to clear linked events.");
  return {
    values: parseEventEntries(raw, new Date(nowValue), {
      allDayEmptyGuard: "defined",
      recurrenceEmptyNumericGuard: "defined",
    }),
    explicitEmpty: false,
  };
}

function buildChangedFields(
  frontMatter: ItemMetadata,
  body: string,
  explicitUnsets: string[],
  additionalFrontMatterKeys: readonly string[] = [],
): string[] {
  const changed = [
    ...FRONT_MATTER_KEY_ORDER.filter((key) => frontMatter[key] !== undefined),
    ...additionalFrontMatterKeys.filter((key) => (frontMatter as unknown as Record<string, unknown>)[key] !== undefined),
    ...(body.length > 0 ? ["body"] : []),
    ...explicitUnsets.map((key) => `unset:${key}`),
  ];
  return Array.from(new Set(changed));
}

function buildHistoryMessage(baseMessage: string | undefined, explicitUnsets: string[]): string | undefined {
  const trimmed = baseMessage ?? "";
  if (explicitUnsets.length === 0) {
    return trimmed;
  }
  const suffix = `explicit_unset=${explicitUnsets.join(",")}`;
  return trimmed ? `${trimmed} | ${suffix}` : suffix;
}

function normalizeCreatePolicyOptionKey(raw: string, typeName: string, sourceLabel: string): string {
  const canonical = canonicalizeCommandOptionKey("create", raw);
  if (!canonical) {
    throw new PmCliError(
      `Unsupported ${sourceLabel} entry "${raw}" for type "${typeName}"`,
      EXIT_CODE.CONFLICT,
    );
  }
  return canonical;
}

function parseTypeOptions(raw: string[] | undefined): { values: Record<string, string> | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) {
    return { values: undefined, explicitEmpty: false };
  }
  assertNoLegacyNoneTokens(raw, "--type-option", "Use --clear-type-options to clear existing type options.");
  return {
    values: parseTypeOptionEntries(raw),
    explicitEmpty: false,
  };
}

async function resolveCreateStdinInputs(options: CreateCommandOptions): Promise<CreateCommandOptions> {
  const stdinResolver = createStdinTokenResolver();
  return {
    ...options,
    body: await stdinResolver.resolveValue(options.body, "--body"),
    dep: await stdinResolver.resolveList(options.dep, "--dep"),
    comment: await stdinResolver.resolveList(options.comment, "--comment"),
    note: await stdinResolver.resolveList(options.note, "--note"),
    learning: await stdinResolver.resolveList(options.learning, "--learning"),
    file: await stdinResolver.resolveList(options.file, "--file"),
    test: await stdinResolver.resolveList(options.test, "--test"),
    doc: await stdinResolver.resolveList(options.doc, "--doc"),
    reminder: await stdinResolver.resolveList(options.reminder, "--reminder"),
    event: await stdinResolver.resolveList(options.event, "--event"),
    typeOption: await stdinResolver.resolveList(options.typeOption, "--type-option"),
    field: await stdinResolver.resolveList(options.field, "--field"),
  };
}

function resolveCreateMode(createMode: string | undefined, defaultMode: CreateMode): CreateMode {
  if (createMode === undefined) {
    return defaultMode;
  }
  const normalized = createMode.trim().toLowerCase();
  if (normalized.length === 0) {
    return defaultMode;
  }
  if (normalized === "strict" || normalized === "progressive") {
    return normalized;
  }
  throw new PmCliError(
    `Invalid --create-mode value "${createMode}". Allowed: ${CREATE_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function resolveScheduleCreatePreset(raw: string | undefined): ScheduleCreatePreset | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new PmCliError("--schedule-preset must not be empty", EXIT_CODE.USAGE);
  }
  if (normalized === "lightweight" || normalized === "lite" || normalized === "schedule-lite") {
    return "lightweight";
  }
  throw new PmCliError(
    `Invalid --schedule-preset value "${raw}". Allowed: ${SCHEDULE_CREATE_PRESET_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function resolveEffectiveCreateMode(
  createMode: string | undefined,
  schedulePreset: ScheduleCreatePreset | undefined,
  defaultMode: CreateMode,
): CreateMode {
  const resolvedMode = resolveCreateMode(createMode, defaultMode);
  if (schedulePreset === undefined) {
    return resolvedMode;
  }
  const createModeWasExplicit = typeof createMode === "string" && createMode.trim().length > 0;
  if (createModeWasExplicit && resolvedMode === "strict") {
    throw new PmCliError(
      "--schedule-preset lightweight cannot be combined with --create-mode strict. Use --create-mode progressive or omit --create-mode.",
      EXIT_CODE.USAGE,
    );
  }
  return "progressive";
}

function requireCreateOptionByType(
  typeDefinition: ResolvedItemTypeDefinition,
  options: CreateCommandOptions,
  createMode: CreateMode,
  clearOptionKeys: Set<string>,
): string[] {
  const typeName = typeDefinition.name;
  const scalarValues: Record<string, unknown> = {
    title: options.title,
    description: options.description,
    type: options.type,
    status: options.status,
    priority: options.priority,
    tags: options.tags,
    body: options.body,
    deadline: options.deadline,
    estimatedMinutes: options.estimatedMinutes,
    acceptanceCriteria: options.acceptanceCriteria,
    definitionOfReady: options.definitionOfReady,
    order: options.order ?? options.rank,
    goal: options.goal,
    objective: options.objective,
    value: options.value,
    impact: options.impact,
    outcome: options.outcome,
    whyNow: options.whyNow,
    author: options.author,
    message: options.message,
    assignee: options.assignee,
    parent: options.parent,
    reviewer: options.reviewer,
    risk: options.risk,
    confidence: options.confidence,
    sprint: options.sprint,
    release: options.release,
    blockedBy: options.blockedBy,
    blockedReason: options.blockedReason,
    unblockNote: options.unblockNote,
    reporter: options.reporter,
    severity: options.severity,
    environment: options.environment,
    reproSteps: options.reproSteps,
    resolution: options.resolution,
    expectedResult: options.expectedResult,
    actualResult: options.actualResult,
    affectedVersion: options.affectedVersion,
    fixedVersion: options.fixedVersion,
    component: options.component,
    regression: options.regression,
    customerImpact: options.customerImpact,
  };
  const repeatableValues: Record<string, unknown> = {
    dep: options.dep,
    comment: options.comment,
    note: options.note,
    learning: options.learning,
    file: options.file,
    test: options.test,
    doc: options.doc,
    reminder: options.reminder,
    event: options.event,
    typeOption: options.typeOption,
    field: options.field,
  };

  const hasOptionValue = (optionKey: string): boolean => {
    // `--add-tags` mutates the same `tags` field as `--tags`, so it must count
    // toward the `tags` command_option_policy (both the disabled guard and the
    // required check) — otherwise `--add-tags` would bypass a rule disabling
    // tags, or fail to satisfy a rule requiring them even though the created
    // item ends up tagged.
    if (optionKey === "tags") {
      return scalarValues.tags !== undefined || (Array.isArray(options.addTags) && options.addTags.length > 0);
    }
    if (optionKey in scalarValues) {
      return scalarValues[optionKey] !== undefined;
    }
    /* c8 ignore start -- policy probes only pass canonical CREATE_COMMAND_OPTION_KEYS, all of which exist in scalarValues/repeatableValues, so the in-repeatableValues false arm and trailing return are unreachable. */
    if (optionKey in repeatableValues) {
      const value = repeatableValues[optionKey];
      return Array.isArray(value) && value.length > 0;
    }
    return false;
    /* c8 ignore stop */
  };
  /* c8 ignore next -- policy probes only pass normalized option keys in command-level tests. */
  const hasOptionMutation = (optionKey: string): boolean => hasOptionValue(optionKey) || clearOptionKeys.has(optionKey);

  const baseRequiredOptions = new Set<string>(["title", "type"]);
  if (createMode === "strict") {
    for (const field of typeDefinition.required_create_fields) {
      baseRequiredOptions.add(normalizeCreatePolicyOptionKey(field, typeName, "required_create_fields"));
    }
    for (const field of typeDefinition.required_create_repeatables) {
      baseRequiredOptions.add(normalizeCreatePolicyOptionKey(field, typeName, "required_create_repeatables"));
    }
  }

  const policyState = resolveCommandOptionPolicyState(typeDefinition, "create", baseRequiredOptions);
  if (policyState.errors.length > 0) {
    throw new PmCliError(policyState.errors.join("; "), EXIT_CODE.CONFLICT);
  }

  for (const option of policyState.disabled) {
    if (hasOptionMutation(option)) {
      throw new PmCliError(
        `Option ${commandOptionFlagLabel("create", option)} is disabled for type "${typeName}" by command_option_policies`,
        EXIT_CODE.USAGE,
      );
    }
  }

  if (createMode === "strict") {
    const strictRequiredClears = policyState.required.filter((required) => clearOptionKeys.has(required));
    if (strictRequiredClears.length > 0) {
      /* c8 ignore next -- deterministic ordering fallback only matters when required clear list contains locale ties. */
      const requiredFlags = [...new Set(strictRequiredClears.map((required) => commandOptionFlagLabel("create", required)))].sort(
        (left, right) => left.localeCompare(right),
      );
      /* c8 ignore next -- strict clear conflict envelope is covered by policy integration scenarios. */
      throw new PmCliError(
        `Strict create mode requires concrete values for ${requiredFlags.join(", ")}; --unset/--clear-* directives cannot satisfy required options`,
        EXIT_CODE.USAGE,
      );
    }
  }

  // A configured per-type default_status satisfies a required `status` policy:
  // when --status is omitted, runCreate resolves to that default (or degrades to
  // the workflow open status), so blocking the agent for a "missing --status"
  // would contradict the config-driven default. Scoped to status so an explicit
  // status-required policy on a type WITHOUT a default still holds. Only the
  // required check is relaxed; the disabled check above keeps using hasOptionValue.
  const satisfiesRequiredOption = (optionKey: string): boolean => {
    if (optionKey === "status" && typeDefinition.default_status !== undefined) {
      return true;
    }
    return hasOptionValue(optionKey);
  };
  const missingRequiredOptions = policyState.required.filter((required) => !satisfiesRequiredOption(required));
  return [...new Set(missingRequiredOptions.map((required) => commandOptionFlagLabel("create", required)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

const MISSING_REQUIRED_TYPE_OPTION_PATTERN = /^Missing required type option "([^"]+)" for type "([^"]+)"$/;

function collectMissingRequiredTypeOptionKeys(errors: string[], typeName: string): string[] {
  const missingKeys: string[] = [];
  for (const error of errors) {
    const match = error.match(MISSING_REQUIRED_TYPE_OPTION_PATTERN);
    if (!match) {
      continue;
    }
    if (match[2] !== typeName) {
      continue;
    }
    missingKeys.push(match[1]);
  }
  return [...new Set(missingKeys)].sort((left, right) => left.localeCompare(right));
}

function filterNonMissingTypeOptionErrors(errors: string[], typeName: string): string[] {
  return errors.filter((error) => {
    const match = error.match(MISSING_REQUIRED_TYPE_OPTION_PATTERN);
    return !match || match[2] !== typeName;
  });
}

function typeOptionExampleValue(typeDefinition: ResolvedItemTypeDefinition, key: string): string {
  const optionDefinition = typeDefinition.options.find((option) => option.key === key);
  const firstAllowed = optionDefinition?.values[0];
  if (typeof firstAllowed === "string" && firstAllowed.trim().length > 0) {
    return firstAllowed;
  }
  return "<value>";
}

function createExampleTokensForFlag(flag: string, typeName: string, openStatus: string): string[] {
  switch (flag) {
    case "--title":
      return ["--title", `"${typeName} example title"`];
    case "--description":
      return ["--description", `"${typeName} example description"`];
    case "--type":
      return ["--type", typeName];
    case "--status":
      return ["--status", openStatus];
    case "--priority":
      return ["--priority", "1"];
    case "--message":
      return ["--message", `"Create ${typeName} item"`];
    case "--dep":
      return ["--dep", "\"id=pm-xxxx,kind=related,author=maintainer,created_at=now\""];
    case "--comment":
      return ["--comment", "\"author=maintainer,created_at=now,text=Implementation context\""];
    case "--note":
      return ["--note", "\"author=maintainer,created_at=now,text=Design note\""];
    case "--learning":
      return ["--learning", "\"author=maintainer,created_at=now,text=Durable lesson\""];
    case "--file":
      return ["--file", "\"path=src/example.ts,note=implementation file\""];
    case "--test":
      return ["--test", "\"command=node scripts/run-tests.mjs test,timeout_seconds=240\""];
    case "--doc":
      return ["--doc", "\"path=README.md,note=reference doc\""];
    default:
      return [flag, "\"<value>\""];
  }
}

function buildTypeSpecificCreateExample(
  typeDefinition: ResolvedItemTypeDefinition,
  missingCreateFlags: string[],
  missingTypeOptionKeys: string[],
  openStatus: string,
): string {
  const tokens = ["pm", "create", "--title", `"${typeDefinition.name} example title"`, "--description", `"${typeDefinition.name} example description"`, "--type", typeDefinition.name];
  const optionalRecommendationFlags = ["--status", "--priority", "--message"];
  const orderedFlags = [...new Set([...optionalRecommendationFlags, ...missingCreateFlags])];
  const includedFlags = new Set<string>(["--title", "--description", "--type"]);
  for (const flag of orderedFlags) {
    if (includedFlags.has(flag)) {
      continue;
    }
    tokens.push(...createExampleTokensForFlag(flag, typeDefinition.name, openStatus));
    includedFlags.add(flag);
  }
  for (const key of missingTypeOptionKeys) {
    const value = typeOptionExampleValue(typeDefinition, key);
    tokens.push("--type-option", `${key}=${value}`);
  }
  return tokens.join(" ");
}

function requireStringOption(value: string | undefined, flag: string): string {
  if (value === undefined) {
    if (flag === "--title") {
      throw new PmCliError(
        'Missing required option --title. Why required: every item needs a human-readable title for lookup, search, and reporting. Retry: pass the title as the first positional argument (example: pm create "Fix login bug" --type Issue) or with --title.',
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(`Missing required option ${flag}`, EXIT_CODE.USAGE);
  }
  return value;
}

function selectAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const candidate = parseOptionalString(explicitAuthor) ?? process.env.PM_AUTHOR ?? settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed || "unknown";
}

function ensurePriority(rawPriority: string | number): 0 | 1 | 2 | 3 | 4 {
  return resolvePriority(rawPriority);
}

function mergeCreateOptionsWithTemplate(
  templateOptions: Record<string, string | string[]>,
  explicitOptions: CreateCommandOptions,
): CreateCommandOptions {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(templateOptions)) {
    merged[key] = Array.isArray(value) ? [...value] : value;
  }
  for (const [key, value] of Object.entries(explicitOptions)) {
    if (value !== undefined) {
      merged[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return merged as CreateCommandOptions;
}

function normalizeExtensionCommandPath(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function hasTemplatesShowHandler(): boolean {
  const registrations = getActiveExtensionRegistrations();
  if (!registrations) {
    return false;
  }
  return registrations.commands.some((entry) => {
    return entry.action === "templates-show" || normalizeExtensionCommandPath(entry.command) === "templates show";
  });
}

function readTemplateOptionsFromRuntimeResult(result: unknown, templateName: string): Record<string, string | string[]> {
  if (typeof result !== "object" || result === null || !("options" in result)) {
    throw new PmCliError(
      `Templates package returned invalid payload for template "${templateName}". Expected an options object.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const options = (result as { options?: unknown }).options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new PmCliError(
      `Templates package returned invalid options for template "${templateName}".`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      normalized[key] = [...value];
      continue;
    }
    throw new PmCliError(
      `Templates package returned unsupported option value for "${key}" in template "${templateName}".`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return normalized;
}

async function loadCreateTemplateOptionsFromRuntime(
  templateName: string,
  global: GlobalOptions,
  pmRoot: string,
): Promise<Record<string, string | string[]>> {
  if (!hasTemplatesShowHandler()) {
    throw new PmCliError(
      `--template requires the templates package. Install it first (for example: pm install templates --project).`,
      EXIT_CODE.USAGE,
    );
  }
  const handlerResult = await runActiveCommandHandler({
    command: "templates show",
    args: [templateName],
    options: {},
    global,
    pm_root: pmRoot,
  });
  if (!handlerResult.handled) {
    const warningSuffix = handlerResult.warnings.length > 0 ? ` (${handlerResult.warnings.join(", ")})` : "";
    throw new PmCliError(
      `Unable to resolve template "${templateName}" via templates package. Run "pm templates show ${templateName}" for details.${warningSuffix}`,
      EXIT_CODE.USAGE,
    );
  }
  /* c8 ignore next -- template runtime success path is covered by package-level integration tests. */
  return readTemplateOptionsFromRuntimeResult(handlerResult.result, templateName);
}

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    /* c8 ignore next -- init guard failures are covered by top-level create command tests. */
    if (!exists) {
      throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
    }
  });
}

export async function runCreate(options: CreateCommandOptions, global: GlobalOptions): Promise<CreateResult> {
  let resolvedOptions = normalizeLegacyNoneCreateOptions(await resolveCreateStdinInputs(options));
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  if (resolvedOptions.template !== undefined) {
    const templateName = resolvedOptions.template.trim();
    if (templateName.length === 0) {
      throw new PmCliError("--template must not be empty. Omit --template to disable template usage.", EXIT_CODE.USAGE);
    }
    /* c8 ignore next -- template merge path is exercised in templates package integration tests. */
    const templateOptions = await loadCreateTemplateOptionsFromRuntime(templateName, global, pmRoot);
    resolvedOptions = normalizeLegacyNoneCreateOptions(mergeCreateOptionsWithTemplate(templateOptions, resolvedOptions));
  }
  if (resolvedOptions.type === undefined) {
    // Default-type fallback is suppressed under explicit --create-mode strict, where the strict
    // required-option contract takes precedence and surfaces the missing_required_option envelope.
    /* c8 ignore next -- explicit strict-mode template interactions are exercised in governance integration tests. */
    const explicitStrictMode = typeof resolvedOptions.createMode === "string"
      && resolvedOptions.createMode.trim().toLowerCase() === "strict";
    if (!explicitStrictMode) {
      /* c8 ignore next -- governance default-type fallback is validated in governance integration tests. */
      const defaultType = settings.governance.create_default_type?.trim();
      if (defaultType && defaultType.length > 0 && resolveTypeName(defaultType, typeRegistry)) {
        resolvedOptions.type = defaultType;
      } else {
        /* c8 ignore start -- "Task" is a built-in type present in every default registry; reaching the false arm requires a custom schema that removed Task with no create_default_type configured. */
        if (resolveTypeName("Task", typeRegistry)) {
          resolvedOptions.type = "Task";
        }
        /* c8 ignore stop */
      }
    }
  }
  /* c8 ignore start -- missing/invalid type fallback guards are exercised by create command integration suites. */
  if (resolvedOptions.type === undefined) {
    throw new PmCliError("Missing required option --type <value>", EXIT_CODE.USAGE);
  }
  let resolvedTypeName = resolveTypeName(resolvedOptions.type, typeRegistry);
  if (!resolvedTypeName) {
    // Never block on a near-miss type: map a known synonym (e.g. Bug -> Issue,
    // Change -> Chore) to its canonical built-in type when that type exists in the
    // active registry, and tell the agent how to make it a distinct custom type.
    const synonymCanonical = resolveTypeSynonym(resolvedOptions.type);
    const synonymResolved = synonymCanonical ? resolveTypeName(synonymCanonical, typeRegistry) : undefined;
    if (synonymResolved) {
      printError(
        `[pm] note: type '${resolvedOptions.type.trim()}' is not defined; using closest match '${synonymResolved}'. Run 'pm schema add-type "${resolvedOptions.type.trim()}"' to track it as a distinct type.`,
      );
      resolvedOptions.type = synonymResolved;
      resolvedTypeName = synonymResolved;
    } else {
      throw new PmCliError(
        buildInvalidTypeError(resolvedOptions.type, typeRegistry.types, resolveItemTypesFilePath(pmRoot, settings.schema)),
        EXIT_CODE.USAGE,
      );
    }
  }
  /* c8 ignore stop */
  const typeDefinition = resolveTypeDefinition(resolvedTypeName, typeRegistry);
  /* c8 ignore start -- resolvedTypeName came from resolveTypeName succeeding, so resolveTypeDefinition always returns a definition here. */
  if (!typeDefinition) {
    throw new PmCliError(`Invalid type value "${resolvedOptions.type}"`, EXIT_CODE.USAGE);
  }
  /* c8 ignore stop */
  const type = typeDefinition.name;
  const schedulePreset = resolveScheduleCreatePreset(resolvedOptions.schedulePreset);
  /* c8 ignore next -- schedule preset/type compatibility conflicts are validated in scheduler integration tests. */
  if (schedulePreset !== undefined && !SCHEDULE_CREATE_PRESET_TYPES.has(type)) {
    throw new PmCliError(
      `--schedule-preset ${schedulePreset} is only supported for Reminder, Meeting, or Event types`,
      EXIT_CODE.USAGE,
    );
  }
  const createMode = resolveEffectiveCreateMode(
    resolvedOptions.createMode,
    schedulePreset,
    settings.governance.create_mode_default,
  );
  const unsetTargets = parseCreateUnsetTargets(resolvedOptions.unset, runtimeFieldRegistry);
  const explicitUnsets = new Set<string>(unsetTargets.frontMatterKeys);
  const clearOptionKeys = new Set<string>(unsetTargets.optionKeys);

  const clearCollectionDefinitions: ReadonlyArray<{
    enabled: boolean | undefined;
    optionKey: string;
    clearFlag: string;
    valueFlag: string;
    values: string[] | undefined;
    frontMatterKey: string;
  }> = [
    {
      enabled: resolvedOptions.clearDeps,
      optionKey: "dep",
      clearFlag: "--clear-deps",
      valueFlag: "--dep",
      values: resolvedOptions.dep,
      frontMatterKey: "dependencies",
    },
    {
      enabled: resolvedOptions.clearComments,
      optionKey: "comment",
      clearFlag: "--clear-comments",
      valueFlag: "--comment",
      values: resolvedOptions.comment,
      frontMatterKey: "comments",
    },
    {
      enabled: resolvedOptions.clearNotes,
      optionKey: "note",
      clearFlag: "--clear-notes",
      valueFlag: "--note",
      values: resolvedOptions.note,
      frontMatterKey: "notes",
    },
    {
      enabled: resolvedOptions.clearLearnings,
      optionKey: "learning",
      clearFlag: "--clear-learnings",
      valueFlag: "--learning",
      values: resolvedOptions.learning,
      frontMatterKey: "learnings",
    },
    {
      enabled: resolvedOptions.clearFiles,
      optionKey: "file",
      clearFlag: "--clear-files",
      valueFlag: "--file",
      values: resolvedOptions.file,
      frontMatterKey: "files",
    },
    {
      enabled: resolvedOptions.clearTests,
      optionKey: "test",
      clearFlag: "--clear-tests",
      valueFlag: "--test",
      values: resolvedOptions.test,
      frontMatterKey: "tests",
    },
    {
      enabled: resolvedOptions.clearDocs,
      optionKey: "doc",
      clearFlag: "--clear-docs",
      valueFlag: "--doc",
      values: resolvedOptions.doc,
      frontMatterKey: "docs",
    },
    {
      enabled: resolvedOptions.clearReminders,
      optionKey: "reminder",
      clearFlag: "--clear-reminders",
      valueFlag: "--reminder",
      values: resolvedOptions.reminder,
      frontMatterKey: "reminders",
    },
    {
      enabled: resolvedOptions.clearEvents,
      optionKey: "event",
      clearFlag: "--clear-events",
      valueFlag: "--event",
      values: resolvedOptions.event,
      frontMatterKey: "events",
    },
    {
      enabled: resolvedOptions.clearTypeOptions,
      optionKey: "typeOption",
      clearFlag: "--clear-type-options",
      valueFlag: "--type-option",
      values: resolvedOptions.typeOption,
      frontMatterKey: "type_options",
    },
  ];
  for (const definition of clearCollectionDefinitions) {
    if (!definition.enabled) {
      continue;
    }
    /* c8 ignore next -- clear+value conflict paths are covered by command-surface parser tests. */
    if (definition.values && definition.values.length > 0) {
      throw new PmCliError(`Cannot combine ${definition.clearFlag} with ${definition.valueFlag}`, EXIT_CODE.USAGE);
    }
    explicitUnsets.add(definition.frontMatterKey);
    clearOptionKeys.add(definition.optionKey);
  }

  const scalarOptionPresence: Record<string, boolean> = {
    tags: resolvedOptions.tags !== undefined,
    deadline: resolvedOptions.deadline !== undefined,
    estimatedMinutes: resolvedOptions.estimatedMinutes !== undefined,
    acceptanceCriteria: resolvedOptions.acceptanceCriteria !== undefined,
    /* c8 ignore next -- definitionOfReady option presence is covered by legacy migration tests. */
    definitionOfReady: resolvedOptions.definitionOfReady !== undefined,
    order: resolvedOptions.order !== undefined || resolvedOptions.rank !== undefined,
    goal: resolvedOptions.goal !== undefined,
    objective: resolvedOptions.objective !== undefined,
    value: resolvedOptions.value !== undefined,
    impact: resolvedOptions.impact !== undefined,
    outcome: resolvedOptions.outcome !== undefined,
    whyNow: resolvedOptions.whyNow !== undefined,
    author: resolvedOptions.author !== undefined,
    assignee: resolvedOptions.assignee !== undefined,
    parent: resolvedOptions.parent !== undefined,
    reviewer: resolvedOptions.reviewer !== undefined,
    risk: resolvedOptions.risk !== undefined,
    confidence: resolvedOptions.confidence !== undefined,
    sprint: resolvedOptions.sprint !== undefined,
    release: resolvedOptions.release !== undefined,
    blockedBy: resolvedOptions.blockedBy !== undefined,
    blockedReason: resolvedOptions.blockedReason !== undefined,
    unblockNote: resolvedOptions.unblockNote !== undefined,
    reporter: resolvedOptions.reporter !== undefined,
    severity: resolvedOptions.severity !== undefined,
    environment: resolvedOptions.environment !== undefined,
    reproSteps: resolvedOptions.reproSteps !== undefined,
    resolution: resolvedOptions.resolution !== undefined,
    expectedResult: resolvedOptions.expectedResult !== undefined,
    actualResult: resolvedOptions.actualResult !== undefined,
    affectedVersion: resolvedOptions.affectedVersion !== undefined,
    fixedVersion: resolvedOptions.fixedVersion !== undefined,
    component: resolvedOptions.component !== undefined,
    regression: resolvedOptions.regression !== undefined,
    customerImpact: resolvedOptions.customerImpact !== undefined,
  };
  /* c8 ignore next -- scalar unset conflict checks are covered by update/create argument contract tests. */
  for (const [optionKey, hasValue] of Object.entries(scalarOptionPresence)) {
    if (!hasValue || !unsetTargets.optionKeys.has(optionKey)) {
      continue;
    }
    /* c8 ignore start -- every scalarOptionPresence key is in CREATE_OPTION_KEY_TO_UNSET_CANONICAL, so the `?? optionKey` fallback is unreachable. */
    const unsetField = CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey;
    /* c8 ignore stop */
    throw new PmCliError(
      `Cannot combine --unset ${unsetField} with ${commandOptionFlagLabel("create", optionKey)}`,
      EXIT_CODE.USAGE,
    );
  }

  const assertNoLegacyScalarToken = (value: string | undefined, optionKey: string): void => {
    const unsetField = CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey);
    const hint = unsetField ? `Use --unset ${unsetField} to clear this field.` : undefined;
    assertNoLegacyNoneToken(value, commandOptionFlagLabel("create", optionKey), hint);
  };
  assertNoLegacyScalarToken(resolvedOptions.tags, "tags");
  assertNoLegacyScalarToken(resolvedOptions.deadline, "deadline");
  assertNoLegacyScalarToken(resolvedOptions.estimatedMinutes, "estimatedMinutes");
  assertNoLegacyScalarToken(resolvedOptions.acceptanceCriteria, "acceptanceCriteria");
  /* c8 ignore next -- legacy none-token guard for definitionOfReady is covered in compatibility test suites. */
  assertNoLegacyScalarToken(resolvedOptions.definitionOfReady, "definitionOfReady");
  assertNoLegacyScalarToken(resolvedOptions.order ?? resolvedOptions.rank, "order");
  assertNoLegacyScalarToken(resolvedOptions.goal, "goal");
  assertNoLegacyScalarToken(resolvedOptions.objective, "objective");
  assertNoLegacyScalarToken(resolvedOptions.value, "value");
  assertNoLegacyScalarToken(resolvedOptions.impact, "impact");
  assertNoLegacyScalarToken(resolvedOptions.outcome, "outcome");
  assertNoLegacyScalarToken(resolvedOptions.whyNow, "whyNow");
  assertNoLegacyScalarToken(resolvedOptions.author, "author");
  assertNoLegacyScalarToken(resolvedOptions.assignee, "assignee");
  assertNoLegacyScalarToken(resolvedOptions.parent, "parent");
  assertNoLegacyScalarToken(resolvedOptions.reviewer, "reviewer");
  assertNoLegacyScalarToken(resolvedOptions.risk, "risk");
  assertNoLegacyScalarToken(resolvedOptions.confidence, "confidence");
  assertNoLegacyScalarToken(resolvedOptions.sprint, "sprint");
  assertNoLegacyScalarToken(resolvedOptions.release, "release");
  assertNoLegacyScalarToken(resolvedOptions.blockedBy, "blockedBy");
  assertNoLegacyScalarToken(resolvedOptions.blockedReason, "blockedReason");
  assertNoLegacyScalarToken(resolvedOptions.unblockNote, "unblockNote");
  assertNoLegacyScalarToken(resolvedOptions.reporter, "reporter");
  assertNoLegacyScalarToken(resolvedOptions.severity, "severity");
  assertNoLegacyScalarToken(resolvedOptions.environment, "environment");
  assertNoLegacyScalarToken(resolvedOptions.reproSteps, "reproSteps");
  assertNoLegacyScalarToken(resolvedOptions.resolution, "resolution");
  assertNoLegacyScalarToken(resolvedOptions.expectedResult, "expectedResult");
  assertNoLegacyScalarToken(resolvedOptions.actualResult, "actualResult");
  assertNoLegacyScalarToken(resolvedOptions.affectedVersion, "affectedVersion");
  assertNoLegacyScalarToken(resolvedOptions.fixedVersion, "fixedVersion");
  assertNoLegacyScalarToken(resolvedOptions.component, "component");
  assertNoLegacyScalarToken(resolvedOptions.regression, "regression");
  assertNoLegacyScalarToken(resolvedOptions.customerImpact, "customerImpact");

  const missingRequiredCreateFlags = requireCreateOptionByType(typeDefinition, resolvedOptions, createMode, clearOptionKeys);
  const nowValue = nowIso();
  const author = selectAuthor(resolvedOptions.author, settings.author_default);

  const dependencies = parseDependencies(resolvedOptions.dep, nowValue, settings.id_prefix);
  const comments = parseLogSeed("--comment", resolvedOptions.comment, nowValue, author);
  const notes = parseLogSeed("--note", resolvedOptions.note, nowValue, author);
  const learnings = parseLogSeed("--learning", resolvedOptions.learning, nowValue, author);
  const files = parseFiles(resolvedOptions.file);
  const tests = parseTests(resolvedOptions.test);
  const docs = parseDocs(resolvedOptions.doc);
  const reminders = parseReminders(resolvedOptions.reminder, nowValue);
  const events = parseEvents(resolvedOptions.event, nowValue);
  const typeOptions = parseTypeOptions(resolvedOptions.typeOption);
  const validatedTypeOptions = validateTypeOptions(type, typeOptions.values, typeRegistry);
  const extensionRegistrations = getActiveExtensionRegistrations();
  const extensionFieldNames = collectRegisteredItemFieldNames(extensionRegistrations);
  const registeredItemFieldValues = parseRegisteredItemFieldAssignments(resolvedOptions.field, extensionRegistrations);
  for (const fieldKey of Object.keys(registeredItemFieldValues)) {
    if (!unsetTargets.frontMatterKeys.has(fieldKey)) {
      continue;
    }
    throw new PmCliError(`Cannot combine --unset ${fieldKey.replaceAll("_", "-")} with --field ${fieldKey}=...`, EXIT_CODE.USAGE);
  }
  const runtimeCreateFieldValues = collectRuntimeCreateFieldValues(
    resolvedOptions as Record<string, unknown>,
    runtimeFieldRegistry,
    type,
  );
  /* c8 ignore start -- collectRuntimeCreateFieldValues always returns a `values` object, so the `?? {}` fallback is unreachable. */
  for (const fieldKey of Object.keys(runtimeCreateFieldValues.values ?? {})) {
    /* c8 ignore stop */
    if (!unsetTargets.frontMatterKeys.has(fieldKey)) {
      continue;
    }
    throw new PmCliError(`Cannot combine --unset ${fieldKey.replaceAll("_", "-")} with its value flag`, EXIT_CODE.USAGE);
  }
  const missingRequiredTypeOptionKeys = collectMissingRequiredTypeOptionKeys(validatedTypeOptions.errors, type);
  const missingRequiredTypeOptionFlags = missingRequiredTypeOptionKeys.map((key) => `--type-option ${key}=<value>`);
  const combinedMissingFlags = [
    ...new Set([
      ...missingRequiredCreateFlags,
      ...missingRequiredTypeOptionFlags,
      /* c8 ignore next -- runtime-required flag aggregation is covered in runtime schema create tests. */
      ...runtimeCreateFieldValues.missing_required_flags,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (combinedMissingFlags.length > 0) {
    const nextValidExample = buildTypeSpecificCreateExample(
      typeDefinition,
      missingRequiredCreateFlags,
      missingRequiredTypeOptionKeys,
      statusRegistry.open_status,
    );
    const nextSteps = [`Run "pm create --help --type ${type}" for type-aware required option guidance.`];
    if (combinedMissingFlags.includes("--title")) {
      nextSteps.push('Title can also be passed as the first positional argument (example: pm create "Your title" --type ' + type + ').');
    }
    if (createMode === "strict") {
      nextSteps.push('For staged onboarding, retry with "--create-mode progressive".');
      if (SCHEDULE_CREATE_PRESET_TYPES.has(type)) {
        nextSteps.push('For minimal scheduling inputs, try "--schedule-preset lightweight".');
      }
    }
    const errorMessage =
      combinedMissingFlags.length === 1
        ? `Missing required option ${combinedMissingFlags[0]} for type "${type}"`
        : `Missing required options ${combinedMissingFlags.join(", ")} for type "${type}"`;
    throw new PmCliError(errorMessage, EXIT_CODE.USAGE, {
      code: "missing_required_option",
      required: `Provide all required create options and type options for type "${type}" in one invocation.`,
      examples: [nextValidExample],
      nextSteps,
      recovery: createMode === "strict"
        ? {
            recovery_mode: "compact",
            missing_required_fields: combinedMissingFlags,
            suggested_flags: ["--create-mode progressive", ...combinedMissingFlags],
          }
        : undefined,
    });
  }
  const nonMissingTypeOptionErrors = filterNonMissingTypeOptionErrors(validatedTypeOptions.errors, type);
  if (nonMissingTypeOptionErrors.length > 0) {
    const nextValidExample = buildTypeSpecificCreateExample(typeDefinition, [], [], statusRegistry.open_status);
    throw new PmCliError(nonMissingTypeOptionErrors.join("; "), EXIT_CODE.USAGE, {
      code: "invalid_argument_value",
      required: `Provide valid --type-option key/value pairs for type "${type}".`,
      examples: [nextValidExample],
      nextSteps: [`Run "pm create --help --type ${type}" to review allowed type-option keys and values.`],
    });
  }

  const id = await generateItemId(pmRoot, settings.id_prefix);
  let status =
    resolvedOptions.status !== undefined
      ? parseStatusValue(resolvedOptions.status, statusRegistry)
      : resolveCreateDefaultStatus(typeDefinition, statusRegistry);
  const priority = resolvedOptions.priority !== undefined ? ensurePriority(resolvedOptions.priority) : 2;
  // `--unset tags` clears the field; combining it with `--add-tags` is the same
  // contradiction that `--unset tags --tags ...` already rejects, so reject it
  // here rather than silently letting the additions win over the clear.
  if (
    unsetTargets.frontMatterKeys.has("tags") &&
    Array.isArray(resolvedOptions.addTags) &&
    resolvedOptions.addTags.length > 0
  ) {
    throw new PmCliError("Cannot combine --unset tags with --add-tags", EXIT_CODE.USAGE);
  }
  const baseTags = unsetTargets.frontMatterKeys.has("tags")
    ? []
    : resolvedOptions.tags !== undefined
      ? parseTags(resolvedOptions.tags)
      : [];
  const tags = mergeAdditiveTags(baseTags, resolvedOptions.addTags);

  const deadline = unsetTargets.frontMatterKeys.has("deadline")
    ? undefined
    : resolvedOptions.deadline === undefined
      ? undefined
      : resolveIsoOrRelative(resolvedOptions.deadline, new Date(nowValue), "deadline");
  const estimatedMinutes = unsetTargets.frontMatterKeys.has("estimated_minutes")
    ? undefined
    : resolvedOptions.estimatedMinutes === undefined
      ? undefined
      : parseOptionalNumber(resolvedOptions.estimatedMinutes, "estimated-minutes");
  const acceptanceCriteria = unsetTargets.frontMatterKeys.has("acceptance_criteria")
    ? undefined
    : resolvedOptions.acceptanceCriteria === undefined
      ? undefined
      : resolvedOptions.acceptanceCriteria;
  const definitionOfReady =
    unsetTargets.frontMatterKeys.has("definition_of_ready") || resolvedOptions.definitionOfReady === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.definitionOfReady);
  if (
    resolvedOptions.order !== undefined &&
    resolvedOptions.rank !== undefined &&
    resolvedOptions.order !== resolvedOptions.rank
  ) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }
  const orderRaw = resolvedOptions.order ?? resolvedOptions.rank;
  const order =
    unsetTargets.frontMatterKeys.has("order") || orderRaw === undefined ? undefined : parseOptionalNumber(orderRaw, "order");
  if (order !== undefined && !Number.isInteger(order)) {
    throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
  }
  const goal =
    unsetTargets.frontMatterKeys.has("goal") || resolvedOptions.goal === undefined ? undefined : parseOptionalString(resolvedOptions.goal);
  const objective =
    unsetTargets.frontMatterKeys.has("objective") || resolvedOptions.objective === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.objective);
  const value =
    unsetTargets.frontMatterKeys.has("value") || resolvedOptions.value === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.value);
  const impact =
    unsetTargets.frontMatterKeys.has("impact") || resolvedOptions.impact === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.impact);
  const outcome =
    unsetTargets.frontMatterKeys.has("outcome") || resolvedOptions.outcome === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.outcome);
  const whyNow =
    unsetTargets.frontMatterKeys.has("why_now") || resolvedOptions.whyNow === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.whyNow);
  const assignee =
    unsetTargets.frontMatterKeys.has("assignee") || resolvedOptions.assignee === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.assignee);
  const authorValue = unsetTargets.frontMatterKeys.has("author")
    ? undefined
    : parseOptionalString(resolvedOptions.author) ?? author;
  let parent =
    unsetTargets.frontMatterKeys.has("parent") || resolvedOptions.parent === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.parent);
  // GH-161 (pm-72xf): when no explicit --parent was given (and parent is not
  // being unset), default the parent to the session "focused" item set via
  // `pm focus <id>`. An explicit --parent (even `--parent ""` to unset)
  // overrides focus. The inherited value flows through the same locateItem /
  // validateMissingParentReference path below, so a stale focus produces the
  // same clear missing-parent error/warning as an explicit stale --parent.
  let parentSource: "focus" | undefined;
  if (
    parent === undefined &&
    !unsetTargets.frontMatterKeys.has("parent") &&
    resolvedOptions.parent === undefined
  ) {
    const focused = await getFocusedItem(pmRoot);
    if (focused !== undefined) {
      parent = focused;
      parentSource = "focus";
    }
  }
  const reviewer =
    unsetTargets.frontMatterKeys.has("reviewer") || resolvedOptions.reviewer === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.reviewer);
  const riskRaw =
    unsetTargets.frontMatterKeys.has("risk") || resolvedOptions.risk === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.risk);
  const risk = riskRaw !== undefined ? ensureEnumValue(normalizeRiskInput(riskRaw), RISK_VALUES, "risk") : undefined;
  const confidenceRaw =
    unsetTargets.frontMatterKeys.has("confidence") || resolvedOptions.confidence === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.confidence);
  const confidence = confidenceRaw !== undefined ? parseConfidenceInput(confidenceRaw) : undefined;
  const parentReferencePolicy =
    resolvedOptions.allowMissingParent === true && settings.validation.parent_reference === "strict_error"
      ? "warn"
      : settings.validation.parent_reference;
  const sprintReleasePolicy = settings.validation.sprint_release_format;
  const validationWarnings: string[] = [];
  // Event-type items with no attached schedule never surface on the calendar; warn (never block).
  if (type.toLowerCase() === "event" && (events.values === undefined || events.values.length === 0)) {
    validationWarnings.push(`event_without_schedule:${id}:no_time_set`);
  }
  // Calendar-relevant types (Milestone, Meeting, Reminder, Event) with NO deadline AND no
  // reminders AND no events are invisible on `pm calendar`. Warn (never block) so the agent
  // can attach a schedule via `pm update`.
  const calendarRelevantTypes = new Set(["milestone", "meeting", "reminder", "event"]);
  const hasDeadline = deadline !== undefined;
  const hasReminders = reminders.values !== undefined && reminders.values.length > 0;
  const hasEvents = events.values !== undefined && events.values.length > 0;
  if (calendarRelevantTypes.has(type.toLowerCase()) && !hasDeadline && !hasReminders && !hasEvents) {
    // Keep the structured `calendar_item_without_schedule:<id>:<code>` prefix
    // stable (automation/telemetry match on it) and append the actionable hint
    // after the token (pm-2cgu / GH-174).
    validationWarnings.push(
      `calendar_item_without_schedule:${id}:no_deadline_or_reminder_or_event (hint: set --deadline <ISO> or --reminder "<when>", or link an Event via --event "start=<ISO>,end=<ISO>"; otherwise this item never appears on pm calendar)`,
    );
  }
  if (parent !== undefined) {
    parent = normalizeParentReferenceValue(parent);
    const parentLocated = await locateItem(pmRoot, parent, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!parentLocated) {
      const normalizedParentId = normalizeItemId(parent, settings.id_prefix);
      validationWarnings.push(...validateMissingParentReference(normalizedParentId, parentReferencePolicy).warnings);
    }
  }
  let sprint =
    unsetTargets.frontMatterKeys.has("sprint") || resolvedOptions.sprint === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.sprint);
  if (sprint !== undefined) {
    const sprintValidation = validateSprintOrReleaseValue("sprint", sprint, sprintReleasePolicy);
    sprint = sprintValidation.value;
    validationWarnings.push(...sprintValidation.warnings);
  }
  let release =
    unsetTargets.frontMatterKeys.has("release") || resolvedOptions.release === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.release);
  if (release !== undefined) {
    const releaseValidation = validateSprintOrReleaseValue("release", release, sprintReleasePolicy);
    release = releaseValidation.value;
    validationWarnings.push(...releaseValidation.warnings);
  }
  const blockedBy =
    unsetTargets.frontMatterKeys.has("blocked_by") || resolvedOptions.blockedBy === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.blockedBy);
  let dependencyValues = dependencies.values;
  if (blockedBy !== undefined) {
    const normalizedBlockedBy = normalizeItemId(blockedBy, settings.id_prefix);
    const blockedByLocated = await locateItem(pmRoot, normalizedBlockedBy, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (blockedByLocated) {
      const hasBlockedByDependency = (dependencyValues ?? []).some(
        (dependency) => dependency.id === blockedByLocated.id && dependency.kind === "blocked_by",
      );
      if (!hasBlockedByDependency) {
        dependencyValues = [
          ...(dependencyValues ?? []),
          {
            id: blockedByLocated.id,
            kind: "blocked_by",
            created_at: nowValue,
            author,
          },
        ];
      }
      if (resolvedOptions.status === undefined) {
        status = statusRegistry.blocked_statuses.has("blocked")
          ? "blocked"
          : [...statusRegistry.blocked_statuses].sort((left, right) => left.localeCompare(right))[0] ?? statusRegistry.open_status;
      }
    }
  }
  const blockedReason =
    unsetTargets.frontMatterKeys.has("blocked_reason") || resolvedOptions.blockedReason === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.blockedReason);
  const unblockNote =
    unsetTargets.frontMatterKeys.has("unblock_note") || resolvedOptions.unblockNote === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.unblockNote);
  const reporter =
    /* c8 ignore next -- reporter normalization branch is covered in issue-template integration tests. */
    unsetTargets.frontMatterKeys.has("reporter") || resolvedOptions.reporter === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.reporter);
  const severityRaw =
    unsetTargets.frontMatterKeys.has("severity") || resolvedOptions.severity === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.severity);
  const severity =
    severityRaw !== undefined ? ensureEnumValue(normalizeSeverityInput(severityRaw), ISSUE_SEVERITY_VALUES, "severity") : undefined;
  const environment =
    unsetTargets.frontMatterKeys.has("environment") || resolvedOptions.environment === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.environment);
  const reproSteps =
    unsetTargets.frontMatterKeys.has("repro_steps") || resolvedOptions.reproSteps === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.reproSteps);
  const resolution =
    unsetTargets.frontMatterKeys.has("resolution") || resolvedOptions.resolution === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.resolution);
  const expectedResult =
    unsetTargets.frontMatterKeys.has("expected_result") || resolvedOptions.expectedResult === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.expectedResult);
  const actualResult =
    unsetTargets.frontMatterKeys.has("actual_result") || resolvedOptions.actualResult === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.actualResult);
  const affectedVersion =
    unsetTargets.frontMatterKeys.has("affected_version") || resolvedOptions.affectedVersion === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.affectedVersion);
  const fixedVersion =
    unsetTargets.frontMatterKeys.has("fixed_version") || resolvedOptions.fixedVersion === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.fixedVersion);
  const component =
    unsetTargets.frontMatterKeys.has("component") || resolvedOptions.component === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.component);
  const regressionRaw =
    unsetTargets.frontMatterKeys.has("regression") || resolvedOptions.regression === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.regression);
  const regression = regressionRaw !== undefined ? parseRegressionInput(regressionRaw) : undefined;
  const customerImpact =
    unsetTargets.frontMatterKeys.has("customer_impact") || resolvedOptions.customerImpact === undefined
      ? undefined
      : parseOptionalString(resolvedOptions.customerImpact);
  const title = requireStringOption(resolvedOptions.title, "--title");
  const description = resolvedOptions.description ?? "";
  const body = resolvedOptions.body ?? "";

  // GH-249: creating an item directly in the close status must honor
  // governance.require_close_reason, just like `pm close` (errors when missing)
  // and `pm update --status closed` (defaults + warns). Record a close_reason
  // derived from --message > --resolution, else a stable placeholder, and warn
  // when defaulted so the create path stops silently bypassing governance.
  let closeReason: string | undefined;
  if (status === statusRegistry.close_status && settings.governance.require_close_reason) {
    const messageText = typeof resolvedOptions.message === "string" ? resolvedOptions.message.trim() : "";
    const resolutionText = typeof resolution === "string" ? resolution.trim() : "";
    closeReason = messageText || resolutionText || CREATE_DIRECT_CLOSE_REASON_DEFAULT;
    if (messageText.length === 0 && resolutionText.length === 0) {
      validationWarnings.push("close_reason_defaulted");
    }
  }

  const frontMatter: ItemMetadata = normalizeFrontMatter({
    id,
    title,
    description,
    type,
    type_options: validatedTypeOptions.normalized,
    status,
    close_reason: closeReason,
    priority,
    tags,
    created_at: nowValue,
    updated_at: nowValue,
    deadline,
    assignee,
    author: authorValue,
    estimated_minutes: estimatedMinutes,
    acceptance_criteria: acceptanceCriteria,
    definition_of_ready: definitionOfReady,
    order,
    goal,
    objective,
    value,
    impact,
    outcome,
    why_now: whyNow,
    parent,
    reviewer,
    risk,
    confidence,
    sprint,
    release,
    blocked_by: blockedBy,
    blocked_reason: blockedReason,
    unblock_note: unblockNote,
    reporter,
    severity,
    environment,
    repro_steps: reproSteps,
    resolution,
    expected_result: expectedResult,
    actual_result: actualResult,
    affected_version: affectedVersion,
    fixed_version: fixedVersion,
    component,
    regression,
    customer_impact: customerImpact,
    dependencies: dependencyValues,
    comments: comments.values as Comment[] | undefined,
    notes: notes.values as LogNote[] | undefined,
    learnings: learnings.values as LogNote[] | undefined,
    files: files.values,
    tests: tests.values,
    docs: docs.values,
    reminders: reminders.values,
    events: events.values,
    ...registeredItemFieldValues,
    /* c8 ignore start -- collectRuntimeCreateFieldValues always returns a `values` object, so the `?? {}` fallback is unreachable. */
    ...(runtimeCreateFieldValues.values ?? {}),
    /* c8 ignore stop */
  });
  try {
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter as unknown as Record<string, unknown>,
      extensionRegistrations,
    );
  } catch (error: unknown) {
    /* c8 ignore start -- applyRegisteredItemFieldDefaultsAndValidation only throws Error instances, so the non-Error message fallback is unreachable. */
    throw new PmCliError(error instanceof Error ? error.message : "Invalid extension item field values", EXIT_CODE.USAGE);
    /* c8 ignore stop */
  }

  const afterDocument: ItemDocument = canonicalDocument(
    {
      metadata: frontMatter,
      body,
    },
    { schema: settings.schema, extensionFieldNames },
  );
  const beforeDocument: ItemDocument = {
    metadata: {} as ItemMetadata,
    body: "",
  };

  const itemPath = getItemPath(pmRoot, type, id, settings.item_format, typeRegistry.type_to_folder);
  const historyPath = getHistoryPath(pmRoot, id);
  const lockRelease = await acquireLock(
    pmRoot,
    id,
    settings.locks.ttl_seconds,
    author,
    false,
    settings.governance.force_required_for_stale_lock,
  );
  const explicitUnsetKeys = [...explicitUnsets].sort((left, right) => left.localeCompare(right));
  const historyMessage = buildHistoryMessage(resolvedOptions.message, explicitUnsetKeys);
  const changedFields = buildChangedFields(frontMatter, body, explicitUnsetKeys, [
    ...Object.keys(registeredItemFieldValues),
    /* c8 ignore start -- collectRuntimeCreateFieldValues always returns a `values` object, so the `?? {}` fallback is unreachable. */
    ...Object.keys(runtimeCreateFieldValues.values ?? {}),
    /* c8 ignore stop */
  ]);
  let hookWarnings: string[] = [];

  try {
    await writeFileAtomic(
      itemPath,
      serializeItemDocument(afterDocument, {
        format: settings.item_format,
        schema: settings.schema,
        extensionFieldNames,
      }),
    );
    try {
      const entry = createHistoryEntry({
        nowIso: nowValue,
        author,
        op: "create",
        before: beforeDocument,
        after: afterDocument,
        message: historyMessage,
      });
      await appendHistoryEntry(historyPath, entry);
    } catch (error: unknown) {
      await removeFileIfExists(itemPath);
      throw error;
    }
    hookWarnings = [
      ...(await runActiveOnWriteHooks({
        path: itemPath,
        scope: "project",
        op: "create",
        item_id: afterDocument.metadata.id,
        item_type: afterDocument.metadata.type,
        before: beforeDocument,
        after: afterDocument,
        changed_fields: changedFields,
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "create:history",
        item_id: afterDocument.metadata.id,
        item_type: afterDocument.metadata.type,
        before: beforeDocument,
        after: afterDocument,
        changed_fields: changedFields,
      })),
    ];
    recordAfterCommandAffectedItem({
      id: afterDocument.metadata.id,
      op: "create",
      item_type: afterDocument.metadata.type,
      status: afterDocument.metadata.status,
      current: projectAfterCommandItemSnapshot(afterDocument.metadata, changedFields),
      changed_fields: changedFields,
    });
  } finally {
    await lockRelease();
  }

  const outputItem = structuredClone(frontMatter);

  // After the create has committed (so the ID is real and shows up in the suggestion),
  // emit a single non-blocking stderr hint when the new item would be invisible on `pm
  // calendar`. The structured `calendar_item_without_schedule:*` warning above is what
  // automation reads; this stderr line is the human/agent-facing version with a
  // copy-pasteable `pm update` recipe.
  if (calendarRelevantTypes.has(type.toLowerCase()) && !hasDeadline && !hasReminders && !hasEvents) {
    printError(
      `[pm] warning: ${type} '${id}' has no deadline/reminder/event — it will not appear on the calendar. Add one via 'pm update ${id} --deadline <ISO>' or 'pm update ${id} --event "start=<ISO>,end=<ISO>"'.`,
    );
  }

  return {
    item: outputItem,
    changed_fields: changedFields,
    warnings: [...validationWarnings, ...hookWarnings],
    ...(parentSource !== undefined ? { parent_source: parentSource } : {}),
  };
}

export const _testOnlyCreateCommand = {
  buildHistoryMessage,
  buildInvalidLogSeedKeysMessage,
  buildTypeSpecificCreateExample,
  collectMissingRequiredTypeOptionKeys,
  createExampleTokensForFlag,
  filterNonMissingTypeOptionErrors,
  hasTemplatesShowHandler,
  loadCreateTemplateOptionsFromRuntime,
  looksLikeStructuredEntry,
  mergeCreateOptionsWithTemplate,
  normalizeCreatePolicyOptionKey,
  normalizeDependencyKindInput,
  normalizeExtensionCommandPath,
  parseCreateUnsetTargets,
  requireStringOption,
  readTemplateOptionsFromRuntimeResult,
  resolveRuntimeCreateUnsetDefinition,
  typeOptionExampleValue,
};
