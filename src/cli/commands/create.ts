/**
 * @module cli/commands/create
 *
 * Implements the pm create command surface and its agent-facing runtime behavior.
 */
import {
  pathExists,
  removeFileIfExists,
  writeFileAtomic,
} from "../../core/fs/fs-utils.js";
import {
  appendHistoryEntry,
  createHistoryEntry,
} from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import {
  canonicalDocument,
  normalizeItemMetadata,
  serializeItemDocument,
} from "../../core/item/item-format.js";
import {
  assertParentReferenceIsNotSelf,
  isPlaceholderReferenceToken,
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import {
  assertNoUnknownCsvKeys,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNonNegativeInteger,
  parseOptionalNumber,
  parseTags,
} from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { getFocusedItem } from "../../core/session/session-state.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { CREATE_DIRECT_CLOSE_REASON_DEFAULT } from "../../core/shared/constants.js";
import {
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  type ItemTypeRegistry,
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
import {
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
} from "../../core/shared/constants.js";
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
import {
  listAllItemMetadataLight,
  locateItem,
} from "../../core/store/item-store.js";
import {
  acquireItemMetadataDerivedIndexLock,
  refreshItemMetadataDerivedIndex,
} from "../../sdk/item-metadata-index.js";
import { collectNewOrderingCycleWarnings } from "../../sdk/graph/mutation-advisory.js";
import {
  getHistoryPath,
  getItemPath,
  getSettingsPath,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import {
  normalizeRiskInput,
  normalizeSeverityInput,
  parseConfidenceInput,
  parseRegressionInput,
} from "./metadata-normalizers.js";
import {
  applyLegacyNoneCollectionNormalizers,
  createLegacyNoneCollectionNormalizers,
  assertNoLegacyNoneToken,
  assertNoLegacyNoneTokens,
  isLegacyNoneToken,
} from "./legacy-none-tokens.js";
import {
  suggestNextLifecycleTransition,
  type LifecycleTransitionSuggestion,
} from "./lifecycle-transitions.js";
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
import {
  looksLikeStructuredLinkedTestEntry,
  normalizeStructuredLinkedTestEntry,
} from "./linked-test-entry.js";
import {
  COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
  COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR,
  parseCommandUnsetTargets,
  resolveRuntimeUnsetFieldDefinition,
  type CommandUnsetFieldDefinition,
} from "./shared-unset-fields.js";
import type {
  MutationMetadataCommandOptions,
  SharedLinkedResourceClearOptions,
  SharedLinkedResourceOptions,
} from "./mutation-command-options.js";
import { ensureEnumValue } from "./recurrence-parsers.js";
import { assertValidBareDependencyFlagValue } from "../../sdk/dependency-flag-validation.js";
import {
  normalizeDependencySeedId,
  normalizeDependencySourceKind,
} from "../../sdk/dependency-provenance.js";
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
  PmSettings,
  Reminder,
} from "../../types/index.js";
import {
  DEPENDENCY_KIND_VALUES,
  ISSUE_SEVERITY_VALUES,
  RISK_VALUES,
  SCOPE_VALUES,
} from "../../types/index.js";

/** Documents the create command options payload exchanged by command, SDK, and package integrations. */
export interface CreateCommandOptions
  extends
    MutationMetadataCommandOptions,
    SharedLinkedResourceOptions,
    SharedLinkedResourceClearOptions {
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Explicit item id, normalized with the workspace prefix instead of randomly generated. */
  id?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string | number;
  /** Value that configures or reports tags for this contract. */
  tags?: string;
  /** Value that configures or reports add tags for this contract. */
  addTags?: string[];
  /** Value that configures or reports body for this contract. */
  body?: string;
  /** Value that configures or reports allow missing parent for this contract. */
  allowMissingParent?: boolean;
  /** Value that configures or reports template for this contract. */
  template?: string;
  /** Creates mode using the validated operation inputs. */
  createMode?: string;
  /** Value that configures or reports schedule preset for this contract. */
  schedulePreset?: string;
  [key: string]: unknown;
}

/** Documents the create result payload exchanged by command, SDK, and package integrations. */
export interface CreateResult {
  /** Value that configures or reports item for this contract. */
  item: ItemMetadata;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  // GH-161: set to "focus" when the item's parent was inherited from the
  // session focused item (`pm focus <id>`) rather than an explicit --parent.
  /** Value that configures or reports parent source for this contract. */
  parent_source?: "focus";
  // GH-216: optional non-binding nudge toward the next lifecycle transition
  // (e.g. `pm start-task <id>`), present only when a richer transition exists.
  /** Value that configures or reports next transition for this contract. */
  next_transition?: LifecycleTransitionSuggestion;
}

type CreateMode = "strict" | "progressive";
const CREATE_MODE_VALUES = ["strict", "progressive"] as const;
type ScheduleCreatePreset = "lightweight";
const SCHEDULE_CREATE_PRESET_VALUES = ["lightweight"] as const;
const SCHEDULE_CREATE_PRESET_TYPES = new Set(["Reminder", "Meeting", "Event"]);
const LOG_SEED_ALLOWED_KEYS = new Set(["author", "created_at", "text"]);

interface CreateUnsetFieldDefinition {
  optionKey: string;
  metadataKey: string;
}

const CREATE_UNSET_FIELD_DEFINITIONS: readonly CommandUnsetFieldDefinition[] = [
  ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_AUTHOR,
  {
    canonical: "author",
    aliases: ["author"],
    optionKey: "author",
    metadataKey: "author",
  },
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
];

const CREATE_UNSET_ALIAS_MAP: Map<string, CreateUnsetFieldDefinition> = (() => {
  const map = new Map<string, CreateUnsetFieldDefinition>();
  for (const definition of CREATE_UNSET_FIELD_DEFINITIONS) {
    for (const alias of definition.aliases) {
      map.set(alias, {
        optionKey: definition.optionKey,
        metadataKey: definition.metadataKey,
      });
    }
  }
  return map;
})();

const CREATE_OPTION_KEY_TO_UNSET_CANONICAL = new Map<string, string>(
  CREATE_UNSET_FIELD_DEFINITIONS.map((definition) => [
    definition.optionKey,
    definition.canonical,
  ]),
);

const CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS =
  CREATE_UNSET_FIELD_DEFINITIONS.map((definition) => definition.canonical)
    .sort((left, right) => left.localeCompare(right))
    .join(", ");

function buildInvalidLogSeedKeysMessage(
  optionName: "--comment" | "--note" | "--learning",
  unsupportedKeys: string[],
): string {
  const sortedUnsupported = [...unsupportedKeys].sort((left, right) =>
    left.localeCompare(right),
  );
  const keyLabel = sortedUnsupported.length === 1 ? "key" : "keys";
  return (
    `${optionName} supports only author, created_at, and text seed fields. ` +
    `Found unsupported ${keyLabel}: ${sortedUnsupported.join(", ")}. ` +
    `If text contains comma-separated key:value-like fragments, wrap text in quotes ` +
    '(for example text="first,scope:project"), use markdown-style key/value input, ' +
    `or pass ${optionName} - with piped stdin.`
  );
}

function parseStatusValue(
  value: string,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus {
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map(
      (definition) => definition.id,
    );
    throw new PmCliError(
      `Invalid status value "${value}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

/** Resolve the create-time status when `--status` is omitted: a config-driven per-type `default_status` (from `pm schema add-type --default-status`) wins, then the workflow open status. An unknown configured value degrades to the open status rather than blocking the create (never-block-the-agent). */
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
    throw new PmCliError(
      `Invalid created_at timestamp "${value}"`,
      EXIT_CODE.USAGE,
    );
  }
  return new Date(parsed).toISOString();
}

const CREATE_LEGACY_NONE_COLLECTION_NORMALIZERS =
  createLegacyNoneCollectionNormalizers<CreateCommandOptions>();

function normalizeLegacyNoneCreateOptions(
  options: CreateCommandOptions,
): CreateCommandOptions {
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

  const scalarOptionKeys = new Set<string>([
    ...CREATE_OPTION_KEY_TO_UNSET_CANONICAL.keys(),
    "rank",
  ]);
  for (const optionKey of scalarOptionKeys) {
    const candidate = normalized[optionKey];
    if (typeof candidate !== "string" || !isLegacyNoneToken(candidate)) {
      continue;
    }
    /* c8 ignore start -- rank alias canonicalization is exercised in legacy-option compatibility tests. */
    const canonicalUnset =
      optionKey === "rank"
        ? "order"
        : (CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey);
    appendUnsetTarget(canonicalUnset);
    normalized[optionKey] = undefined;
    /* c8 ignore stop */
  }

  return applyLegacyNoneCollectionNormalizers(
    normalized,
    CREATE_LEGACY_NONE_COLLECTION_NORMALIZERS,
  );
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value;
}

function parseCreateUnsetTargets(
  raw: string[] | undefined,
  runtimeFieldRegistry?: RuntimeFieldRegistry,
): { metadataKeys: Set<string>; optionKeys: Set<string> } {
  return parseCommandUnsetTargets({
    raw,
    supportedFields: CREATE_UNSET_SUPPORTED_CANONICAL_FIELDS,
    resolveDefinition: (trimmed) =>
      CREATE_UNSET_ALIAS_MAP.get(trimmed) ??
      resolveRuntimeUnsetFieldDefinition(
        trimmed,
        "create",
        runtimeFieldRegistry,
      ),
  });
}

/** Allowed CSV/markdown keys for the create `--dep` seed (GH-258). */
const DEP_SEED_KEYS = [
  "id",
  "kind",
  "type",
  "author",
  "created_at",
  "source_kind",
] as const;
/** Allowed CSV/markdown keys for create `--file`/`--doc` seeds (GH-258). */
const LINKED_ARTIFACT_SEED_KEYS = ["path", "scope", "note"] as const;

function parseDependencies(
  raw: string[] | undefined,
  nowValue: string,
  prefix: string,
): { values: Dependency[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--dep",
    "Use --clear-deps to clear dependencies.",
  );
  const values: Dependency[] = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const isStructured = looksLikeStructuredEntry(trimmedEntry, DEP_SEED_KEYS);
    assertValidBareDependencyFlagValue(trimmedEntry, isStructured);
    const kv = isStructured
      ? parseCsvKv(entry, "--dep")
      : { id: trimmedEntry, kind: "related" };
    if (isStructured) {
      assertNoUnknownCsvKeys(kv, "--dep", DEP_SEED_KEYS);
    }
    const id = parseOptionalString(kv.id);
    const kind = normalizeDependencyKindInput(
      parseOptionalString(kv.kind ?? kv.type),
    );
    if (!id || !kind) {
      throw new PmCliError(
        "--dep requires id and kind, or a bare item id to create a related dependency",
        EXIT_CODE.USAGE,
      );
    }
    if (id.trim().toLowerCase() === "undefined") {
      throw new PmCliError(
        `--dep id must not use placeholder token "${id}". Use --clear-deps to clear dependencies.`,
        EXIT_CODE.USAGE,
      );
    }
    const sourceKind = normalizeDependencySourceKind(
      parseOptionalString(kv.source_kind),
    );
    return {
      id: normalizeDependencySeedId(id, prefix, sourceKind),
      kind: ensureEnumValue(kind, DEPENDENCY_KIND_VALUES, "dependency kind"),
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author),
      source_kind: sourceKind,
    };
  });
  return { values, explicitEmpty: false };
}

const DEPENDENCY_KIND_INPUT_ALIASES: Readonly<Record<string, string>> = {
  "blocked-by": "blocked_by",
  depends_on: "blocked_by",
  "depends-on": "blocked_by",
};

function normalizeDependencyKindInput(
  raw: string | undefined,
): string | undefined {
  if (typeof raw !== "string") {
    return raw;
  }
  const alias = DEPENDENCY_KIND_INPUT_ALIASES[raw.toLowerCase()];
  return alias ?? raw;
}

function looksLikeStructuredEntry(
  raw: string,
  keys: readonly string[],
): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  const keyPattern = keys
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (new RegExp(`^(?:[-*+]\\s+)?(?:${keyPattern})\\s*[:=]`, "i").test(raw)) {
    return true;
  }
  // A first-key typo (e.g. `bogus=v,id=pm-2`) must still be parsed so the unknown
  // key is rejected rather than swallowed as a bare id/path value (GH-258).
  return looksLikeGenericKeyValueEntry(raw);
}

/** Implements parse log seed for the public runtime surface of this module. */
export function parseLogSeed(
  optionName: "--comment" | "--note" | "--learning",
  raw: string[] | undefined,
  nowValue: string,
  fallbackAuthor: string,
): { values: LogNote[] | Comment[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
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
        throw new PmCliError(
          `${optionName} requires text=<value>`,
          EXIT_CODE.USAGE,
        );
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
      if (
        optionName === "--comment" ||
        optionName === "--note" ||
        optionName === "--learning"
      ) {
        return buildPlainTextCommentSeed();
      }
      throw error;
      /* c8 ignore stop */
    }
    const unsupportedKeys = Object.keys(kv).filter(
      (key) => !LOG_SEED_ALLOWED_KEYS.has(key),
    );
    if (unsupportedKeys.length > 0) {
      return {
        created_at: parseCreatedAt(kv.created_at, nowValue),
        author: parseOptionalString(kv.author) ?? fallbackAuthor,
        text: trimmedEntry,
      };
    }
    const text = kv.text ?? "";
    if (text === "") {
      throw new PmCliError(
        `${optionName} requires text=<value>`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      created_at: parseCreatedAt(kv.created_at, nowValue),
      author: parseOptionalString(kv.author) ?? fallbackAuthor,
      text,
    };
  });
  return { values, explicitEmpty: false };
}

/** Implements parse files for the public runtime surface of this module. */
export function parseFiles(raw: string[] | undefined): {
  values: LinkedFile[] | undefined;
  explicitEmpty: boolean;
} {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--file",
    "Use --clear-files to clear linked files.",
  );
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const isStructured = looksLikeStructuredEntry(
      trimmedEntry,
      LINKED_ARTIFACT_SEED_KEYS,
    );
    const kv = isStructured
      ? parseCsvKv(entry, "--file")
      : { path: trimmedEntry };
    if (isStructured) {
      assertNoUnknownCsvKeys(kv, "--file", LINKED_ARTIFACT_SEED_KEYS);
    }
    if (!kv.path) {
      throw new PmCliError(
        "--file requires path=<value> or a bare file path",
        EXIT_CODE.USAGE,
      );
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "file scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

/** Implements parse tests for the public runtime surface of this module. */
export function parseTests(raw: string[] | undefined): {
  values: LinkedTest[] | undefined;
  explicitEmpty: boolean;
} {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--test",
    "Use --clear-tests to clear linked tests.",
  );
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredLinkedTestEntry(trimmedEntry)
      ? normalizeStructuredLinkedTestEntry(
          parseCsvKv(entry, "--test"),
          "--test",
        )
      : { command: trimmedEntry };
    const command = parseOptionalString(kv.command);
    const filePath = parseOptionalString(kv.path);
    if (!command) {
      throw new PmCliError(
        "--test requires command=<value> or a bare command (path=<value> is optional metadata)",
        EXIT_CODE.USAGE,
      );
    }
    const timeoutSecondsRaw = parseOptionalString(kv.timeout_seconds);
    const timeoutAliasRaw = parseOptionalString(kv.timeout);
    if (
      timeoutSecondsRaw &&
      timeoutAliasRaw &&
      timeoutSecondsRaw !== timeoutAliasRaw
    ) {
      throw new PmCliError(
        "--test timeout and timeout_seconds must match when both are provided",
        EXIT_CODE.USAGE,
      );
    }
    const timeoutRaw = timeoutSecondsRaw ?? timeoutAliasRaw;
    return {
      command,
      path: filePath,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "test scope"),
      timeout_seconds: timeoutRaw
        ? parseOptionalNumber(timeoutRaw, "timeout_seconds")
        : undefined,
      pm_context_mode: parseLinkedTestContextMode(kv.pm_context_mode, "--test"),
      env_set: parseLinkedTestEnvSet(kv.env_set, "--test"),
      env_clear: parseLinkedTestEnvClear(kv.env_clear, "--test"),
      shared_host_safe: parseLinkedTestBoolean(
        kv.shared_host_safe,
        "--test",
        "shared_host_safe",
      ),
      assert_stdout_contains: parseLinkedTestStringList(
        kv.assert_stdout_contains,
      ),
      assert_stdout_regex: parseLinkedTestRegexList(
        kv.assert_stdout_regex,
        "--test",
        "assert_stdout_regex",
      ),
      assert_stderr_contains: parseLinkedTestStringList(
        kv.assert_stderr_contains,
      ),
      assert_stderr_regex: parseLinkedTestRegexList(
        kv.assert_stderr_regex,
        "--test",
        "assert_stderr_regex",
      ),
      assert_stdout_min_lines: parseLinkedTestMinLines(
        kv.assert_stdout_min_lines,
        "--test",
      ),
      assert_json_field_equals: parseLinkedTestAssertionEqualsMap(
        kv.assert_json_field_equals,
        "--test",
      ),
      assert_json_field_gte: parseLinkedTestAssertionGteMap(
        kv.assert_json_field_gte,
        "--test",
      ),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

/** Implements parse docs for the public runtime surface of this module. */
export function parseDocs(raw: string[] | undefined): {
  values: LinkedDoc[] | undefined;
  explicitEmpty: boolean;
} {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--doc",
    "Use --clear-docs to clear linked docs.",
  );
  const values = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const isStructured = looksLikeStructuredEntry(
      trimmedEntry,
      LINKED_ARTIFACT_SEED_KEYS,
    );
    const kv = isStructured
      ? parseCsvKv(entry, "--doc")
      : { path: trimmedEntry };
    if (isStructured) {
      assertNoUnknownCsvKeys(kv, "--doc", LINKED_ARTIFACT_SEED_KEYS);
    }
    if (!kv.path) {
      throw new PmCliError(
        "--doc requires path=<value> or a bare doc path",
        EXIT_CODE.USAGE,
      );
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "doc scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseReminders(
  raw: string[] | undefined,
  nowValue: string,
): { values: Reminder[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--reminder",
    "Use --clear-reminders to clear reminders.",
  );
  return {
    values: parseReminderEntries(raw, new Date(nowValue), { valueMode: "raw" }),
    explicitEmpty: false,
  };
}

function parseEvents(
  raw: string[] | undefined,
  nowValue: string,
): { values: CalendarEvent[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0)
    return { values: undefined, explicitEmpty: false };
  assertNoLegacyNoneTokens(
    raw,
    "--event",
    "Use --clear-events to clear linked events.",
  );
  return {
    values: parseEventEntries(raw, new Date(nowValue), {
      allDayEmptyGuard: "defined",
      recurrenceEmptyNumericGuard: "defined",
    }),
    explicitEmpty: false,
  };
}

function buildChangedFields(
  itemMetadata: ItemMetadata,
  body: string,
  explicitUnsets: string[],
  additionalItemMetadataKeys: readonly string[] = [],
): string[] {
  const changed = [
    ...ITEM_METADATA_KEY_ORDER.filter((key) => itemMetadata[key] !== undefined),
    ...additionalItemMetadataKeys.filter(
      (key) =>
        (itemMetadata as unknown as Record<string, unknown>)[key] !== undefined,
    ),
    ...(body.length > 0 ? ["body"] : []),
    ...explicitUnsets.map((key) => `unset:${key}`),
  ];
  return Array.from(new Set(changed));
}

function buildHistoryMessage(
  baseMessage: string | undefined,
  explicitUnsets: string[],
): string | undefined {
  const trimmed = baseMessage ?? "";
  if (explicitUnsets.length === 0) {
    return trimmed;
  }
  const suffix = `explicit_unset=${explicitUnsets.join(",")}`;
  return trimmed ? `${trimmed} | ${suffix}` : suffix;
}

function normalizeCreatePolicyOptionKey(
  raw: string,
  typeName: string,
  sourceLabel: string,
): string {
  const canonical = canonicalizeCommandOptionKey("create", raw);
  if (!canonical) {
    throw new PmCliError(
      `Unsupported ${sourceLabel} entry "${raw}" for type "${typeName}"`,
      EXIT_CODE.CONFLICT,
    );
  }
  return canonical;
}

interface CreateOptionValueLookup {
  scalarValues: Record<string, unknown>;
  repeatableValues: Record<string, unknown>;
  addTags: string[] | undefined;
}

function buildCreateOptionValueLookup(
  options: CreateCommandOptions,
): CreateOptionValueLookup {
  return {
    scalarValues: {
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
    },
    repeatableValues: {
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
    },
    addTags: options.addTags,
  };
}

function hasCreateOptionValue(
  lookup: CreateOptionValueLookup,
  optionKey: string,
): boolean {
  // `--add-tags` mutates the same `tags` field as `--tags`, so it must count
  // toward the `tags` command_option_policy (both the disabled guard and the
  // required check) — otherwise `--add-tags` would bypass a rule disabling
  // tags, or fail to satisfy a rule requiring them even though the created
  // item ends up tagged.
  if (optionKey === "tags") {
    return (
      lookup.scalarValues.tags !== undefined ||
      (Array.isArray(lookup.addTags) && lookup.addTags.length > 0)
    );
  }
  if (Object.prototype.hasOwnProperty.call(lookup.scalarValues, optionKey)) {
    return lookup.scalarValues[optionKey] !== undefined;
  }
  /* c8 ignore start -- policy probes only pass canonical CREATE_COMMAND_OPTION_KEYS, all of which exist in scalarValues/repeatableValues, so the in-repeatableValues false arm and trailing return are unreachable. */
  if (
    Object.prototype.hasOwnProperty.call(lookup.repeatableValues, optionKey)
  ) {
    const value = lookup.repeatableValues[optionKey];
    return Array.isArray(value) && value.length > 0;
  }
  return false;
  /* c8 ignore stop */
}

function buildRequiredCreateOptions(
  typeDefinition: ResolvedItemTypeDefinition,
  createMode: CreateMode,
): Set<string> {
  const requiredOptions = new Set<string>(["title", "type"]);
  if (createMode !== "strict") {
    return requiredOptions;
  }
  for (const field of typeDefinition.required_create_fields) {
    requiredOptions.add(
      normalizeCreatePolicyOptionKey(
        field,
        typeDefinition.name,
        "required_create_fields",
      ),
    );
  }
  for (const field of typeDefinition.required_create_repeatables) {
    requiredOptions.add(
      normalizeCreatePolicyOptionKey(
        field,
        typeDefinition.name,
        "required_create_repeatables",
      ),
    );
  }
  return requiredOptions;
}

function assertNoDisabledCreateOptions(
  disabledOptions: readonly string[],
  lookup: CreateOptionValueLookup,
  clearOptionKeys: Set<string>,
  typeName: string,
): void {
  for (const option of disabledOptions) {
    if (!hasCreateOptionValue(lookup, option) && !clearOptionKeys.has(option)) {
      continue;
    }
    throw new PmCliError(
      `Option ${commandOptionFlagLabel("create", option)} is disabled for type "${typeName}" by command_option_policies`,
      EXIT_CODE.USAGE,
    );
  }
}

function assertNoStrictRequiredOptionClears(
  requiredOptions: readonly string[],
  createMode: CreateMode,
  clearOptionKeys: Set<string>,
): void {
  if (createMode !== "strict") {
    return;
  }
  const strictRequiredClears = requiredOptions.filter((required) =>
    clearOptionKeys.has(required),
  );
  if (strictRequiredClears.length === 0) {
    return;
  }
  /* c8 ignore next -- deterministic ordering fallback only matters when required clear list contains locale ties. */
  const requiredFlags = [
    ...new Set(
      strictRequiredClears.map((required) =>
        commandOptionFlagLabel("create", required),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  /* c8 ignore next -- strict clear conflict envelope is covered by policy integration scenarios. */
  throw new PmCliError(
    `Strict create mode requires concrete values for ${requiredFlags.join(", ")}; --unset/--clear-* directives cannot satisfy required options`,
    EXIT_CODE.USAGE,
  );
}

function parseTypeOptions(raw: string[] | undefined): {
  values: Record<string, string> | undefined;
  explicitEmpty: boolean;
} {
  if (!raw || raw.length === 0) {
    return { values: undefined, explicitEmpty: false };
  }
  assertNoLegacyNoneTokens(
    raw,
    "--type-option",
    "Use --clear-type-options to clear existing type options.",
  );
  return {
    values: parseTypeOptionEntries(raw),
    explicitEmpty: false,
  };
}

async function resolveCreateStdinInputs(
  options: CreateCommandOptions,
): Promise<CreateCommandOptions> {
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
    typeOption: await stdinResolver.resolveList(
      options.typeOption,
      "--type-option",
    ),
    field: await stdinResolver.resolveList(options.field, "--field"),
  };
}

function resolveCreateMode(
  createMode: string | undefined,
  defaultMode: CreateMode,
): CreateMode {
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

function resolveScheduleCreatePreset(
  raw: string | undefined,
): ScheduleCreatePreset | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new PmCliError(
      "--schedule-preset must not be empty",
      EXIT_CODE.USAGE,
    );
  }
  if (
    normalized === "lightweight" ||
    normalized === "lite" ||
    normalized === "schedule-lite"
  ) {
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
  const createModeWasExplicit =
    typeof createMode === "string" && createMode.trim().length > 0;
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
  const optionLookup = buildCreateOptionValueLookup(options);
  const baseRequiredOptions = buildRequiredCreateOptions(
    typeDefinition,
    createMode,
  );

  const policyState = resolveCommandOptionPolicyState(
    typeDefinition,
    "create",
    baseRequiredOptions,
  );
  if (policyState.errors.length > 0) {
    throw new PmCliError(policyState.errors.join("; "), EXIT_CODE.CONFLICT);
  }

  assertNoDisabledCreateOptions(
    policyState.disabled,
    optionLookup,
    clearOptionKeys,
    typeName,
  );
  assertNoStrictRequiredOptionClears(
    policyState.required,
    createMode,
    clearOptionKeys,
  );

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
    return hasCreateOptionValue(optionLookup, optionKey);
  };
  const missingRequiredOptions = policyState.required.filter(
    (required) => !satisfiesRequiredOption(required),
  );
  return [
    ...new Set(
      missingRequiredOptions.map((required) =>
        commandOptionFlagLabel("create", required),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

const MISSING_REQUIRED_TYPE_OPTION_PATTERN =
  /^Missing required type option "([^"]+)" for type "([^"]+)"$/;

function collectMissingRequiredTypeOptionKeys(
  errors: string[],
  typeName: string,
): string[] {
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
  return [...new Set(missingKeys)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function filterNonMissingTypeOptionErrors(
  errors: string[],
  typeName: string,
): string[] {
  return errors.filter((error) => {
    const match = error.match(MISSING_REQUIRED_TYPE_OPTION_PATTERN);
    return !match || match[2] !== typeName;
  });
}

function assertNoInvalidTypeOptions(
  errors: string[],
  type: string,
  typeDefinition: ResolvedItemTypeDefinition,
  statusRegistry: RuntimeStatusRegistry,
): void {
  const nonMissingTypeOptionErrors = filterNonMissingTypeOptionErrors(
    errors,
    type,
  );
  if (nonMissingTypeOptionErrors.length === 0) {
    return;
  }
  const nextValidExample = buildTypeSpecificCreateExample(
    typeDefinition,
    [],
    [],
    statusRegistry.open_status,
  );
  throw new PmCliError(nonMissingTypeOptionErrors.join("; "), EXIT_CODE.USAGE, {
    code: "invalid_argument_value",
    required: `Provide valid --type-option key/value pairs for type "${type}".`,
    examples: [nextValidExample],
    nextSteps: [
      `Run "pm create --help --type ${type}" to review allowed type-option keys and values.`,
    ],
  });
}

function typeOptionExampleValue(
  typeDefinition: ResolvedItemTypeDefinition,
  key: string,
): string {
  const optionDefinition = typeDefinition.options.find(
    (option) => option.key === key,
  );
  const firstAllowed = optionDefinition?.values[0];
  if (typeof firstAllowed === "string" && firstAllowed.trim().length > 0) {
    return firstAllowed;
  }
  return "<value>";
}

function createExampleTokensForFlag(
  flag: string,
  typeName: string,
  openStatus: string,
): string[] {
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
      return [
        "--dep",
        '"id=pm-xxxx,kind=related,author=maintainer,created_at=now"',
      ];
    case "--comment":
      return [
        "--comment",
        '"author=maintainer,created_at=now,text=Implementation context"',
      ];
    case "--note":
      return ["--note", '"author=maintainer,created_at=now,text=Design note"'];
    case "--learning":
      return [
        "--learning",
        '"author=maintainer,created_at=now,text=Durable lesson"',
      ];
    case "--file":
      return ["--file", '"path=src/example.ts,note=implementation file"'];
    case "--test":
      return [
        "--test",
        '"command=node scripts/run-tests.mjs test,timeout_seconds=240"',
      ];
    case "--doc":
      return ["--doc", '"path=README.md,note=reference doc"'];
    default:
      return [flag, '"<value>"'];
  }
}

function buildTypeSpecificCreateExample(
  typeDefinition: ResolvedItemTypeDefinition,
  missingCreateFlags: string[],
  missingTypeOptionKeys: string[],
  openStatus: string,
): string {
  const tokens = [
    "pm",
    "create",
    "--title",
    `"${typeDefinition.name} example title"`,
    "--description",
    `"${typeDefinition.name} example description"`,
    "--type",
    typeDefinition.name,
  ];
  const optionalRecommendationFlags = ["--status", "--priority", "--message"];
  const orderedFlags = [
    ...new Set([...optionalRecommendationFlags, ...missingCreateFlags]),
  ];
  const includedFlags = new Set<string>(["--title", "--description", "--type"]);
  for (const flag of orderedFlags) {
    if (includedFlags.has(flag)) {
      continue;
    }
    tokens.push(
      ...createExampleTokensForFlag(flag, typeDefinition.name, openStatus),
    );
    includedFlags.add(flag);
  }
  for (const key of missingTypeOptionKeys) {
    const value = typeOptionExampleValue(typeDefinition, key);
    tokens.push("--type-option", `${key}=${value}`);
  }
  return tokens.join(" ");
}

/** Require a trimmed option value while preserving title-specific recovery guidance. */
export function requireStringOption(
  value: string | undefined,
  flag: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    if (flag === "--title") {
      if (value !== undefined) {
        throw new PmCliError(
          "Title cannot be empty or whitespace-only. Retry: pass a non-empty title with --title.",
          EXIT_CODE.USAGE,
        );
      }
      throw new PmCliError(
        'Missing required option --title. Why required: every item needs a human-readable title for lookup, search, and reporting. Retry: pass the title as the first positional argument (example: pm create "Fix login bug" --type Issue) or with --title.',
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(`Missing required option ${flag}`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function selectAuthor(
  explicitAuthor: string | undefined,
  settingsAuthor: string,
): string {
  const candidate =
    parseOptionalString(explicitAuthor) ??
    process.env.PM_AUTHOR ??
    settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed || "unknown";
}

function ensurePriority(rawPriority: string | number): 0 | 1 | 2 | 3 | 4 {
  return resolvePriority(rawPriority);
}

function mergeCreateOptionsWithTemplate(
  templateOptions: Record<string, unknown>,
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
    return (
      entry.action === "templates-show" ||
      normalizeExtensionCommandPath(entry.command) === "templates show"
    );
  });
}

function readTemplateOptionsFromRuntimeResult(
  result: unknown,
  templateName: string,
): Record<string, string | string[] | number | boolean> {
  if (typeof result !== "object" || result === null || !("options" in result)) {
    throw new PmCliError(
      `Templates package returned invalid payload for template "${templateName}". Expected an options object.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const options = (result as { options?: unknown }).options;
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new PmCliError(
      `Templates package returned invalid options for template "${templateName}".`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const normalized: Record<string, string | string[] | number | boolean> = {};
  for (const [key, value] of Object.entries(
    options as Record<string, unknown>,
  )) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
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
): Promise<Record<string, string | string[] | number | boolean>> {
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
    const warningSuffix =
      handlerResult.warnings.length > 0
        ? ` (${handlerResult.warnings.join(", ")})`
        : "";
    throw new PmCliError(
      `Unable to resolve template "${templateName}" via templates package. Run "pm templates show ${templateName}" for details.${warningSuffix}`,
      EXIT_CODE.USAGE,
    );
  }
  /* c8 ignore next -- template runtime success path is covered by package-level integration tests. */
  return readTemplateOptionsFromRuntimeResult(
    handlerResult.result,
    templateName,
  );
}

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    /* c8 ignore next -- init guard failures are covered by top-level create command tests. */
    if (!exists) {
      throw new PmCliError(
        `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
        EXIT_CODE.NOT_FOUND,
      );
    }
  });
}

/**
 * Resolve an optional string item-metadata field for {@link runCreate}: yields
 * `undefined` when the field is being cleared via `--unset <key>` or was never
 * supplied, otherwise the (identity-parsed) raw value. Collapses the pervasive
 * `unset ? undefined : raw === undefined ? undefined : parseOptionalString(raw)`
 * triple-ternary each optional scalar field repeated inline, keeping `runCreate`
 * under the complexity ceiling without changing any resolved value.
 */
function resolveUnsettableOptionalString(
  unsetKeys: ReadonlySet<string>,
  metadataKey: string,
  raw: string | undefined,
): string | undefined {
  return unsetKeys.has(metadataKey) || raw === undefined
    ? undefined
    : parseOptionalString(raw);
}

/** Resolve an optional field that maps its raw string through `transform` once present: yields `undefined` when the field is being cleared via `--unset` or was never supplied, otherwise `transform(raw)`. The non-string return type is inferred from `transform`, so this serves numeric, ISO-date, and enum fields alike while keeping the unset/absent guard in one place. */
function resolveUnsettableTransformed<Value>(
  unsetKeys: ReadonlySet<string>,
  metadataKey: string,
  raw: string | undefined,
  transform: (value: string) => Value,
): Value | undefined {
  return unsetKeys.has(metadataKey) || raw === undefined
    ? undefined
    : transform(raw);
}

/** Calendar-relevant item types whose entries are invisible on `pm calendar` without a schedule. */
const CALENDAR_RELEVANT_CREATE_TYPES = new Set([
  "milestone",
  "meeting",
  "reminder",
  "event",
]);

/** Whether a calendar-relevant item would be invisible on `pm calendar`: a Milestone/Meeting/Reminder/Event created with no deadline AND no reminders AND no events never surfaces there. Shared by the structured create warning and the post-write stderr hint so both stay in lockstep. */
function createItemLacksSchedule(
  type: string,
  deadline: string | undefined,
  reminders: readonly unknown[] | undefined,
  events: readonly unknown[] | undefined,
): boolean {
  const hasDeadline = deadline !== undefined;
  const hasReminders = reminders !== undefined && reminders.length > 0;
  const hasEvents = events !== undefined && events.length > 0;
  return (
    CALENDAR_RELEVANT_CREATE_TYPES.has(type.toLowerCase()) &&
    !hasDeadline &&
    !hasReminders &&
    !hasEvents
  );
}

/** Build the never-blocking schedule-visibility warnings for a new item: an `event_without_schedule` token for Event-type items with no attached events, and a `calendar_item_without_schedule` token (with an actionable hint) for any calendar-relevant type that would be invisible on `pm calendar`. The structured prefixes are stable for automation/telemetry (pm-2cgu / GH-174). */
function collectCreateScheduleWarnings(
  type: string,
  id: string,
  deadline: string | undefined,
  reminders: readonly unknown[] | undefined,
  events: readonly unknown[] | undefined,
): string[] {
  const warnings: string[] = [];
  if (
    type.toLowerCase() === "event" &&
    (events === undefined || events.length === 0)
  ) {
    warnings.push(`event_without_schedule:${id}:no_time_set`);
  }
  if (createItemLacksSchedule(type, deadline, reminders, events)) {
    warnings.push(
      `calendar_item_without_schedule:${id}:no_deadline_or_reminder_or_event (hint: set --deadline <ISO> or --reminder "<when>", or link an Event via --event "start=<ISO>,end=<ISO>"; otherwise this item never appears on pm calendar)`,
    );
  }
  return warnings;
}

/** Resolve the effective parent for a new item, inheriting the session-focused item (set via `pm focus <id>`) only when no explicit `--parent` was supplied and parent is not being unset (GH-161 / pm-72xf). An explicit `--parent` (including `--parent ""`) always overrides focus; the inherited value flows through the same locate/validate path as an explicit parent. */
async function inheritFocusedParent(
  parent: string | undefined,
  resolvedOptions: CreateCommandOptions,
  unsetKeys: ReadonlySet<string>,
  pmRoot: string,
): Promise<{ parent: string | undefined; parentSource: "focus" | undefined }> {
  if (
    parent !== undefined ||
    unsetKeys.has("parent") ||
    resolvedOptions.parent !== undefined
  ) {
    return { parent, parentSource: undefined };
  }
  const focused = await getFocusedItem(pmRoot);
  if (focused === undefined) {
    return { parent, parentSource: undefined };
  }
  return { parent: focused, parentSource: "focus" };
}

/** Normalize and locate a new item's parent reference, returning the normalized value plus any never-blocking missing-parent warnings the configured `parent_reference` policy produces when the target does not resolve. */
async function validateCreateParentReference(
  pmRoot: string,
  settings: PmSettings,
  typeRegistry: ItemTypeRegistry,
  itemId: string,
  parent: string,
  policy: Parameters<typeof validateMissingParentReference>[1],
): Promise<{ parent: string; warnings: string[] }> {
  const normalized = normalizeParentReferenceValue(parent);
  assertParentReferenceIsNotSelf(itemId, normalized, settings.id_prefix);
  const parentLocated = await locateItem(
    pmRoot,
    normalized,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  if (parentLocated) {
    return { parent: normalized, warnings: [] };
  }
  const normalizedParentId = normalizeItemId(normalized, settings.id_prefix);
  return {
    parent: normalized,
    warnings: validateMissingParentReference(normalizedParentId, policy)
      .warnings,
  };
}

async function resolveCreateParentWithWarnings(params: {
  itemId: string;
  parent: string | undefined;
  pmRoot: string;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  policy: Parameters<typeof validateMissingParentReference>[1];
}): Promise<{ parent: string | undefined; warnings: string[] }> {
  if (params.parent === undefined) {
    return { parent: undefined, warnings: [] };
  }
  const parentValidation = await validateCreateParentReference(
    params.pmRoot,
    params.settings,
    params.typeRegistry,
    params.itemId,
    params.parent,
    params.policy,
  );
  return parentValidation;
}

async function resolveCreateItemId(params: {
  pmRoot: string;
  settings: PmSettings;
  explicitId: unknown;
}): Promise<string> {
  if (params.explicitId === undefined) {
    return generateItemId(params.pmRoot, params.settings.id_prefix, {
      tokenLength: params.settings.ids.token_length,
    });
  }
  if (typeof params.explicitId !== "string") {
    throw new PmCliError("--id must be a string", EXIT_CODE.USAGE);
  }
  const trimmedId = params.explicitId.trim();
  if (trimmedId.length === 0 || isPlaceholderReferenceToken(trimmedId)) {
    throw new PmCliError(
      "--id must not be empty or use a placeholder token",
      EXIT_CODE.USAGE,
    );
  }
  const normalizedId = normalizeItemId(trimmedId, params.settings.id_prefix);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalizedId)) {
    throw new PmCliError(
      "--id must contain only letters, numbers, and dashes after normalization",
      EXIT_CODE.USAGE,
    );
  }
  return normalizedId;
}

/** Resolve a sprint or release field: `undefined` when cleared/absent, otherwise the format-validated value plus any never-blocking format warnings from the configured `sprint_release_format` policy. */
function resolveCreateSprintOrRelease(
  unsetKeys: ReadonlySet<string>,
  metadataKey: string,
  raw: string | undefined,
  field: Parameters<typeof validateSprintOrReleaseValue>[0],
  policy: Parameters<typeof validateSprintOrReleaseValue>[2],
): { value: string | undefined; warnings: string[] } {
  const resolved = resolveUnsettableOptionalString(unsetKeys, metadataKey, raw);
  if (resolved === undefined) {
    return { value: undefined, warnings: [] };
  }
  const validation = validateSprintOrReleaseValue(field, resolved, policy);
  return { value: validation.value, warnings: validation.warnings };
}

/** Apply the `--blocked-by` convenience: when the target locates, add a `blocked_by` dependency (if not already present) and, unless `--status` was given explicitly, move the new item into the blocked status. Returns the (possibly augmented) dependency list and the (possibly rerouted) status; a `blockedBy` that is absent or does not locate leaves both unchanged. */
async function resolveCreateBlockedByDependency(params: {
  pmRoot: string;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  statusRegistry: RuntimeStatusRegistry;
  blockedBy: string | undefined;
  dependencyValues: Dependency[] | undefined;
  status: ItemStatus;
  statusExplicit: boolean;
  nowValue: string;
  author: string;
}): Promise<{
  dependencyValues: Dependency[] | undefined;
  status: ItemStatus;
}> {
  const {
    pmRoot,
    settings,
    typeRegistry,
    statusRegistry,
    blockedBy,
    status,
    statusExplicit,
    nowValue,
    author,
  } = params;
  let dependencyValues = params.dependencyValues;
  if (blockedBy === undefined) {
    return { dependencyValues, status };
  }
  const normalizedBlockedBy = normalizeItemId(blockedBy, settings.id_prefix);
  const blockedByLocated = await locateItem(
    pmRoot,
    normalizedBlockedBy,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  if (!blockedByLocated) {
    return { dependencyValues, status };
  }
  const hasBlockedByDependency = (dependencyValues ?? []).some(
    (dependency) =>
      dependency.id === blockedByLocated.id && dependency.kind === "blocked_by",
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
  if (statusExplicit) {
    return { dependencyValues, status };
  }
  const blockedStatus = statusRegistry.blocked_statuses.has("blocked")
    ? "blocked"
    : ([...statusRegistry.blocked_statuses].sort((left, right) =>
        left.localeCompare(right),
      )[0] ?? statusRegistry.open_status);
  return { dependencyValues, status: blockedStatus };
}

/** Apply the governance default-type fallback when `pm create` was invoked with no `--type`: honor `governance.create_default_type` when it resolves in the active registry, else fall back to the built-in `Task`. Suppressed under explicit `--create-mode strict`, where the strict required-option contract must surface the missing_required_option envelope instead. Mutates `resolvedOptions.type`. */
function applyCreateDefaultType(
  resolvedOptions: CreateCommandOptions,
  settings: PmSettings,
  typeRegistry: ItemTypeRegistry,
): void {
  // Default-type fallback is suppressed under explicit --create-mode strict, where the strict
  // required-option contract takes precedence and surfaces the missing_required_option envelope.
  /* c8 ignore next -- explicit strict-mode template interactions are exercised in governance integration tests. */
  const explicitStrictMode =
    typeof resolvedOptions.createMode === "string" &&
    resolvedOptions.createMode.trim().toLowerCase() === "strict";
  if (explicitStrictMode) {
    return;
  }
  /* c8 ignore next -- governance default-type fallback is validated in governance integration tests. */
  const defaultType = settings.governance.create_default_type?.trim();
  if (
    defaultType &&
    defaultType.length > 0 &&
    resolveTypeName(defaultType, typeRegistry)
  ) {
    resolvedOptions.type = defaultType;
    return;
  }
  /* c8 ignore start -- "Task" is a built-in type present in every default registry; reaching this arm requires a custom schema that removed Task with no create_default_type configured. */
  if (resolveTypeName("Task", typeRegistry)) {
    resolvedOptions.type = "Task";
  }
  /* c8 ignore stop */
}

/** Select template-provided custom type options that can enter the scalar `--type-option` pipeline, protecting core create fields and rejecting non-scalar custom defaults instead of silently dropping them. */
function collectTemplateCustomTypeOptions(
  typeDefinition: ResolvedItemTypeDefinition,
  resolvedOptions: CreateCommandOptions,
): ResolvedItemTypeDefinition["options"] {
  return typeDefinition.options
    .filter(
      (option) =>
        canonicalizeCommandOptionKey("create", option.key) === undefined,
    )
    .flatMap((option) => {
      const value = resolvedOptions[option.key];
      if (value === undefined) {
        return [];
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return [option];
      }
      throw new PmCliError(
        `Template custom type option "${option.key}" must be a string, number, or boolean value`,
        EXIT_CODE.USAGE,
      );
    });
}

/** Resolve the target item type and creation mode for `pm create`: merge any `--template` options, apply the governance default-type fallback, map a near-miss `--type` to its canonical synonym (never blocking), and derive the schedule preset and effective create mode. Returns the (possibly template-merged) options alongside the resolved type definition, canonical type name, schedule preset, and create mode. */
async function resolveCreateTypeSelection(
  options: CreateCommandOptions,
  global: GlobalOptions,
  pmRoot: string,
  settings: PmSettings,
  typeRegistry: ItemTypeRegistry,
): Promise<{
  resolvedOptions: CreateCommandOptions;
  typeDefinition: ResolvedItemTypeDefinition;
  type: string;
  schedulePreset: ReturnType<typeof resolveScheduleCreatePreset>;
  createMode: ReturnType<typeof resolveEffectiveCreateMode>;
}> {
  let resolvedOptions = options;
  if (resolvedOptions.template !== undefined) {
    const templateName = resolvedOptions.template.trim();
    if (templateName.length === 0) {
      throw new PmCliError(
        "--template must not be empty. Omit --template to disable template usage.",
        EXIT_CODE.USAGE,
      );
    }
    /* c8 ignore next -- template merge path is exercised in templates package integration tests. */
    const templateOptions = await loadCreateTemplateOptionsFromRuntime(
      templateName,
      global,
      pmRoot,
    );
    resolvedOptions = normalizeLegacyNoneCreateOptions(
      mergeCreateOptionsWithTemplate(templateOptions, resolvedOptions),
    );
  }
  if (resolvedOptions.type === undefined) {
    applyCreateDefaultType(resolvedOptions, settings, typeRegistry);
  }
  /* c8 ignore start -- missing/invalid type fallback guards are exercised by create command integration suites. */
  if (resolvedOptions.type === undefined) {
    throw new PmCliError(
      "Missing required option --type <value>",
      EXIT_CODE.USAGE,
    );
  }
  let resolvedTypeName = resolveTypeName(resolvedOptions.type, typeRegistry);
  if (!resolvedTypeName) {
    // Never block on a near-miss type: map a known synonym (e.g. Bug -> Issue,
    // Change -> Chore) to its canonical built-in type when that type exists in the
    // active registry, and tell the agent how to make it a distinct custom type.
    const synonymCanonical = resolveTypeSynonym(resolvedOptions.type);
    const synonymResolved = synonymCanonical
      ? resolveTypeName(synonymCanonical, typeRegistry)
      : undefined;
    if (synonymResolved) {
      printError(
        `[pm] note: type '${resolvedOptions.type.trim()}' is not defined; using closest match '${synonymResolved}'. Run 'pm schema add-type "${resolvedOptions.type.trim()}"' to track it as a distinct type.`,
      );
      resolvedOptions.type = synonymResolved;
      resolvedTypeName = synonymResolved;
    } else {
      throw new PmCliError(
        buildInvalidTypeError(
          resolvedOptions.type,
          typeRegistry.types,
          resolveItemTypesFilePath(pmRoot, settings.schema),
        ),
        EXIT_CODE.USAGE,
      );
    }
  }
  /* c8 ignore stop */
  const typeDefinition = resolveTypeDefinition(resolvedTypeName, typeRegistry);
  /* c8 ignore start -- resolvedTypeName came from resolveTypeName succeeding, so resolveTypeDefinition always returns a definition here. */
  if (!typeDefinition) {
    throw new PmCliError(
      `Invalid type value "${resolvedOptions.type}"`,
      EXIT_CODE.USAGE,
    );
  }
  /* c8 ignore stop */
  const type = typeDefinition.name;
  const matchedTemplateTypeOptions = collectTemplateCustomTypeOptions(
    typeDefinition,
    resolvedOptions,
  );
  const templateTypeOptions = matchedTemplateTypeOptions.map(
    (option) => `${option.key}=${String(resolvedOptions[option.key])}`,
  );
  if (templateTypeOptions.length > 0) {
    resolvedOptions.typeOption = [
      ...templateTypeOptions,
      ...(resolvedOptions.typeOption ?? []),
    ];
    for (const option of matchedTemplateTypeOptions) {
      delete resolvedOptions[option.key];
    }
  }
  const schedulePreset = resolveScheduleCreatePreset(
    resolvedOptions.schedulePreset,
  );
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
  return { resolvedOptions, typeDefinition, type, schedulePreset, createMode };
}

/** Seed the explicit-unset and clear-option key sets from the parsed `--unset` targets, then fold in each enabled `--clear-<collection>` flag: it marks the collection's item-metadata key as explicitly unset and its option key as cleared, and rejects combining a clear flag with its own value flag. Returns the augmented sets used downstream for required-flag relaxation and history messaging. */
function collectCreateClearTargets(
  resolvedOptions: CreateCommandOptions,
  unsetTargets: { metadataKeys: Set<string>; optionKeys: Set<string> },
): { explicitUnsets: Set<string>; clearOptionKeys: Set<string> } {
  const explicitUnsets = new Set<string>(unsetTargets.metadataKeys);
  const clearOptionKeys = new Set<string>(unsetTargets.optionKeys);
  const clearCollectionDefinitions: ReadonlyArray<{
    enabled: boolean | undefined;
    optionKey: string;
    clearFlag: string;
    valueFlag: string;
    values: string[] | undefined;
    metadataKey: string;
  }> = [
    {
      enabled: resolvedOptions.clearDeps,
      optionKey: "dep",
      clearFlag: "--clear-deps",
      valueFlag: "--dep",
      values: resolvedOptions.dep,
      metadataKey: "dependencies",
    },
    {
      enabled: resolvedOptions.clearComments,
      optionKey: "comment",
      clearFlag: "--clear-comments",
      valueFlag: "--comment",
      values: resolvedOptions.comment,
      metadataKey: "comments",
    },
    {
      enabled: resolvedOptions.clearNotes,
      optionKey: "note",
      clearFlag: "--clear-notes",
      valueFlag: "--note",
      values: resolvedOptions.note,
      metadataKey: "notes",
    },
    {
      enabled: resolvedOptions.clearLearnings,
      optionKey: "learning",
      clearFlag: "--clear-learnings",
      valueFlag: "--learning",
      values: resolvedOptions.learning,
      metadataKey: "learnings",
    },
    {
      enabled: resolvedOptions.clearFiles,
      optionKey: "file",
      clearFlag: "--clear-files",
      valueFlag: "--file",
      values: resolvedOptions.file,
      metadataKey: "files",
    },
    {
      enabled: resolvedOptions.clearTests,
      optionKey: "test",
      clearFlag: "--clear-tests",
      valueFlag: "--test",
      values: resolvedOptions.test,
      metadataKey: "tests",
    },
    {
      enabled: resolvedOptions.clearDocs,
      optionKey: "doc",
      clearFlag: "--clear-docs",
      valueFlag: "--doc",
      values: resolvedOptions.doc,
      metadataKey: "docs",
    },
    {
      enabled: resolvedOptions.clearReminders,
      optionKey: "reminder",
      clearFlag: "--clear-reminders",
      valueFlag: "--reminder",
      values: resolvedOptions.reminder,
      metadataKey: "reminders",
    },
    {
      enabled: resolvedOptions.clearEvents,
      optionKey: "event",
      clearFlag: "--clear-events",
      valueFlag: "--event",
      values: resolvedOptions.event,
      metadataKey: "events",
    },
    {
      enabled: resolvedOptions.clearTypeOptions,
      optionKey: "typeOption",
      clearFlag: "--clear-type-options",
      valueFlag: "--type-option",
      values: resolvedOptions.typeOption,
      metadataKey: "type_options",
    },
  ];
  for (const definition of clearCollectionDefinitions) {
    if (!definition.enabled) {
      continue;
    }
    /* c8 ignore next -- clear+value conflict paths are covered by command-surface parser tests. */
    if (definition.values && definition.values.length > 0) {
      throw new PmCliError(
        `Cannot combine ${definition.clearFlag} with ${definition.valueFlag}`,
        EXIT_CODE.USAGE,
      );
    }
    explicitUnsets.add(definition.metadataKey);
    clearOptionKeys.add(definition.optionKey);
  }
  return { explicitUnsets, clearOptionKeys };
}

/**
 * Reject combining `--unset <field>` with the same field's scalar value flag
 * (for example `--unset goal --goal ...`) — the single-value analog of the
 * collection clear/value conflict enforced by {@link collectCreateClearTargets}.
 */
function assertNoCreateScalarUnsetConflicts(
  resolvedOptions: CreateCommandOptions,
  unsetTargets: { optionKeys: Set<string> },
): void {
  const scalarOptionPresence: Record<string, boolean> = {
    tags: resolvedOptions.tags !== undefined,
    deadline: resolvedOptions.deadline !== undefined,
    estimatedMinutes: resolvedOptions.estimatedMinutes !== undefined,
    acceptanceCriteria: resolvedOptions.acceptanceCriteria !== undefined,
    /* c8 ignore next -- definitionOfReady option presence is covered by legacy migration tests. */
    definitionOfReady: resolvedOptions.definitionOfReady !== undefined,
    order:
      resolvedOptions.order !== undefined || resolvedOptions.rank !== undefined,
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
    const unsetField =
      CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey;
    /* c8 ignore stop */
    throw new PmCliError(
      `Cannot combine --unset ${unsetField} with ${commandOptionFlagLabel("create", optionKey)}`,
      EXIT_CODE.USAGE,
    );
  }
}

/** Reject the legacy literal `none`/`null` sentinel on any create scalar option, pointing the author at the modern `--unset <field>` clear syntax (surfacing the canonical unset key in the hint when the option maps to one). */
function assertNoLegacyCreateScalarTokens(
  resolvedOptions: CreateCommandOptions,
): void {
  const assertNoLegacyScalarToken = (
    value: string | undefined,
    optionKey: string,
  ): void => {
    const unsetField = CREATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey);
    const hint = unsetField
      ? `Use --unset ${unsetField} to clear this field.`
      : undefined;
    assertNoLegacyNoneToken(
      value,
      commandOptionFlagLabel("create", optionKey),
      hint,
    );
  };
  assertNoLegacyScalarToken(resolvedOptions.tags, "tags");
  assertNoLegacyScalarToken(resolvedOptions.deadline, "deadline");
  assertNoLegacyScalarToken(
    resolvedOptions.estimatedMinutes,
    "estimatedMinutes",
  );
  assertNoLegacyScalarToken(
    resolvedOptions.acceptanceCriteria,
    "acceptanceCriteria",
  );
  /* c8 ignore next -- legacy none-token guard for definitionOfReady is covered in compatibility test suites. */
  assertNoLegacyScalarToken(
    resolvedOptions.definitionOfReady,
    "definitionOfReady",
  );
  assertNoLegacyScalarToken(
    resolvedOptions.order ?? resolvedOptions.rank,
    "order",
  );
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
}

/** Reject combining `--unset <field>` with an extension-registered or runtime-schema field's value flag. These custom fields are validated separately from the built-in scalar options but honor the same clear/value mutual exclusion. */
function assertNoCreateFieldUnsetConflicts(
  registeredItemFieldValues: Record<string, unknown>,
  runtimeCreateFieldValues: { values?: Record<string, unknown> },
  unsetTargets: { metadataKeys: Set<string> },
): void {
  for (const fieldKey of Object.keys(registeredItemFieldValues)) {
    if (!unsetTargets.metadataKeys.has(fieldKey)) {
      continue;
    }
    throw new PmCliError(
      `Cannot combine --unset ${fieldKey.replaceAll("_", "-")} with --field ${fieldKey}=...`,
      EXIT_CODE.USAGE,
    );
  }
  /* c8 ignore start -- collectRuntimeCreateFieldValues always returns a `values` object, so the `?? {}` fallback is unreachable. */
  for (const fieldKey of Object.keys(runtimeCreateFieldValues.values ?? {})) {
    /* c8 ignore stop */
    if (!unsetTargets.metadataKeys.has(fieldKey)) {
      continue;
    }
    throw new PmCliError(
      `Cannot combine --unset ${fieldKey.replaceAll("_", "-")} with its value flag`,
      EXIT_CODE.USAGE,
    );
  }
}

/** Throw the aggregated `missing_required_option` error when a type's required create options and/or required type-option keys were not all supplied in one invocation. Builds a type-aware valid example and staged-onboarding next steps (a strict-mode invocation also carries a compact recovery envelope). A no-op when nothing is missing. */
function assertNoMissingRequiredCreateOptions(params: {
  combinedMissingFlags: string[];
  typeDefinition: ResolvedItemTypeDefinition;
  missingRequiredCreateFlags: string[];
  missingRequiredTypeOptionKeys: string[];
  openStatus: string;
  type: string;
  createMode: ReturnType<typeof resolveEffectiveCreateMode>;
}): void {
  const {
    combinedMissingFlags,
    typeDefinition,
    missingRequiredCreateFlags,
    missingRequiredTypeOptionKeys,
    openStatus,
    type,
    createMode,
  } = params;
  if (combinedMissingFlags.length === 0) {
    return;
  }
  const nextValidExample = buildTypeSpecificCreateExample(
    typeDefinition,
    missingRequiredCreateFlags,
    missingRequiredTypeOptionKeys,
    openStatus,
  );
  const nextSteps = [
    `Run "pm create --help --type ${type}" for type-aware required option guidance.`,
  ];
  if (combinedMissingFlags.includes("--title")) {
    nextSteps.push(
      'Title can also be passed as the first positional argument (example: pm create "Your title" --type ' +
        type +
        ").",
    );
  }
  if (createMode === "strict") {
    nextSteps.push(
      'For staged onboarding, retry with "--create-mode progressive".',
    );
    if (SCHEDULE_CREATE_PRESET_TYPES.has(type)) {
      nextSteps.push(
        'For minimal scheduling inputs, try "--schedule-preset lightweight".',
      );
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
    recovery:
      createMode === "strict"
        ? {
            recovery_mode: "compact",
            missing_required_fields: combinedMissingFlags,
            suggested_flags: [
              "--create-mode progressive",
              ...combinedMissingFlags,
            ],
          }
        : undefined,
  });
}

/** Resolve the new item's tags: an empty list when `--unset tags` clears the field (rejecting a contradictory `--add-tags`), otherwise the parsed `--tags` merged with any additive `--add-tags`. */
function resolveCreateTags(
  unsetKeys: ReadonlySet<string>,
  resolvedOptions: CreateCommandOptions,
): string[] {
  if (
    unsetKeys.has("tags") &&
    Array.isArray(resolvedOptions.addTags) &&
    resolvedOptions.addTags.length > 0
  ) {
    throw new PmCliError(
      "Cannot combine --unset tags with --add-tags",
      EXIT_CODE.USAGE,
    );
  }
  const baseTags = unsetKeys.has("tags")
    ? []
    : resolvedOptions.tags !== undefined
      ? parseTags(resolvedOptions.tags)
      : [];
  return mergeAdditiveTags(baseTags, resolvedOptions.addTags);
}

/** Resolve the new item's integer `order`: `undefined` when cleared/absent, else the parsed value. Rejects mismatched `--order`/`--rank` and non-integer values. */
function resolveCreateOrder(
  unsetKeys: ReadonlySet<string>,
  resolvedOptions: CreateCommandOptions,
): number | undefined {
  if (
    resolvedOptions.order !== undefined &&
    resolvedOptions.rank !== undefined &&
    resolvedOptions.order !== resolvedOptions.rank
  ) {
    throw new PmCliError(
      "--order and --rank must match when both are provided",
      EXIT_CODE.USAGE,
    );
  }
  const orderRaw = resolvedOptions.order ?? resolvedOptions.rank;
  const order = resolveUnsettableTransformed(
    unsetKeys,
    "order",
    orderRaw,
    (raw) => parseOptionalNumber(raw, "order"),
  );
  if (order !== undefined && !Number.isInteger(order)) {
    throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
  }
  return order;
}

/** Resolve the close reason for an item created directly in the close status (GH-249): honor `governance.require_close_reason` like `pm close`, deriving it from `--message` > `--resolution` and falling back to a stable placeholder, warning `close_reason_defaulted` when neither was supplied. Returns `undefined` (and no warnings) when the item is not being created closed or the policy is off. */
function resolveCreateCloseReason(
  status: ItemStatus,
  statusRegistry: RuntimeStatusRegistry,
  settings: PmSettings,
  resolvedOptions: CreateCommandOptions,
  resolution: string | undefined,
): { closeReason: string | undefined; warnings: string[] } {
  if (
    status !== statusRegistry.close_status ||
    !settings.governance.require_close_reason
  ) {
    return { closeReason: undefined, warnings: [] };
  }
  const messageText =
    typeof resolvedOptions.message === "string"
      ? resolvedOptions.message.trim()
      : "";
  const resolutionText =
    typeof resolution === "string" ? resolution.trim() : "";
  const closeReason =
    messageText || resolutionText || CREATE_DIRECT_CLOSE_REASON_DEFAULT;
  const warnings =
    messageText.length === 0 && resolutionText.length === 0
      ? ["close_reason_defaulted"]
      : [];
  return { closeReason, warnings };
}

/** Commit a freshly built item under its per-id lock: write the serialized document, append the create history entry (rolling back the item file if the history append throws), run the item + history `onWrite` hooks, and record the after-command affected item. Returns the collected hook warnings; the lock is always released. */
async function writeCreatedItem(params: {
  pmRoot: string;
  type: string;
  id: string;
  settings: PmSettings;
  typeRegistry: ItemTypeRegistry;
  author: string;
  extensionFieldNames: ReturnType<typeof collectRegisteredItemFieldNames>;
  afterDocument: ItemDocument;
  beforeDocument: ItemDocument;
  historyMessage: string | undefined;
  changedFields: ReturnType<typeof buildChangedFields>;
  nowValue: string;
}): Promise<string[]> {
  const {
    pmRoot,
    type,
    id,
    settings,
    typeRegistry,
    author,
    extensionFieldNames,
    afterDocument,
    beforeDocument,
    historyMessage,
    changedFields,
    nowValue,
  } = params;
  const itemPath = getItemPath(
    pmRoot,
    type,
    id,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  const historyPath = getHistoryPath(pmRoot, id);
  const lockRelease = await acquireLock(
    pmRoot,
    id,
    settings.locks.ttl_seconds,
    author,
    false,
    settings.governance.force_required_for_stale_lock,
    settings.locks.wait_ms,
  );
  let hookWarnings: string[] = [];
  try {
    const graphBeforeCreate =
      afterDocument.metadata.dependencies &&
      afterDocument.metadata.dependencies.length > 0
        ? await listAllItemMetadataLight(
            pmRoot,
            settings.item_format,
            typeRegistry.type_to_folder,
            undefined,
            settings.schema,
          )
        : undefined;
    const existing = await locateItem(
      pmRoot,
      id,
      settings.id_prefix,
      settings.item_format,
      typeRegistry.type_to_folder,
    );
    if (existing) {
      throw new PmCliError(`Item "${id}" already exists`, EXIT_CODE.CONFLICT);
    }
    const releaseDerivedIndexLock = await acquireItemMetadataDerivedIndexLock(
      pmRoot,
      author,
    );
    let derivedIndexWarnings: string[] = [];
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
      derivedIndexWarnings = await refreshItemMetadataDerivedIndex({
        pmRoot,
        preferredFormat: settings.item_format,
        typeToFolder: typeRegistry.type_to_folder,
        schema: settings.schema,
        itemPath,
        document: afterDocument,
      });
    } finally {
      await releaseDerivedIndexLock();
    }
    hookWarnings = [
      ...(graphBeforeCreate
        ? collectNewOrderingCycleWarnings(
            graphBeforeCreate,
            [...graphBeforeCreate, afterDocument.metadata],
            id,
          )
        : []),
      ...derivedIndexWarnings,
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
      current: projectAfterCommandItemSnapshot(
        afterDocument.metadata,
        changedFields,
      ),
      changed_fields: changedFields,
    });
  } finally {
    await lockRelease();
  }
  return hookWarnings;
}

/** Implements run create for the public runtime surface of this module. */
export async function runCreate(
  options: CreateCommandOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  let resolvedOptions = normalizeLegacyNoneCreateOptions(
    await resolveCreateStdinInputs(options),
  );
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const typeSelection = await resolveCreateTypeSelection(
    resolvedOptions,
    global,
    pmRoot,
    settings,
    typeRegistry,
  );
  resolvedOptions = typeSelection.resolvedOptions;
  const { typeDefinition, type, createMode } = typeSelection;
  const unsetTargets = parseCreateUnsetTargets(
    resolvedOptions.unset,
    runtimeFieldRegistry,
  );
  const { explicitUnsets, clearOptionKeys } = collectCreateClearTargets(
    resolvedOptions,
    unsetTargets,
  );
  assertNoCreateScalarUnsetConflicts(resolvedOptions, unsetTargets);
  assertNoLegacyCreateScalarTokens(resolvedOptions);

  const missingRequiredCreateFlags = requireCreateOptionByType(
    typeDefinition,
    resolvedOptions,
    createMode,
    clearOptionKeys,
  );
  const nowValue = nowIso();
  const author = selectAuthor(resolvedOptions.author, settings.author_default);

  const dependencies = parseDependencies(
    resolvedOptions.dep,
    nowValue,
    settings.id_prefix,
  );
  const comments = parseLogSeed(
    "--comment",
    resolvedOptions.comment,
    nowValue,
    author,
  );
  const notes = parseLogSeed("--note", resolvedOptions.note, nowValue, author);
  const learnings = parseLogSeed(
    "--learning",
    resolvedOptions.learning,
    nowValue,
    author,
  );
  const files = parseFiles(resolvedOptions.file);
  const tests = parseTests(resolvedOptions.test);
  const docs = parseDocs(resolvedOptions.doc);
  const reminders = parseReminders(resolvedOptions.reminder, nowValue);
  const events = parseEvents(resolvedOptions.event, nowValue);
  const typeOptions = parseTypeOptions(resolvedOptions.typeOption);
  const validatedTypeOptions = validateTypeOptions(
    type,
    typeOptions.values,
    typeRegistry,
  );
  const extensionRegistrations = getActiveExtensionRegistrations();
  const extensionFieldNames = collectRegisteredItemFieldNames(
    extensionRegistrations,
  );
  const registeredItemFieldValues = parseRegisteredItemFieldAssignments(
    resolvedOptions.field,
    extensionRegistrations,
  );
  const runtimeCreateFieldValues = collectRuntimeCreateFieldValues(
    resolvedOptions as Record<string, unknown>,
    runtimeFieldRegistry,
    type,
  );
  assertNoCreateFieldUnsetConflicts(
    registeredItemFieldValues,
    runtimeCreateFieldValues,
    unsetTargets,
  );
  const missingRequiredTypeOptionKeys = collectMissingRequiredTypeOptionKeys(
    validatedTypeOptions.errors,
    type,
  );
  const missingRequiredTypeOptionFlags = missingRequiredTypeOptionKeys.map(
    (key) => `--type-option ${key}=<value>`,
  );
  const combinedMissingFlags = [
    ...new Set([
      ...missingRequiredCreateFlags,
      ...missingRequiredTypeOptionFlags,
      /* c8 ignore next -- runtime-required flag aggregation is covered in runtime schema create tests. */
      ...runtimeCreateFieldValues.missing_required_flags,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  assertNoMissingRequiredCreateOptions({
    combinedMissingFlags,
    typeDefinition,
    missingRequiredCreateFlags,
    missingRequiredTypeOptionKeys,
    openStatus: statusRegistry.open_status,
    type,
    createMode,
  });
  assertNoInvalidTypeOptions(
    validatedTypeOptions.errors,
    type,
    typeDefinition,
    statusRegistry,
  );

  const id = await resolveCreateItemId({
    pmRoot,
    settings,
    explicitId: resolvedOptions.id,
  });
  let status =
    resolvedOptions.status !== undefined
      ? parseStatusValue(resolvedOptions.status, statusRegistry)
      : resolveCreateDefaultStatus(typeDefinition, statusRegistry);
  const priority =
    resolvedOptions.priority !== undefined
      ? ensurePriority(resolvedOptions.priority)
      : 2;
  const unsetKeys = unsetTargets.metadataKeys;
  const tags = resolveCreateTags(unsetKeys, resolvedOptions);
  const deadline = resolveUnsettableTransformed(
    unsetKeys,
    "deadline",
    resolvedOptions.deadline,
    (raw) => resolveIsoOrRelative(raw, new Date(nowValue), "deadline"),
  );
  const estimatedMinutes = resolveUnsettableTransformed(
    unsetKeys,
    "estimated_minutes",
    resolvedOptions.estimatedMinutes,
    (raw) => parseOptionalNonNegativeInteger(raw, "estimated-minutes"),
  );
  const acceptanceCriteria = resolveUnsettableOptionalString(
    unsetKeys,
    "acceptance_criteria",
    resolvedOptions.acceptanceCriteria,
  );
  const definitionOfReady = resolveUnsettableOptionalString(
    unsetKeys,
    "definition_of_ready",
    resolvedOptions.definitionOfReady,
  );
  const order = resolveCreateOrder(unsetKeys, resolvedOptions);
  const goal = resolveUnsettableOptionalString(
    unsetKeys,
    "goal",
    resolvedOptions.goal,
  );
  const objective = resolveUnsettableOptionalString(
    unsetKeys,
    "objective",
    resolvedOptions.objective,
  );
  const value = resolveUnsettableOptionalString(
    unsetKeys,
    "value",
    resolvedOptions.value,
  );
  const impact = resolveUnsettableOptionalString(
    unsetKeys,
    "impact",
    resolvedOptions.impact,
  );
  const outcome = resolveUnsettableOptionalString(
    unsetKeys,
    "outcome",
    resolvedOptions.outcome,
  );
  const whyNow = resolveUnsettableOptionalString(
    unsetKeys,
    "why_now",
    resolvedOptions.whyNow,
  );
  const assignee = resolveUnsettableOptionalString(
    unsetKeys,
    "assignee",
    resolvedOptions.assignee,
  );
  const authorValue = unsetKeys.has("author")
    ? undefined
    : (parseOptionalString(resolvedOptions.author) ?? author);
  // GH-161 (pm-72xf): inherit the session-focused parent when no explicit
  // --parent was supplied and parent is not being unset; an explicit --parent
  // (including `--parent ""`) overrides focus. The inherited value flows through
  // the same locate/validate path below as an explicit parent.
  const initialParent = resolveUnsettableOptionalString(
    unsetKeys,
    "parent",
    resolvedOptions.parent,
  );
  const inheritedParent = await inheritFocusedParent(
    initialParent,
    resolvedOptions,
    unsetKeys,
    pmRoot,
  );
  let parent = inheritedParent.parent;
  const parentSource = inheritedParent.parentSource;
  const reviewer = resolveUnsettableOptionalString(
    unsetKeys,
    "reviewer",
    resolvedOptions.reviewer,
  );
  const risk = resolveUnsettableTransformed(
    unsetKeys,
    "risk",
    resolvedOptions.risk,
    (raw) => ensureEnumValue(normalizeRiskInput(raw), RISK_VALUES, "risk"),
  );
  const confidence = resolveUnsettableTransformed(
    unsetKeys,
    "confidence",
    resolvedOptions.confidence,
    (raw) => parseConfidenceInput(raw),
  );
  const parentReferencePolicy =
    resolvedOptions.allowMissingParent === true &&
    settings.validation.parent_reference === "strict_error"
      ? "warn"
      : settings.validation.parent_reference;
  const sprintReleasePolicy = settings.validation.sprint_release_format;
  const validationWarnings: string[] = collectCreateScheduleWarnings(
    type,
    id,
    deadline,
    reminders.values,
    events.values,
  );
  const parentValidation = await resolveCreateParentWithWarnings({
    itemId: id,
    parent,
    pmRoot,
    settings,
    typeRegistry,
    policy: parentReferencePolicy,
  });
  parent = parentValidation.parent;
  validationWarnings.push(...parentValidation.warnings);
  const sprintResolved = resolveCreateSprintOrRelease(
    unsetKeys,
    "sprint",
    resolvedOptions.sprint,
    "sprint",
    sprintReleasePolicy,
  );
  const sprint = sprintResolved.value;
  validationWarnings.push(...sprintResolved.warnings);
  const releaseResolved = resolveCreateSprintOrRelease(
    unsetKeys,
    "release",
    resolvedOptions.release,
    "release",
    sprintReleasePolicy,
  );
  const release = releaseResolved.value;
  validationWarnings.push(...releaseResolved.warnings);
  const blockedBy = resolveUnsettableOptionalString(
    unsetKeys,
    "blocked_by",
    resolvedOptions.blockedBy,
  );
  const blockedByResolution = await resolveCreateBlockedByDependency({
    pmRoot,
    settings,
    typeRegistry,
    statusRegistry,
    blockedBy,
    dependencyValues: dependencies.values,
    status,
    statusExplicit: resolvedOptions.status !== undefined,
    nowValue,
    author,
  });
  const dependencyValues = blockedByResolution.dependencyValues;
  status = blockedByResolution.status;
  const blockedReason = resolveUnsettableOptionalString(
    unsetKeys,
    "blocked_reason",
    resolvedOptions.blockedReason,
  );
  const unblockNote = resolveUnsettableOptionalString(
    unsetKeys,
    "unblock_note",
    resolvedOptions.unblockNote,
  );
  const reporter = resolveUnsettableOptionalString(
    unsetKeys,
    "reporter",
    resolvedOptions.reporter,
  );
  const severity = resolveUnsettableTransformed(
    unsetKeys,
    "severity",
    resolvedOptions.severity,
    (raw) =>
      ensureEnumValue(
        normalizeSeverityInput(raw),
        ISSUE_SEVERITY_VALUES,
        "severity",
      ),
  );
  const environment = resolveUnsettableOptionalString(
    unsetKeys,
    "environment",
    resolvedOptions.environment,
  );
  const reproSteps = resolveUnsettableOptionalString(
    unsetKeys,
    "repro_steps",
    resolvedOptions.reproSteps,
  );
  const resolution = resolveUnsettableOptionalString(
    unsetKeys,
    "resolution",
    resolvedOptions.resolution,
  );
  const expectedResult = resolveUnsettableOptionalString(
    unsetKeys,
    "expected_result",
    resolvedOptions.expectedResult,
  );
  const actualResult = resolveUnsettableOptionalString(
    unsetKeys,
    "actual_result",
    resolvedOptions.actualResult,
  );
  const affectedVersion = resolveUnsettableOptionalString(
    unsetKeys,
    "affected_version",
    resolvedOptions.affectedVersion,
  );
  const fixedVersion = resolveUnsettableOptionalString(
    unsetKeys,
    "fixed_version",
    resolvedOptions.fixedVersion,
  );
  const component = resolveUnsettableOptionalString(
    unsetKeys,
    "component",
    resolvedOptions.component,
  );
  const regression = resolveUnsettableTransformed(
    unsetKeys,
    "regression",
    resolvedOptions.regression,
    (raw) => parseRegressionInput(raw),
  );
  const customerImpact = resolveUnsettableOptionalString(
    unsetKeys,
    "customer_impact",
    resolvedOptions.customerImpact,
  );
  const title = requireStringOption(resolvedOptions.title, "--title");
  const description = resolvedOptions.description ?? "";
  const body = resolvedOptions.body ?? "";

  // GH-249: creating an item directly in the close status must honor
  // governance.require_close_reason, just like `pm close` (errors when missing)
  // and `pm update --status closed` (defaults + warns).
  const closeReasonResolution = resolveCreateCloseReason(
    status,
    statusRegistry,
    settings,
    resolvedOptions,
    resolution,
  );
  const closeReason = closeReasonResolution.closeReason;
  const closedAt =
    status === statusRegistry.close_status ? nowValue : undefined;
  validationWarnings.push(...closeReasonResolution.warnings);

  const itemMetadata: ItemMetadata = normalizeItemMetadata({
    id,
    title,
    description,
    type,
    type_options: validatedTypeOptions.normalized,
    status,
    closed_at: closedAt,
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
    ...runtimeCreateFieldValues.values,
  });
  try {
    applyRegisteredItemFieldDefaultsAndValidation(
      itemMetadata as unknown as Record<string, unknown>,
      extensionRegistrations,
    );
  } catch (error: unknown) {
    /* c8 ignore start -- applyRegisteredItemFieldDefaultsAndValidation only throws Error instances, so the non-Error message fallback is unreachable. */
    throw new PmCliError(
      error instanceof Error
        ? error.message
        : "Invalid extension item field values",
      EXIT_CODE.USAGE,
    );
    /* c8 ignore stop */
  }

  const afterDocument: ItemDocument = canonicalDocument(
    {
      metadata: itemMetadata,
      body,
    },
    { schema: settings.schema, extensionFieldNames },
  );
  const beforeDocument: ItemDocument = {
    metadata: {} as ItemMetadata,
    body: "",
  };

  const explicitUnsetKeys = [...explicitUnsets].sort((left, right) =>
    left.localeCompare(right),
  );
  const historyMessage = buildHistoryMessage(
    resolvedOptions.message,
    explicitUnsetKeys,
  );
  const changedFields = buildChangedFields(
    itemMetadata,
    body,
    explicitUnsetKeys,
    [
      ...Object.keys(registeredItemFieldValues),
      /* c8 ignore start -- collectRuntimeCreateFieldValues always returns a `values` object, so the `?? {}` fallback is unreachable. */
      ...Object.keys(runtimeCreateFieldValues.values ?? {}),
      /* c8 ignore stop */
    ],
  );
  const hookWarnings = await writeCreatedItem({
    pmRoot,
    type,
    id,
    settings,
    typeRegistry,
    author,
    extensionFieldNames,
    afterDocument,
    beforeDocument,
    historyMessage,
    changedFields,
    nowValue,
  });

  const outputItem = structuredClone(itemMetadata);

  // GH-216: nudge agents toward the underutilized in_progress state instead of
  // jumping open -> closed. Only surfaces for workable types created in the open
  // status when the workflow defines a distinct in_progress status to move to.
  const nextTransition = suggestNextLifecycleTransition(
    id,
    type,
    status,
    statusRegistry,
  );

  // After the create has committed (so the ID is real and shows up in the suggestion),
  // emit a single non-blocking stderr hint when the new item would be invisible on `pm
  // calendar`. The structured `calendar_item_without_schedule:*` warning above is what
  // automation reads; this stderr line is the human/agent-facing version with a
  // copy-pasteable `pm update` recipe.
  if (
    createItemLacksSchedule(type, deadline, reminders.values, events.values)
  ) {
    printError(
      `[pm] warning: ${type} '${id}' has no deadline/reminder/event — it will not appear on the calendar. Add one via 'pm update ${id} --deadline <ISO>' or 'pm update ${id} --event "start=<ISO>,end=<ISO>"'.`,
    );
  }

  return {
    item: outputItem,
    changed_fields: changedFields,
    warnings: [...validationWarnings, ...hookWarnings],
    ...(parentSource !== undefined ? { parent_source: parentSource } : {}),
    ...(nextTransition !== undefined
      ? { next_transition: nextTransition }
      : {}),
  };
}

/** Public contract for test only create command, shared by SDK and presentation-layer consumers. */
export const _testOnlyCreateCommand = {
  buildHistoryMessage,
  buildInvalidLogSeedKeysMessage,
  buildTypeSpecificCreateExample,
  collectMissingRequiredTypeOptionKeys,
  createExampleTokensForFlag,
  filterNonMissingTypeOptionErrors,
  hasTemplatesShowHandler,
  hasCreateOptionValue,
  loadCreateTemplateOptionsFromRuntime,
  looksLikeStructuredEntry,
  mergeCreateOptionsWithTemplate,
  normalizeCreatePolicyOptionKey,
  normalizeDependencyKindInput,
  parseDependencies,
  normalizeExtensionCommandPath,
  parseCreateUnsetTargets,
  requireStringOption,
  readTemplateOptionsFromRuntimeResult,
  resolveRuntimeCreateUnsetDefinition: (
    token: string,
    registry: RuntimeFieldRegistry | undefined,
  ) => resolveRuntimeUnsetFieldDefinition(token, "create", registry),
  typeOptionExampleValue,
};
