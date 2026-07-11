/**
 * @module cli/commands/update
 *
 * Implements the pm update command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import {
  COMMON_MUTATION_COMMAND_OPTION_KEYS,
  canonicalizeCommandOptionKey,
  commandOptionFlagLabel,
  resolveItemTypeRegistry,
  resolveCommandOptionPolicyState,
  resolveTypeDefinition,
  resolveTypeName,
  validateTypeOptions,
} from "../../core/item/type-registry.js";
import { normalizeItemId } from "../../core/item/id.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { buildInvalidTypeError } from "../../core/schema/item-types-file.js";
import {
  assertParentReferenceIsNotSelf,
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import {
  applyTagRemovals,
  assertNoUnknownCsvKeys,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNumber,
  parseTags,
} from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { collectRuntimeUpdateFieldValues } from "../../core/schema/runtime-field-values.js";
import {
  resolveItemTypesFilePath,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import {
  describeAllowedTransitions,
  evaluateTransition,
  resolveTypeWorkflows,
  type NormalizedTypeWorkflow,
} from "../../core/schema/type-workflows.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import {
  collectRegisteredItemFieldNames,
  applyRegisteredItemFieldDefaultsAndValidation,
  parseRegisteredItemFieldAssignments,
} from "../../core/extensions/item-fields.js";
import {
  buildItemNotFoundError,
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runClose } from "./close.js";
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
import { ensureEnumValue as ensureEnum } from "./recurrence-parsers.js";
import {
  parseEventEntries,
  parseReminderEntries,
  parseTypeOptionEntries,
} from "./repeatable-metadata-parsers.js";
import { assertValidBareDependencyFlagValue } from "../../sdk/dependency-flag-validation.js";
import type {
  Comment,
  Dependency,
  GovernanceWorkflowEnforcement,
  ItemFormat,
  ItemDocument,
  ItemFrontMatter,
  ItemStatus,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
} from "../../types/index.js";
import {
  DEPENDENCY_KIND_VALUES,
  ISSUE_SEVERITY_VALUES,
  RISK_VALUES,
} from "../../types/index.js";
import { parseDocs, parseFiles, parseLogSeed, parseTests } from "./create.js";
import {
  COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
  COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
  COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
  parseCommandUnsetTargets,
  resolveRuntimeUnsetFieldDefinition,
  type CommandUnsetFieldDefinition,
} from "./shared-unset-fields.js";
import type {
  MutationMetadataCommandOptions,
  SharedLinkedResourceClearOptions,
  SharedLinkedResourceOptions,
} from "./mutation-command-options.js";

/** Documents the update command options payload exchanged by command, SDK, and package integrations. */
export interface UpdateCommandOptions
  extends
    MutationMetadataCommandOptions,
    SharedLinkedResourceOptions,
    SharedLinkedResourceClearOptions {
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports body for this contract. */
  body?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports close reason for this contract. */
  closeReason?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tags for this contract. */
  tags?: string;
  /** Value that configures or reports add tags for this contract. */
  addTags?: string[];
  /** Value that configures or reports remove tags for this contract. */
  removeTags?: string[];
  /** Value that configures or reports force for this contract. */
  force?: boolean;
  /** Value that configures or reports allow audit update for this contract. */
  allowAuditUpdate?: boolean;
  /** Value that configures or reports allow audit dep update for this contract. */
  allowAuditDepUpdate?: boolean;
  /** Value that configures or reports dep remove for this contract. */
  depRemove?: string[];
  /** Value that configures or reports replace deps for this contract. */
  replaceDeps?: boolean;
  /** Value that configures or reports replace tests for this contract. */
  replaceTests?: boolean;
  /** Value that configures or reports runtime field commands for this contract. */
  runtimeFieldCommands?: Array<"update" | "update_many">;
  [key: string]: unknown;
}

/** Documents the update result payload exchanged by command, SDK, and package integrations. */
export interface UpdateResult {
  /** Value that configures or reports item for this contract. */
  item: Record<string, unknown>;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports audit update for this contract. */
  audit_update?: boolean;
}

interface UpdateUnsetFieldDefinition {
  optionKey: string;
  frontMatterKey: string;
}

const UPDATE_UNSET_FIELD_DEFINITIONS: readonly CommandUnsetFieldDefinition[] = [
  ...COMMON_UNSET_FIELD_DEFINITIONS_BEFORE_CLOSE_REASON,
  {
    canonical: "close-reason",
    aliases: ["close_reason", "close-reason"],
    optionKey: "closeReason",
    frontMatterKey: "close_reason",
  },
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_CLOSE_REASON_BEFORE_AUTHOR,
  ...COMMON_UNSET_FIELD_DEFINITIONS_AFTER_AUTHOR,
];

const UPDATE_UNSET_ALIAS_MAP: Map<string, UpdateUnsetFieldDefinition> = (() => {
  const map = new Map<string, UpdateUnsetFieldDefinition>();
  for (const definition of UPDATE_UNSET_FIELD_DEFINITIONS) {
    for (const alias of definition.aliases) {
      map.set(alias, {
        optionKey: definition.optionKey,
        frontMatterKey: definition.frontMatterKey,
      });
    }
  }
  return map;
})();

const UPDATE_OPTION_KEY_TO_UNSET_CANONICAL = new Map<string, string>(
  UPDATE_UNSET_FIELD_DEFINITIONS.map((definition) => [
    definition.optionKey,
    definition.canonical,
  ]),
);

const UPDATE_UNSET_SUPPORTED_CANONICAL_FIELDS =
  UPDATE_UNSET_FIELD_DEFINITIONS.map((definition) => definition.canonical)
    .sort((left, right) => left.localeCompare(right))
    .join(", ");

const AUDIT_UPDATE_DISALLOWED_UNSET_FRONT_MATTER_KEYS = new Set<string>([
  "close_reason",
  "assignee",
  "parent",
  "blocked_by",
  "blocked_reason",
  "unblock_note",
  "dependencies",
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "docs",
  "reminders",
  "events",
]);

function toAuthor(
  candidate: string | undefined,
  defaultAuthor: string,
): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

const UPDATE_LEGACY_NONE_COLLECTION_NORMALIZERS =
  createLegacyNoneCollectionNormalizers<UpdateCommandOptions>({
    depDisableFlagKey: "replaceDeps",
    testDisableFlagKey: "replaceTests",
  });

function normalizeLegacyNoneUpdateOptions(
  options: UpdateCommandOptions,
): UpdateCommandOptions {
  const normalized: UpdateCommandOptions = {
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

  const scalarOptionKeys = new Set<string>([
    ...UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.keys(),
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
        : (UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey);
    appendUnsetTarget(canonicalUnset);
    normalized[optionKey] = undefined;
    /* c8 ignore stop */
  }

  return applyLegacyNoneCollectionNormalizers(
    normalized,
    UPDATE_LEGACY_NONE_COLLECTION_NORMALIZERS,
  );
}

function parseUpdateUnsetTargets(
  raw: string[] | undefined,
  runtimeFieldRegistry?: RuntimeFieldRegistry,
  extensionFieldNames: readonly string[] = [],
): { frontMatterKeys: Set<string>; optionKeys: Set<string> } {
  return parseCommandUnsetTargets({
    raw,
    supportedFields: UPDATE_UNSET_SUPPORTED_CANONICAL_FIELDS,
    resolveDefinition: (trimmed) => {
      const extensionFieldName = extensionFieldNames.find((fieldName) => {
        const normalizedFieldName = fieldName.toLowerCase();
        return (
          normalizedFieldName === trimmed ||
          normalizedFieldName.replaceAll("_", "-") === trimmed ||
          normalizedFieldName.replaceAll("-", "_") === trimmed
        );
      });
      const definition =
        UPDATE_UNSET_ALIAS_MAP.get(trimmed) ??
        resolveRuntimeUnsetFieldDefinition(
          trimmed,
          "update",
          runtimeFieldRegistry,
        ) ??
        (extensionFieldName
          ? { optionKey: "field", frontMatterKey: extensionFieldName }
          : undefined);
      return definition;
    },
  });
}

// Restricted append-style flags have dedicated commands with their own
// audit/override semantics; map each one to its exact replacement invocation so
// audit-scope errors tell the agent how to retry instead of dead-ending. The
// evidence append flags are allowed by --allow-audit-update, but still used by
// narrower scopes such as --allow-audit-dep-update.
const AUDIT_RESTRICTED_FLAG_REPLACEMENTS: ReadonlyMap<
  string,
  (id: string) => string
> = new Map([
  [
    "--comment",
    (id: string) => `pm comments ${id} --add "<text>" --allow-audit-comment`,
  ],
  [
    "--file",
    (id: string) =>
      `pm files ${id} --add "path=<path>,scope=<scope>,note=<note>" --force`,
  ],
  [
    "--doc",
    (id: string) =>
      `pm docs ${id} --add "path=<path>,scope=<scope>,note=<note>" --force`,
  ],
]);

function buildAuditScopeRestrictedOptionsError(params: {
  id: string;
  code: string;
  message: string;
  required: string;
  why: string;
  disallowedFlags: string[];
}): PmCliError {
  // Only surface replacement commands for restricted flags the caller actually
  // passed, so the guidance is an exact retry path.
  const replacementCommands = params.disallowedFlags.flatMap((flag) => {
    const replacement = AUDIT_RESTRICTED_FLAG_REPLACEMENTS.get(flag);
    return replacement ? [replacement(params.id)] : [];
  });
  const replacementSteps = params.disallowedFlags.flatMap((flag) => {
    const replacement = AUDIT_RESTRICTED_FLAG_REPLACEMENTS.get(flag);
    return replacement
      ? [`Replace ${flag} with: ${replacement(params.id)}`]
      : [];
  });
  return new PmCliError(params.message, EXIT_CODE.USAGE, {
    code: params.code,
    required: params.required,
    why: params.why,
    ...(replacementCommands.length > 0
      ? { examples: replacementCommands }
      : {}),
    nextSteps: [
      `Re-run without: ${params.disallowedFlags.join(", ")}`,
      ...replacementSteps,
    ],
  });
}

function enforceAllowAuditUpdateScope(
  id: string,
  options: UpdateCommandOptions,
  clearFrontMatterKeys: Set<string>,
): void {
  const allowAuditUpdate = options.allowAuditUpdate === true;
  const allowAuditDepUpdate = options.allowAuditDepUpdate === true;
  if (!allowAuditUpdate && !allowAuditDepUpdate) {
    return;
  }
  if (allowAuditUpdate && allowAuditDepUpdate) {
    throw new PmCliError(
      "Choose either --allow-audit-update or --allow-audit-dep-update; these override modes are mutually exclusive.",
      EXIT_CODE.USAGE,
    );
  }
  const pushIf = (condition: boolean, flag: string, list: string[]): void => {
    if (condition) {
      list.push(flag);
    }
  };
  if (allowAuditDepUpdate) {
    const disallowedFlags: string[] = [];
    pushIf(options.title !== undefined, "--title", disallowedFlags);
    pushIf(options.description !== undefined, "--description", disallowedFlags);
    pushIf(options.body !== undefined, "--body", disallowedFlags);
    pushIf(options.status !== undefined, "--status", disallowedFlags);
    pushIf(
      options.closeReason !== undefined,
      "--close-reason",
      disallowedFlags,
    );
    pushIf(options.priority !== undefined, "--priority", disallowedFlags);
    pushIf(options.type !== undefined, "--type", disallowedFlags);
    pushIf(options.tags !== undefined, "--tags", disallowedFlags);
    pushIf(
      Array.isArray(options.addTags) && options.addTags.length > 0,
      "--add-tags",
      disallowedFlags,
    );
    pushIf(
      Array.isArray(options.removeTags) && options.removeTags.length > 0,
      "--remove-tags",
      disallowedFlags,
    );
    pushIf(options.deadline !== undefined, "--deadline", disallowedFlags);
    pushIf(
      options.estimatedMinutes !== undefined,
      "--estimate",
      disallowedFlags,
    );
    pushIf(
      options.acceptanceCriteria !== undefined,
      "--acceptance-criteria",
      disallowedFlags,
    );
    pushIf(
      options.definitionOfReady !== undefined,
      "--definition-of-ready",
      disallowedFlags,
    );
    pushIf(
      options.order !== undefined || options.rank !== undefined,
      "--order/--rank",
      disallowedFlags,
    );
    pushIf(options.goal !== undefined, "--goal", disallowedFlags);
    pushIf(options.objective !== undefined, "--objective", disallowedFlags);
    pushIf(options.value !== undefined, "--value", disallowedFlags);
    pushIf(options.impact !== undefined, "--impact", disallowedFlags);
    pushIf(options.outcome !== undefined, "--outcome", disallowedFlags);
    pushIf(options.whyNow !== undefined, "--why-now", disallowedFlags);
    pushIf(options.assignee !== undefined, "--assignee", disallowedFlags);
    pushIf(options.parent !== undefined, "--parent", disallowedFlags);
    pushIf(options.reviewer !== undefined, "--reviewer", disallowedFlags);
    pushIf(options.risk !== undefined, "--risk", disallowedFlags);
    pushIf(options.confidence !== undefined, "--confidence", disallowedFlags);
    pushIf(options.sprint !== undefined, "--sprint", disallowedFlags);
    pushIf(options.release !== undefined, "--release", disallowedFlags);
    pushIf(options.blockedBy !== undefined, "--blocked-by", disallowedFlags);
    pushIf(
      options.blockedReason !== undefined,
      "--blocked-reason",
      disallowedFlags,
    );
    pushIf(
      options.unblockNote !== undefined,
      "--unblock-note",
      disallowedFlags,
    );
    pushIf(options.reporter !== undefined, "--reporter", disallowedFlags);
    pushIf(options.severity !== undefined, "--severity", disallowedFlags);
    pushIf(options.environment !== undefined, "--environment", disallowedFlags);
    pushIf(options.reproSteps !== undefined, "--repro-steps", disallowedFlags);
    pushIf(options.resolution !== undefined, "--resolution", disallowedFlags);
    pushIf(
      options.expectedResult !== undefined,
      "--expected-result",
      disallowedFlags,
    );
    pushIf(
      options.actualResult !== undefined,
      "--actual-result",
      disallowedFlags,
    );
    pushIf(
      options.affectedVersion !== undefined,
      "--affected-version",
      disallowedFlags,
    );
    pushIf(
      options.fixedVersion !== undefined,
      "--fixed-version",
      disallowedFlags,
    );
    pushIf(options.component !== undefined, "--component", disallowedFlags);
    pushIf(options.regression !== undefined, "--regression", disallowedFlags);
    pushIf(
      options.customerImpact !== undefined,
      "--customer-impact",
      disallowedFlags,
    );
    pushIf(options.depRemove !== undefined, "--dep-remove", disallowedFlags);
    pushIf(options.replaceDeps === true, "--replace-deps", disallowedFlags);
    pushIf(options.replaceTests === true, "--replace-tests", disallowedFlags);
    pushIf(options.comment !== undefined, "--comment", disallowedFlags);
    pushIf(options.note !== undefined, "--note", disallowedFlags);
    pushIf(options.learning !== undefined, "--learning", disallowedFlags);
    pushIf(options.file !== undefined, "--file", disallowedFlags);
    pushIf(options.test !== undefined, "--test", disallowedFlags);
    pushIf(options.doc !== undefined, "--doc", disallowedFlags);
    pushIf(options.reminder !== undefined, "--reminder", disallowedFlags);
    pushIf(options.event !== undefined, "--event", disallowedFlags);
    pushIf(options.typeOption !== undefined, "--type-option", disallowedFlags);
    pushIf(options.clearDeps === true, "--clear-deps", disallowedFlags);
    pushIf(options.clearComments === true, "--clear-comments", disallowedFlags);
    pushIf(options.clearNotes === true, "--clear-notes", disallowedFlags);
    pushIf(
      options.clearLearnings === true,
      "--clear-learnings",
      disallowedFlags,
    );
    pushIf(options.clearFiles === true, "--clear-files", disallowedFlags);
    pushIf(options.clearTests === true, "--clear-tests", disallowedFlags);
    pushIf(options.clearDocs === true, "--clear-docs", disallowedFlags);
    pushIf(
      options.clearReminders === true,
      "--clear-reminders",
      disallowedFlags,
    );
    pushIf(options.clearEvents === true, "--clear-events", disallowedFlags);
    pushIf(
      options.clearTypeOptions === true,
      "--clear-type-options",
      disallowedFlags,
    );
    pushIf(options.force === true, "--force", disallowedFlags);
    pushIf(clearFrontMatterKeys.size > 0, "--unset", disallowedFlags);
    if (options.dep === undefined || options.dep.length === 0) {
      throw new PmCliError(
        "--allow-audit-dep-update requires at least one --dep value",
        EXIT_CODE.USAGE,
      );
    }
    if (disallowedFlags.length > 0) {
      throw buildAuditScopeRestrictedOptionsError({
        id,
        code: "audit_dep_update_restricted_options",
        message: `--allow-audit-dep-update supports append-only dependency additions via --dep. Remove restricted options: ${disallowedFlags.join(", ")}`,
        required:
          "Pass only --dep additions (plus --message/--author) when using --allow-audit-dep-update.",
        why: "--allow-audit-dep-update is a narrow non-owner override scoped to append-only dependency additions; every other mutation keeps its normal ownership rules.",
        disallowedFlags,
      });
    }
    return;
  }

  const disallowedFlags: string[] = [];
  pushIf(options.status !== undefined, "--status", disallowedFlags);
  pushIf(options.closeReason !== undefined, "--close-reason", disallowedFlags);
  pushIf(options.assignee !== undefined, "--assignee", disallowedFlags);
  pushIf(options.parent !== undefined, "--parent", disallowedFlags);
  pushIf(options.blockedBy !== undefined, "--blocked-by", disallowedFlags);
  pushIf(
    options.blockedReason !== undefined,
    "--blocked-reason",
    disallowedFlags,
  );
  pushIf(options.unblockNote !== undefined, "--unblock-note", disallowedFlags);
  pushIf(options.dep !== undefined, "--dep", disallowedFlags);
  pushIf(options.depRemove !== undefined, "--dep-remove", disallowedFlags);
  pushIf(options.replaceDeps === true, "--replace-deps", disallowedFlags);
  pushIf(options.replaceTests === true, "--replace-tests", disallowedFlags);
  pushIf(options.note !== undefined, "--note", disallowedFlags);
  pushIf(options.learning !== undefined, "--learning", disallowedFlags);
  pushIf(options.test !== undefined, "--test", disallowedFlags);
  pushIf(options.reminder !== undefined, "--reminder", disallowedFlags);
  pushIf(options.event !== undefined, "--event", disallowedFlags);
  pushIf(options.clearDeps === true, "--clear-deps", disallowedFlags);
  pushIf(options.clearComments === true, "--clear-comments", disallowedFlags);
  pushIf(options.clearNotes === true, "--clear-notes", disallowedFlags);
  pushIf(options.clearLearnings === true, "--clear-learnings", disallowedFlags);
  pushIf(options.clearFiles === true, "--clear-files", disallowedFlags);
  pushIf(options.clearTests === true, "--clear-tests", disallowedFlags);
  pushIf(options.clearDocs === true, "--clear-docs", disallowedFlags);
  pushIf(options.clearReminders === true, "--clear-reminders", disallowedFlags);
  pushIf(options.clearEvents === true, "--clear-events", disallowedFlags);

  /* c8 ignore start -- audit unset ordering fallback is validated by audit-governance integration coverage. */
  const disallowedUnset = [...clearFrontMatterKeys]
    .filter((field) =>
      AUDIT_UPDATE_DISALLOWED_UNSET_FRONT_MATTER_KEYS.has(field),
    )
    .sort((left, right) => left.localeCompare(right))
    .map((field) => `--unset ${field.replaceAll("_", "-")}`);
  /* c8 ignore stop */
  disallowedFlags.push(...disallowedUnset);

  if (disallowedFlags.length > 0) {
    throw buildAuditScopeRestrictedOptionsError({
      id,
      code: "audit_update_restricted_options",
      message: `--allow-audit-update only supports non-lifecycle metadata fields and evidence appends. Remove restricted options: ${disallowedFlags.join(", ")}`,
      required:
        "Limit --allow-audit-update to non-lifecycle metadata fields plus append-only --comment/--file/--doc evidence; route restricted appends and lifecycle changes through their dedicated commands.",
      why: "--allow-audit-update is a non-owner override scoped to metadata audits and append-only evidence; lifecycle, ownership, dependency mutations, restricted append fields, and clear/replace operations keep their normal ownership rules.",
      disallowedFlags,
    });
  }
}

/* c8 ignore start -- lifecycle/dependency edge branches are exercised by dedicated update workflow integration tests. */
function parseStatus(
  value: string,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus {
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map(
      (definition) => definition.id,
    );
    throw new PmCliError(
      `Invalid --status value "${value}". Allowed: ${allowedStatuses.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

/** Enforce per-type allowed-transition rules (governance.workflow_enforcement). `off` (default) or an unrestricted type is a no-op. `strict` throws on a disallowed transition; `warn` returns a warning string surfaced on the update result. The target status is the raw `--status` value (resolved case-insensitively through the registry inside evaluateTransition). */
function enforceTypeWorkflowTransition(params: {
  enforcement: GovernanceWorkflowEnforcement;
  typeWorkflows: NormalizedTypeWorkflow[];
  statusRegistry: RuntimeStatusRegistry;
  typeName: string;
  fromStatus: string;
  toStatus: string;
}): string | undefined {
  if (params.enforcement === "off" || params.typeWorkflows.length === 0) {
    return undefined;
  }
  const result = evaluateTransition({
    typeName: params.typeName,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    typeWorkflows: params.typeWorkflows,
    statusRegistry: params.statusRegistry,
  });
  if (!result.hasRule || result.allowed) {
    return undefined;
  }
  const normalizedFrom =
    normalizeStatusInput(params.fromStatus, params.statusRegistry) ??
    params.fromStatus;
  const normalizedTo =
    normalizeStatusInput(params.toStatus, params.statusRegistry) ??
    params.toStatus;
  const message =
    `Disallowed transition for type "${params.typeName}": ${normalizedFrom} -> ${normalizedTo}. ` +
    `Allowed transitions: ${describeAllowedTransitions(result.allowedTransitions)}.`;
  if (params.enforcement === "strict") {
    throw new PmCliError(message, EXIT_CODE.USAGE);
  }
  return `workflow_transition_not_allowed: ${message}`;
}

interface ParsedDependencyUpdates {
  additions: Dependency[];
}

interface DependencyRemovalSelector {
  id: string;
  kind?: (typeof DEPENDENCY_KIND_VALUES)[number];
  source_kind?: string;
}

function parseDependencyCreatedAt(
  value: string | undefined,
  currentIso: string,
): string {
  if (!value || value.trim() === "" || value.trim().toLowerCase() === "now") {
    return currentIso;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(
      `Invalid dependency created_at timestamp "${value}"`,
      EXIT_CODE.USAGE,
    );
  }
  return new Date(parsed).toISOString();
}

function parseOptionalDependencyString(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Allowed CSV/markdown keys for the update `--dep` addition seed (GH-258). */
const DEP_ADDITION_KEYS = [
  "id",
  "kind",
  "type",
  "author",
  "created_at",
  "source_kind",
] as const;
/** Allowed CSV/markdown keys for the `--dep-remove` selector (GH-258). */
const DEP_REMOVE_KEYS = ["id", "kind", "type", "source_kind"] as const;

function looksLikeStructuredDependencyEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  if (
    /^(?:[-*+]\s+)?(?:id|kind|type|author|created_at|source_kind)\s*[:=]/i.test(
      raw,
    )
  ) {
    return true;
  }
  // A first-key typo (e.g. `bogus=v,id=pm-2`) must still be parsed so the unknown
  // key is rejected rather than swallowed as a bare item id (GH-258).
  return looksLikeGenericKeyValueEntry(raw);
}

// pm-fl0c #4 (2026-05-28): `pm plan` accepts `depends_on` as a link kind
// (`PLAN_STEP_LINK_KIND_VALUES`) but `pm update --dep kind=depends_on` rejected
// it because `DEPENDENCY_KIND_VALUES` only lists `blocked_by`. The two terms
// are semantically identical from this side ("X depends on Y" === "X blocked
// by Y"), so we normalize input here rather than expanding the persisted enum
// — the stored kind stays canonical (`blocked_by`) and downstream consumers
// (closing logic, dependency graphs, blockers views) keep working unchanged.
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
  const trimmed = raw.trim();
  const alias = DEPENDENCY_KIND_INPUT_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

function parseDependencyAdditions(
  raw: string[] | undefined,
  prefix: string,
  nowIso: string,
): ParsedDependencyUpdates {
  if (!raw) {
    return { additions: [] };
  }
  assertNoLegacyNoneTokens(
    raw,
    "--dep",
    "Use --clear-deps to clear dependencies.",
  );
  const additions: Dependency[] = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const isStructured = looksLikeStructuredDependencyEntry(trimmedEntry);
    assertValidBareDependencyFlagValue(trimmedEntry, isStructured);
    const kv = isStructured
      ? parseCsvKv(entry, "--dep")
      : { id: trimmedEntry, kind: "related" };
    if (isStructured) {
      assertNoUnknownCsvKeys(kv, "--dep", DEP_ADDITION_KEYS);
    }
    const id = kv.id?.trim();
    const kind = normalizeDependencyKindInput((kv.kind ?? kv.type)?.trim());
    if (!id || !kind) {
      throw new PmCliError(
        "--dep requires id and kind, or a bare item id to add a related dependency",
        EXIT_CODE.USAGE,
      );
    }
    if (id.toLowerCase() === "undefined") {
      throw new PmCliError(
        `--dep id must not use placeholder token "${id}". Use --clear-deps to clear dependencies.`,
        EXIT_CODE.USAGE,
      );
    }
    const sourceKind = parseOptionalDependencyString(kv.source_kind);
    return {
      id: normalizeItemId(id, prefix),
      kind: ensureEnum(kind, DEPENDENCY_KIND_VALUES, "dependency kind"),
      created_at: parseDependencyCreatedAt(kv.created_at, nowIso),
      author: parseOptionalDependencyString(kv.author),
      source_kind: sourceKind,
    };
  });
  return { additions };
}

function parseDependencyRemovals(
  raw: string[] | undefined,
  prefix: string,
): DependencyRemovalSelector[] {
  if (!raw) {
    return [];
  }
  assertNoLegacyNoneTokens(raw, "--dep-remove");
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError(
        "--dep-remove requires id or key/value selectors",
        EXIT_CODE.USAGE,
      );
    }
    if (
      trimmed.includes("=") ||
      /^(?:[-*+]\s+)?(?:id|kind|type|source_kind)\s*[:=]/i.test(trimmed) ||
      trimmed.startsWith("```")
    ) {
      const kv = parseCsvKv(trimmed, "--dep-remove");
      assertNoUnknownCsvKeys(kv, "--dep-remove", DEP_REMOVE_KEYS);
      const idRaw = kv.id?.trim();
      if (!idRaw) {
        throw new PmCliError(
          "--dep-remove key/value form requires id=<value>",
          EXIT_CODE.USAGE,
        );
      }
      if (idRaw.toLowerCase() === "undefined") {
        throw new PmCliError(
          `--dep-remove id must not use placeholder token "${idRaw}"`,
          EXIT_CODE.USAGE,
        );
      }
      const kindRaw = normalizeDependencyKindInput(
        parseOptionalDependencyString(kv.kind ?? kv.type),
      );
      const sourceKind = parseOptionalDependencyString(kv.source_kind);
      return {
        id: normalizeItemId(idRaw, prefix),
        kind: kindRaw
          ? ensureEnum(kindRaw, DEPENDENCY_KIND_VALUES, "dependency kind")
          : undefined,
        source_kind: sourceKind,
      };
    }
    if (trimmed.toLowerCase() === "undefined") {
      throw new PmCliError(
        `--dep-remove id must not use placeholder token "${trimmed}"`,
        EXIT_CODE.USAGE,
      );
    }
    return {
      id: normalizeItemId(trimmed, prefix),
    };
  });
}

function dependencyKey(
  value: Pick<Dependency, "id" | "kind" | "source_kind">,
): string {
  return `${value.id}::${value.kind}::${value.source_kind ?? ""}`;
}

// pm-kyd6: `--blocked-by` writes the `blocked_by` scalar, but the dependency
// graph (`pm deps`) is built only from the `dependencies` array. Mirror the
// behaviour create.ts already has so the metadata and the graph agree: a
// resolvable blocker also gets a `blocked_by` dependency edge. Repeated
// `--blocked-by` updates preserve prior blocker edges because the graph is the
// full dependency record; the scalar remains the latest primary blocker for
// backward compatibility. Clearing the scalar removes all derived blocker edges.
function reconcileBlockedByDependency(
  current: Dependency[] | undefined,
  nextBlockedById: string | undefined,
  nowIsoValue: string,
  author: string,
): { dependencies: Dependency[] | undefined; changed: boolean } {
  let next = [...(current ?? [])];
  let changed = false;
  if (nextBlockedById === undefined) {
    const filtered = next.filter((dep) => dep.kind !== "blocked_by");
    if (filtered.length !== next.length) {
      next = filtered;
      changed = true;
    }
    if (!changed) {
      return { dependencies: current, changed: false };
    }
    return { dependencies: next.length > 0 ? next : undefined, changed: true };
  }
  if (
    !next.some((dep) => dep.kind === "blocked_by" && dep.id === nextBlockedById)
  ) {
    next.push({
      id: nextBlockedById,
      kind: "blocked_by",
      created_at: nowIsoValue,
      author,
    });
    changed = true;
  }
  if (!changed) {
    return { dependencies: current, changed: false };
  }
  return { dependencies: next.length > 0 ? next : undefined, changed: true };
}

// pm-kyd6: resolve the --blocked-by target before the synchronous mutate
// callback so a real blocker can also become a `blocked_by` dependency edge.
// `id` is set when the target resolves; `unresolved` carries the raw value when
// --blocked-by points at an item that does not exist (the scalar is still set,
// mirroring create.ts and the never-block missing-parent behaviour, but the
// caller surfaces a warning so the metadata/graph mismatch is visible).
async function resolveBlockedByDependencyTarget(
  blockedByOption: string | undefined,
  blockedByCleared: boolean,
  pmRoot: string,
  idPrefix: string,
  itemFormat: ItemFormat,
  typeToFolder: Record<string, string>,
): Promise<{ id?: string; unresolved?: string }> {
  if (blockedByOption === undefined || blockedByCleared) {
    return {};
  }
  const blockedByValue = blockedByOption.trim();
  if (blockedByValue.length === 0) {
    return {};
  }
  const located = await locateItem(
    pmRoot,
    normalizeItemId(blockedByValue, idPrefix),
    idPrefix,
    itemFormat,
    typeToFolder,
  );
  return located ? { id: located.id } : { unresolved: blockedByValue };
}

// pm-kyd6: apply the reconciled blocked_by dependency edge to the item metadata
// and record the `dependencies` change. Kept out of the mutate callback so the
// large runUpdate function stays under the static-quality complexity budget.
function applyBlockedByDependencyEdge(
  metadata: ItemFrontMatter,
  resolvedBlockedById: string | undefined,
  nowIsoValue: string,
  author: string,
  changedFields: string[],
): void {
  const reconciled = reconcileBlockedByDependency(
    metadata.dependencies,
    resolvedBlockedById,
    nowIsoValue,
    author,
  );
  if (!reconciled.changed) {
    return;
  }
  if (reconciled.dependencies === undefined) {
    delete metadata.dependencies;
  } else {
    metadata.dependencies = reconciled.dependencies;
  }
  if (!changedFields.includes("dependencies")) {
    changedFields.push("dependencies");
  }
}

function fileKey(value: Pick<LinkedFile, "path" | "scope">): string {
  return `${value.path}::${value.scope}`;
}

function docKey(value: Pick<LinkedDoc, "path" | "scope">): string {
  return `${value.path}::${value.scope}`;
}

function testKey(
  value: Pick<LinkedTest, "command" | "path" | "scope" | "pm_context_mode">,
): string {
  return `${value.command}::${value.path ?? ""}::${value.scope}::${value.pm_context_mode ?? ""}`;
}

function matchesDependencySelector(
  value: Dependency,
  selector: DependencyRemovalSelector,
): boolean {
  if (value.id !== selector.id) {
    return false;
  }
  if (selector.kind && value.kind !== selector.kind) {
    return false;
  }
  if (
    selector.source_kind !== undefined &&
    (value.source_kind ?? undefined) !== selector.source_kind
  ) {
    return false;
  }
  return true;
}

function ensurePriority(raw: string | number): 0 | 1 | 2 | 3 | 4 {
  return resolvePriority(raw);
}

function normalizeUpdatePolicyOptionKey(raw: string, typeName: string): string {
  const canonical = canonicalizeCommandOptionKey("update", raw);
  if (!canonical) {
    throw new PmCliError(
      `Unsupported command_option_policies option "${raw}" for update command on type "${typeName}"`,
      EXIT_CODE.CONFLICT,
    );
  }
  return canonical;
}

function collectProvidedUpdatePolicyOptions(
  options: UpdateCommandOptions,
  runtimeFieldRegistry: RuntimeFieldRegistry,
  extensionFieldNames: readonly string[],
): Set<string> {
  const provided = new Set<string>();
  const mark = (optionKey: string, isProvided: boolean): void => {
    if (isProvided) {
      provided.add(optionKey);
    }
  };
  mark("title", options.title !== undefined);
  mark("description", options.description !== undefined);
  mark("body", options.body !== undefined);
  mark("status", options.status !== undefined);
  mark("closeReason", options.closeReason !== undefined);
  mark("priority", options.priority !== undefined);
  mark("type", options.type !== undefined);
  // `--add-tags` / `--remove-tags` mutate the same `tags` field as `--tags`, so
  // they count toward the `tags` command_option_policy (disabled + required).
  mark(
    "tags",
    options.tags !== undefined ||
      (Array.isArray(options.addTags) && options.addTags.length > 0) ||
      (Array.isArray(options.removeTags) && options.removeTags.length > 0),
  );
  mark("deadline", options.deadline !== undefined);
  mark("estimatedMinutes", options.estimatedMinutes !== undefined);
  mark("acceptanceCriteria", options.acceptanceCriteria !== undefined);
  mark("definitionOfReady", options.definitionOfReady !== undefined);
  mark("order", options.order !== undefined || options.rank !== undefined);
  mark("goal", options.goal !== undefined);
  mark("objective", options.objective !== undefined);
  mark("value", options.value !== undefined);
  mark("impact", options.impact !== undefined);
  mark("outcome", options.outcome !== undefined);
  mark("whyNow", options.whyNow !== undefined);
  mark("author", options.author !== undefined);
  mark("message", options.message !== undefined);
  mark("assignee", options.assignee !== undefined);
  mark("parent", options.parent !== undefined);
  mark("reviewer", options.reviewer !== undefined);
  mark("risk", options.risk !== undefined);
  mark("confidence", options.confidence !== undefined);
  mark("sprint", options.sprint !== undefined);
  mark("release", options.release !== undefined);
  mark("blockedBy", options.blockedBy !== undefined);
  mark("blockedReason", options.blockedReason !== undefined);
  mark("unblockNote", options.unblockNote !== undefined);
  mark("reporter", options.reporter !== undefined);
  mark("severity", options.severity !== undefined);
  mark("environment", options.environment !== undefined);
  mark("reproSteps", options.reproSteps !== undefined);
  mark("resolution", options.resolution !== undefined);
  mark("expectedResult", options.expectedResult !== undefined);
  mark("actualResult", options.actualResult !== undefined);
  mark("affectedVersion", options.affectedVersion !== undefined);
  mark("fixedVersion", options.fixedVersion !== undefined);
  mark("component", options.component !== undefined);
  mark("regression", options.regression !== undefined);
  mark("customerImpact", options.customerImpact !== undefined);
  mark("dep", options.dep !== undefined);
  mark("depRemove", options.depRemove !== undefined);
  mark("dep", options.replaceDeps === true);
  mark("comment", options.comment !== undefined);
  mark("note", options.note !== undefined);
  mark("learning", options.learning !== undefined);
  mark("file", options.file !== undefined);
  mark("test", options.test !== undefined);
  mark("test", options.replaceTests === true);
  mark("doc", options.doc !== undefined);
  mark("reminder", options.reminder !== undefined);
  mark("event", options.event !== undefined);
  mark("typeOption", options.typeOption !== undefined);
  mark("field", options.field !== undefined);
  mark("force", options.force === true);
  mark("allowAuditUpdate", options.allowAuditUpdate === true);
  mark("dep", options.clearDeps === true);
  mark("comment", options.clearComments === true);
  mark("note", options.clearNotes === true);
  mark("learning", options.clearLearnings === true);
  mark("file", options.clearFiles === true);
  mark("test", options.clearTests === true);
  mark("doc", options.clearDocs === true);
  mark("reminder", options.clearReminders === true);
  mark("event", options.clearEvents === true);
  mark("typeOption", options.clearTypeOptions === true);
  if (options.unset && options.unset.length > 0) {
    const unsetTargets = parseUpdateUnsetTargets(
      options.unset,
      runtimeFieldRegistry,
      extensionFieldNames,
    );
    for (const optionKey of unsetTargets.optionKeys) {
      mark(optionKey, true);
    }
  }
  return provided;
}

function enforceUpdateOptionsByType(
  typeName: string,
  options: UpdateCommandOptions,
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>,
  runtimeFieldRegistry: RuntimeFieldRegistry,
  extensionFieldNames: readonly string[],
): void {
  const typeDefinition = resolveTypeDefinition(typeName, typeRegistry);
  if (!typeDefinition) {
    throw new PmCliError(`Invalid type value "${typeName}"`, EXIT_CODE.USAGE);
  }
  const policyState = resolveCommandOptionPolicyState(
    typeDefinition,
    "update",
    [],
  );
  if (policyState.errors.length > 0) {
    throw new PmCliError(policyState.errors.join("; "), EXIT_CODE.CONFLICT);
  }

  const provided = collectProvidedUpdatePolicyOptions(
    options,
    runtimeFieldRegistry,
    extensionFieldNames,
  );
  for (const disabled of policyState.disabled) {
    if (provided.has(normalizeUpdatePolicyOptionKey(disabled, typeName))) {
      throw new PmCliError(
        `Option ${commandOptionFlagLabel("update", disabled)} is disabled for type "${typeName}" by command_option_policies`,
        EXIT_CODE.USAGE,
      );
    }
  }

  for (const required of policyState.required) {
    if (!provided.has(normalizeUpdatePolicyOptionKey(required, typeName))) {
      throw new PmCliError(
        `Missing required option ${commandOptionFlagLabel("update", required)} for type "${typeName}"`,
        EXIT_CODE.USAGE,
      );
    }
  }
}

interface UpdateScalarMutationContext {
  metadataRecord: Record<string, unknown>;
  clearFrontMatterKeys: ReadonlySet<string>;
  changedFields: string[];
  nowValue: Date;
}

interface UpdateScalarMutationDefinition {
  optionKey: keyof UpdateCommandOptions;
  metadataKey: string;
  transform?: (value: string, context: UpdateScalarMutationContext) => unknown;
}

interface UpdateClearCollectionDefinition {
  enabled: boolean | undefined;
  optionKey: string;
  clearFlag: string;
  valueFlag: string;
  values: string[] | undefined;
  frontMatterKey: string;
}

interface UpdateMutationContext {
  options: UpdateCommandOptions;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  statusRegistry: RuntimeStatusRegistry;
  runtimeFieldRegistry: RuntimeFieldRegistry;
  extensionRegistrations: ReturnType<typeof getActiveExtensionRegistrations>;
  extensionFieldNames: readonly string[];
  clearFrontMatterKeys: ReadonlySet<string>;
  dependencyUpdates: ParsedDependencyUpdates;
  dependencyRemovals: DependencyRemovalSelector[];
  commentUpdates: ReturnType<typeof parseLogSeed>;
  noteUpdates: ReturnType<typeof parseLogSeed>;
  learningUpdates: ReturnType<typeof parseLogSeed>;
  fileUpdates: ReturnType<typeof parseFiles>;
  testUpdates: ReturnType<typeof parseTests>;
  docUpdates: ReturnType<typeof parseDocs>;
  resolvedParentValue: string | undefined;
  resolvedBlockedByDependencyId: string | undefined;
  runtimeFieldUpdates: Record<string, unknown>;
  nowValue: Date;
  nowIso: string;
  author: string;
  pmRoot: string;
}

interface CloseRouteContext {
  options: UpdateCommandOptions;
  fieldFlags: Record<string, boolean>;
  statusRegistry: RuntimeStatusRegistry;
  workflowTransitionWarnings: readonly string[];
  global: GlobalOptions;
  id: string;
}

// `rank` is a legacy alias for `order`; keep it out of the scalar loop if the
// shared mutation key list ever grows to include that alias.
const UPDATE_LEGACY_COMMON_SCALAR_OPTION_EXCLUSIONS = new Set<string>([
  "order",
  "rank",
]);
const UPDATE_LEGACY_COMMON_SCALAR_OPTION_KEYS =
  COMMON_MUTATION_COMMAND_OPTION_KEYS.filter(
    (key) => !UPDATE_LEGACY_COMMON_SCALAR_OPTION_EXCLUSIONS.has(key),
  ) as readonly (keyof UpdateCommandOptions)[];

const UPDATE_LEGACY_SCALAR_OPTION_KEYS: readonly (keyof UpdateCommandOptions)[] =
  ["tags", "closeReason", ...UPDATE_LEGACY_COMMON_SCALAR_OPTION_KEYS];

const UPDATE_SIMPLE_FIELD_FLAG_KEYS: readonly (keyof UpdateCommandOptions)[] = [
  "title",
  "description",
  "body",
  "status",
  "closeReason",
  "priority",
  "type",
  ...COMMON_MUTATION_COMMAND_OPTION_KEYS,
  "dep",
  "depRemove",
  "comment",
  "note",
  "learning",
  "file",
  "test",
  "doc",
  "reminder",
  "event",
  "typeOption",
  "field",
];

const UPDATE_POST_TAG_SCALAR_MUTATIONS: ReadonlyArray<UpdateScalarMutationDefinition> =
  [
    {
      optionKey: "deadline",
      metadataKey: "deadline",
      transform: (value, context) =>
        resolveIsoOrRelative(value, context.nowValue, "deadline"),
    },
    {
      optionKey: "estimatedMinutes",
      metadataKey: "estimated_minutes",
      transform: (value) => parseOptionalNumber(value, "estimated-minutes"),
    },
    {
      optionKey: "acceptanceCriteria",
      metadataKey: "acceptance_criteria",
      transform: (value) => value,
    },
    { optionKey: "definitionOfReady", metadataKey: "definition_of_ready" },
    { optionKey: "goal", metadataKey: "goal" },
    { optionKey: "objective", metadataKey: "objective" },
    { optionKey: "value", metadataKey: "value" },
    { optionKey: "impact", metadataKey: "impact" },
    { optionKey: "outcome", metadataKey: "outcome" },
    { optionKey: "whyNow", metadataKey: "why_now" },
  ];

const UPDATE_STAKEHOLDER_SCALAR_MUTATIONS: ReadonlyArray<UpdateScalarMutationDefinition> =
  [
    { optionKey: "reviewer", metadataKey: "reviewer" },
    {
      optionKey: "risk",
      metadataKey: "risk",
      transform: (value) =>
        ensureEnum(normalizeRiskInput(value), RISK_VALUES, "risk"),
    },
    {
      optionKey: "confidence",
      metadataKey: "confidence",
      transform: (value) => parseConfidenceInput(value),
    },
  ];

const UPDATE_ISSUE_SCALAR_MUTATIONS: ReadonlyArray<UpdateScalarMutationDefinition> =
  [
    { optionKey: "blockedReason", metadataKey: "blocked_reason" },
    { optionKey: "unblockNote", metadataKey: "unblock_note" },
    { optionKey: "reporter", metadataKey: "reporter" },
    {
      optionKey: "severity",
      metadataKey: "severity",
      transform: (value) =>
        ensureEnum(
          normalizeSeverityInput(value),
          ISSUE_SEVERITY_VALUES,
          "severity",
        ),
    },
    { optionKey: "environment", metadataKey: "environment" },
    { optionKey: "reproSteps", metadataKey: "repro_steps" },
    { optionKey: "resolution", metadataKey: "resolution" },
    { optionKey: "expectedResult", metadataKey: "expected_result" },
    { optionKey: "actualResult", metadataKey: "actual_result" },
    { optionKey: "affectedVersion", metadataKey: "affected_version" },
    { optionKey: "fixedVersion", metadataKey: "fixed_version" },
    { optionKey: "component", metadataKey: "component" },
    {
      optionKey: "regression",
      metadataKey: "regression",
      transform: (value) => parseRegressionInput(value),
    },
    { optionKey: "customerImpact", metadataKey: "customer_impact" },
  ];

function applyUpdateScalarMutations(
  definitions: ReadonlyArray<UpdateScalarMutationDefinition>,
  options: UpdateCommandOptions,
  context: UpdateScalarMutationContext,
): void {
  for (const definition of definitions) {
    const optionValue = options[definition.optionKey];
    const shouldClear = context.clearFrontMatterKeys.has(
      definition.metadataKey,
    );
    if (optionValue === undefined && !shouldClear) {
      continue;
    }
    if (shouldClear) {
      delete context.metadataRecord[definition.metadataKey];
      context.changedFields.push(definition.metadataKey);
      continue;
    }
    if (typeof optionValue !== "string") {
      throw new PmCliError(
        `${commandOptionFlagLabel("update", String(definition.optionKey))} must be a string value`,
        EXIT_CODE.USAGE,
      );
    }
    context.metadataRecord[definition.metadataKey] = definition.transform
      ? definition.transform(optionValue, context)
      : optionValue.trim();
    context.changedFields.push(definition.metadataKey);
  }
}

async function resolveStdinUpdateOptions(
  options: UpdateCommandOptions,
): Promise<UpdateCommandOptions> {
  const stdinResolver = createStdinTokenResolver();
  return normalizeLegacyNoneUpdateOptions({
    ...options,
    body: await stdinResolver.resolveValue(options.body, "--body"),
    dep: await stdinResolver.resolveList(options.dep, "--dep"),
    depRemove: await stdinResolver.resolveList(
      options.depRemove,
      "--dep-remove",
    ),
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
  });
}

function buildClearCollectionDefinitions(
  options: UpdateCommandOptions,
): readonly UpdateClearCollectionDefinition[] {
  return [
    {
      enabled: options.clearDeps || options.replaceDeps,
      optionKey: "dep",
      clearFlag: "--clear-deps",
      valueFlag: "--dep",
      values: options.dep,
      frontMatterKey: "dependencies",
    },
    {
      enabled: options.clearComments,
      optionKey: "comment",
      clearFlag: "--clear-comments",
      valueFlag: "--comment",
      values: options.comment,
      frontMatterKey: "comments",
    },
    {
      enabled: options.clearNotes,
      optionKey: "note",
      clearFlag: "--clear-notes",
      valueFlag: "--note",
      values: options.note,
      frontMatterKey: "notes",
    },
    {
      enabled: options.clearLearnings,
      optionKey: "learning",
      clearFlag: "--clear-learnings",
      valueFlag: "--learning",
      values: options.learning,
      frontMatterKey: "learnings",
    },
    {
      enabled: options.clearFiles,
      optionKey: "file",
      clearFlag: "--clear-files",
      valueFlag: "--file",
      values: options.file,
      frontMatterKey: "files",
    },
    {
      enabled: options.clearTests || options.replaceTests,
      optionKey: "test",
      clearFlag: "--clear-tests",
      valueFlag: "--test",
      values: options.test,
      frontMatterKey: "tests",
    },
    {
      enabled: options.clearDocs,
      optionKey: "doc",
      clearFlag: "--clear-docs",
      valueFlag: "--doc",
      values: options.doc,
      frontMatterKey: "docs",
    },
    {
      enabled: options.clearReminders,
      optionKey: "reminder",
      clearFlag: "--clear-reminders",
      valueFlag: "--reminder",
      values: options.reminder,
      frontMatterKey: "reminders",
    },
    {
      enabled: options.clearEvents,
      optionKey: "event",
      clearFlag: "--clear-events",
      valueFlag: "--event",
      values: options.event,
      frontMatterKey: "events",
    },
    {
      enabled: options.clearTypeOptions,
      optionKey: "typeOption",
      clearFlag: "--clear-type-options",
      valueFlag: "--type-option",
      values: options.typeOption,
      frontMatterKey: "type_options",
    },
  ];
}

function validateReplaceOptions(options: UpdateCommandOptions): void {
  if (
    options.replaceDeps === true &&
    (options.dep === undefined || options.dep.length === 0)
  ) {
    throw new PmCliError(
      "--replace-deps requires at least one --dep entry",
      EXIT_CODE.USAGE,
    );
  }
  if (
    options.replaceDeps === true &&
    options.depRemove !== undefined &&
    options.depRemove.length > 0
  ) {
    throw new PmCliError(
      "--replace-deps cannot be combined with --dep-remove",
      EXIT_CODE.USAGE,
    );
  }
  if (
    options.replaceTests === true &&
    (options.test === undefined || options.test.length === 0)
  ) {
    throw new PmCliError(
      "--replace-tests requires at least one --test entry",
      EXIT_CODE.USAGE,
    );
  }
  if (options.replaceTests === true && options.clearTests === true) {
    throw new PmCliError(
      "--replace-tests cannot be combined with --clear-tests",
      EXIT_CODE.USAGE,
    );
  }
}

function applyClearCollectionDefinitions(params: {
  definitions: readonly UpdateClearCollectionDefinition[];
  options: UpdateCommandOptions;
  clearOptionKeys: Set<string>;
  clearFrontMatterKeys: Set<string>;
}): void {
  for (const definition of params.definitions) {
    if (!definition.enabled) {
      continue;
    }
    const isReplacement =
      (definition.optionKey === "dep" && params.options.replaceDeps === true) ||
      (definition.optionKey === "test" && params.options.replaceTests === true);
    if (definition.values && definition.values.length > 0 && !isReplacement) {
      throw new PmCliError(
        `Cannot combine ${definition.clearFlag} with ${definition.valueFlag}`,
        EXIT_CODE.USAGE,
      );
    }
    params.clearOptionKeys.add(definition.optionKey);
    params.clearFrontMatterKeys.add(definition.frontMatterKey);
  }
}

function buildScalarOptionPresence(
  options: UpdateCommandOptions,
): Record<string, boolean> {
  const presence: Record<string, boolean> = {};
  for (const key of UPDATE_LEGACY_SCALAR_OPTION_KEYS) {
    presence[String(key)] = options[key] !== undefined;
  }
  presence.order = options.order !== undefined || options.rank !== undefined;
  return presence;
}

function rejectUnsetScalarConflicts(
  options: UpdateCommandOptions,
  unsetTargets: { optionKeys: Set<string>; frontMatterKeys: Set<string> },
): void {
  const scalarOptionPresence = buildScalarOptionPresence(options);
  for (const [optionKey, hasValue] of Object.entries(scalarOptionPresence)) {
    if (!hasValue || !unsetTargets.optionKeys.has(optionKey)) {
      continue;
    }
    const unsetField =
      UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey;
    throw new PmCliError(
      `Cannot combine --unset ${unsetField} with ${commandOptionFlagLabel("update", optionKey)}`,
      EXIT_CODE.USAGE,
    );
  }
  if (!unsetTargets.frontMatterKeys.has("tags")) {
    return;
  }
  if (Array.isArray(options.addTags) && options.addTags.length > 0) {
    throw new PmCliError(
      "Cannot combine --unset tags with --add-tags",
      EXIT_CODE.USAGE,
    );
  }
  if (Array.isArray(options.removeTags) && options.removeTags.length > 0) {
    throw new PmCliError(
      "Cannot combine --unset tags with --remove-tags",
      EXIT_CODE.USAGE,
    );
  }
}

function rejectLegacyScalarTokens(options: UpdateCommandOptions): void {
  const assertNoLegacyScalarToken = (
    value: string | undefined,
    optionKey: string,
  ): void => {
    const unsetField = UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey);
    const hint = unsetField
      ? `Use --unset ${unsetField} to clear this field.`
      : undefined;
    assertNoLegacyNoneToken(
      value,
      commandOptionFlagLabel("update", optionKey),
      hint,
    );
  };
  for (const key of UPDATE_LEGACY_SCALAR_OPTION_KEYS) {
    assertNoLegacyScalarToken(options[key] as string | undefined, String(key));
  }
  assertNoLegacyScalarToken(options.order ?? options.rank, "order");
  assertNoLegacyNoneTokens(
    options.reminder,
    "--reminder",
    "Use --clear-reminders to clear reminders.",
  );
  assertNoLegacyNoneTokens(
    options.event,
    "--event",
    "Use --clear-events to clear linked events.",
  );
}

function buildUpdateFieldFlags(
  options: UpdateCommandOptions,
  runtimeFieldUpdates: Record<string, unknown>,
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const key of UPDATE_SIMPLE_FIELD_FLAG_KEYS) {
    flags[String(key)] = options[key] !== undefined;
  }
  flags.tags = options.tags !== undefined;
  flags.addTags = Array.isArray(options.addTags) && options.addTags.length > 0;
  flags.removeTags =
    Array.isArray(options.removeTags) && options.removeTags.length > 0;
  flags.order = options.order !== undefined;
  flags.rank = options.rank !== undefined;
  flags.replaceDeps = options.replaceDeps === true;
  flags.replaceTests = options.replaceTests === true;
  flags.unset = options.unset !== undefined && options.unset.length > 0;
  flags.clearDeps = options.clearDeps === true;
  flags.clearComments = options.clearComments === true;
  flags.clearNotes = options.clearNotes === true;
  flags.clearLearnings = options.clearLearnings === true;
  flags.clearFiles = options.clearFiles === true;
  flags.clearTests = options.clearTests === true;
  flags.clearDocs = options.clearDocs === true;
  flags.clearReminders = options.clearReminders === true;
  flags.clearEvents = options.clearEvents === true;
  flags.clearTypeOptions = options.clearTypeOptions === true;
  flags.runtimeFields = Object.keys(runtimeFieldUpdates).length > 0;
  return flags;
}

async function buildNoopUpdateResult(params: {
  pmRoot: string;
  id: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
}): Promise<UpdateResult> {
  const located = await locateItem(
    params.pmRoot,
    params.id,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeRegistry.type_to_folder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      params.pmRoot,
      params.id,
      params.settings.id_prefix,
      params.typeRegistry.type_to_folder,
    );
  }
  const { document } = await readLocatedItem(located, {
    schema: params.settings.schema,
  });
  return {
    item: toItemRecord(document.metadata),
    changed_fields: [],
    warnings: ["noop_no_update_fields"],
  };
}

async function assertUpdateTrackerInitialized(pmRoot: string): Promise<void> {
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
}

function assertMatchingOrderRank(options: UpdateCommandOptions): void {
  if (
    options.order !== undefined &&
    options.rank !== undefined &&
    options.order !== options.rank
  ) {
    throw new PmCliError(
      "--order and --rank must match when both are provided",
      EXIT_CODE.USAGE,
    );
  }
}

async function resolveParentReferenceForUpdate(params: {
  id: string;
  options: UpdateCommandOptions;
  unsetTargets: { frontMatterKeys: Set<string> };
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  parentReferencePolicy: Awaited<
    ReturnType<typeof readSettings>
  >["validation"]["parent_reference"];
}): Promise<{ resolvedParentValue: string | undefined; warnings: string[] }> {
  if (
    params.options.parent === undefined ||
    params.unsetTargets.frontMatterKeys.has("parent")
  ) {
    return { resolvedParentValue: undefined, warnings: [] };
  }
  const resolvedParentValue = normalizeParentReferenceValue(
    params.options.parent,
  );
  assertParentReferenceIsNotSelf(
    params.id,
    resolvedParentValue,
    params.settings.id_prefix,
  );
  const parentLocated = await locateItem(
    params.pmRoot,
    resolvedParentValue,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeRegistry.type_to_folder,
  );
  if (parentLocated) {
    return { resolvedParentValue, warnings: [] };
  }
  const normalizedParentId = normalizeItemId(
    resolvedParentValue,
    params.settings.id_prefix,
  );
  return {
    resolvedParentValue,
    warnings: validateMissingParentReference(
      normalizedParentId,
      params.parentReferencePolicy,
    ).warnings,
  };
}

function blockedByResolutionWarnings(resolution: {
  unresolved?: string;
}): string[] {
  return resolution.unresolved === undefined
    ? []
    : [`blocked_by_unresolved:${resolution.unresolved}`];
}

async function collectWorkflowTransitionWarnings(params: {
  options: UpdateCommandOptions;
  fieldFlags: Record<string, boolean>;
  workflowEnforcement: GovernanceWorkflowEnforcement;
  typeWorkflows: NormalizedTypeWorkflow[];
  statusRegistry: RuntimeStatusRegistry;
  typeRegistry: ReturnType<typeof resolveItemTypeRegistry>;
  pmRoot: string;
  id: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
}): Promise<string[]> {
  if (
    params.workflowEnforcement === "off" ||
    params.typeWorkflows.length === 0 ||
    !params.fieldFlags.status ||
    params.options.status === undefined
  ) {
    return [];
  }
  const located = await locateItem(
    params.pmRoot,
    params.id,
    params.settings.id_prefix,
    params.settings.item_format,
    params.typeRegistry.type_to_folder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      params.pmRoot,
      params.id,
      params.settings.id_prefix,
      params.typeRegistry.type_to_folder,
    );
  }
  const { document } = await readLocatedItem(located, {
    schema: params.settings.schema,
  });
  const effectiveType =
    params.options.type !== undefined
      ? (resolveTypeName(params.options.type, params.typeRegistry) ??
        params.options.type)
      : (document.metadata?.type ?? "");
  const warning = enforceTypeWorkflowTransition({
    enforcement: params.workflowEnforcement,
    typeWorkflows: params.typeWorkflows,
    statusRegistry: params.statusRegistry,
    typeName: effectiveType,
    fromStatus: document.metadata?.status ?? "",
    toStatus: params.options.status,
  });
  return warning ? [warning] : [];
}

async function routeCloseStatusUpdate(
  context: CloseRouteContext,
): Promise<UpdateResult | undefined> {
  if (!context.fieldFlags.status) {
    return undefined;
  }
  const targetStatus = normalizeStatusInput(
    context.options.status as ItemStatus,
    context.statusRegistry,
  );
  if (targetStatus !== context.statusRegistry.close_status) {
    return undefined;
  }

  const otherFieldKeys = Object.entries(context.fieldFlags)
    .filter(
      ([key, value]) => value && key !== "status" && key !== "closeReason",
    )
    .map(([key]) => key);
  const routeWarnings: string[] = [];
  let preChangedFields: string[] = [];
  if (otherFieldKeys.length > 0) {
    const preUpdate = await runUpdate(
      context.id,
      {
        ...context.options,
        status: undefined,
        closeReason: undefined,
        message: undefined,
      },
      context.global,
    );
    preChangedFields = preUpdate.changed_fields;
    routeWarnings.push(...preUpdate.warnings);
  }

  const explicitReason =
    typeof context.options.closeReason === "string"
      ? context.options.closeReason.trim()
      : "";
  const fallbackMessage =
    typeof context.options.message === "string"
      ? context.options.message.trim()
      : "";
  const closeReason =
    explicitReason || fallbackMessage || "Closed via pm update";
  const closeResult = await runClose(
    context.id,
    closeReason,
    {
      author: context.options.author,
      message: context.options.message,
      force: context.options.force,
    },
    context.global,
  );

  const warnings = [
    ...context.workflowTransitionWarnings,
    ...routeWarnings,
    ...closeResult.warnings,
    "auto_routed_from_update_to_close",
  ];
  if (explicitReason.length === 0 && fallbackMessage.length === 0) {
    warnings.push("close_reason_defaulted");
  }
  return {
    item: closeResult.item,
    changed_fields: [...preChangedFields, ...closeResult.changed_fields],
    warnings,
  };
}

function applySimpleItemMutations(
  document: ItemDocument,
  options: UpdateCommandOptions,
  statusRegistry: RuntimeStatusRegistry,
  changedFields: string[],
): string {
  if (options.title !== undefined) {
    document.metadata.title = options.title;
    changedFields.push("title");
  }
  if (options.description !== undefined) {
    document.metadata.description = options.description;
    changedFields.push("description");
  }
  if (options.body !== undefined) {
    document.body = options.body;
    changedFields.push("body");
  }
  return (
    normalizeStatusInput(document.metadata.status, statusRegistry) ??
    document.metadata.status
  );
}

function hasClosedAt(metadata: ItemDocument["metadata"]): boolean {
  return metadata.closed_at !== undefined && metadata.closed_at !== null;
}

function hasClosedAtProperty(metadata: ItemDocument["metadata"]): boolean {
  return metadata.closed_at !== undefined;
}

function applyStatusAndCloseReasonMutations(
  document: ItemDocument,
  context: Pick<
    UpdateMutationContext,
    "options" | "statusRegistry" | "clearFrontMatterKeys" | "nowIso"
  >,
  previousStatusNormalized: string,
  changedFields: string[],
): void {
  if (context.options.status !== undefined) {
    const status = parseStatus(context.options.status, context.statusRegistry);
    document.metadata.status = status;
    changedFields.push("status");
    if (
      status === context.statusRegistry.close_status &&
      !hasClosedAt(document.metadata)
    ) {
      document.metadata.closed_at = context.nowIso;
      changedFields.push("closed_at");
    } else if (
      previousStatusNormalized === context.statusRegistry.close_status &&
      status !== context.statusRegistry.close_status &&
      hasClosedAtProperty(document.metadata)
    ) {
      delete document.metadata.closed_at;
      changedFields.push("closed_at");
    }
  }
  if (
    context.options.closeReason !== undefined ||
    context.clearFrontMatterKeys.has("close_reason")
  ) {
    if (context.clearFrontMatterKeys.has("close_reason")) {
      delete document.metadata.close_reason;
    } else {
      const closeReason = context.options.closeReason?.trim() ?? "";
      if (closeReason.length === 0) {
        throw new PmCliError(
          "--close-reason must not be empty",
          EXIT_CODE.USAGE,
        );
      }
      document.metadata.close_reason = closeReason;
    }
    changedFields.push("close_reason");
    return;
  }
  if (
    context.options.status !== undefined &&
    previousStatusNormalized === context.statusRegistry.close_status &&
    document.metadata.status !== context.statusRegistry.canceled_status &&
    document.metadata.close_reason !== undefined
  ) {
    delete document.metadata.close_reason;
    changedFields.push("close_reason");
  }
}

function applyPriorityTypeAndOptions(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): string {
  let activeTypeName =
    resolveTypeName(document.metadata.type, context.typeRegistry) ??
    document.metadata.type;
  if (context.options.priority !== undefined) {
    document.metadata.priority = ensurePriority(context.options.priority);
    changedFields.push("priority");
  }
  if (context.options.type !== undefined) {
    const resolvedTypeName = resolveTypeName(
      context.options.type,
      context.typeRegistry,
    );
    if (!resolvedTypeName) {
      throw new PmCliError(
        buildInvalidTypeError(
          context.options.type,
          context.typeRegistry.types,
          resolveItemTypesFilePath(context.pmRoot, context.settings.schema),
        ),
        EXIT_CODE.USAGE,
      );
    }
    document.metadata.type = resolvedTypeName;
    activeTypeName = resolvedTypeName;
    changedFields.push("type");
  }
  enforceUpdateOptionsByType(
    activeTypeName,
    context.options,
    context.typeRegistry,
    context.runtimeFieldRegistry,
    context.extensionFieldNames,
  );
  applyTypeOptionMutation(document, context, activeTypeName, changedFields);
  return activeTypeName;
}

function applyTypeOptionMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  activeTypeName: string,
  changedFields: string[],
): void {
  if (
    context.options.typeOption !== undefined ||
    context.clearFrontMatterKeys.has("type_options")
  ) {
    if (context.clearFrontMatterKeys.has("type_options")) {
      delete document.metadata.type_options;
    } else {
      const parsedTypeOptions = parseTypeOptionEntries(
        context.options.typeOption ?? [],
      );
      const validation = validateTypeOptions(
        activeTypeName,
        parsedTypeOptions,
        context.typeRegistry,
      );
      if (validation.errors.length > 0) {
        throw new PmCliError(validation.errors.join("; "), EXIT_CODE.USAGE);
      }
      document.metadata.type_options = validation.normalized;
    }
    changedFields.push("type_options");
    return;
  }
  if (
    context.options.type === undefined ||
    document.metadata.type_options === undefined
  ) {
    return;
  }
  const validation = validateTypeOptions(
    activeTypeName,
    document.metadata.type_options,
    context.typeRegistry,
  );
  if (validation.errors.length > 0) {
    throw new PmCliError(
      `Current type options are incompatible with type "${activeTypeName}". ${validation.errors.join("; ")}. Use --clear-type-options to clear them.`,
      EXIT_CODE.USAGE,
    );
  }
  document.metadata.type_options = validation.normalized;
}

function applyDependencyMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.dep === undefined &&
    context.options.depRemove === undefined &&
    !context.clearFrontMatterKeys.has("dependencies")
  ) {
    return;
  }
  let nextDependencies = context.clearFrontMatterKeys.has("dependencies")
    ? []
    : [...(document.metadata.dependencies ?? [])];
  if (context.dependencyUpdates.additions.length > 0) {
    const seen = new Set(nextDependencies.map((entry) => dependencyKey(entry)));
    for (const addition of context.dependencyUpdates.additions) {
      const key = dependencyKey(addition);
      if (!seen.has(key)) {
        nextDependencies.push(addition);
        seen.add(key);
      }
    }
  }
  if (context.dependencyRemovals.length > 0) {
    nextDependencies = nextDependencies.filter(
      (entry) =>
        !context.dependencyRemovals.some((selector) =>
          matchesDependencySelector(entry, selector),
        ),
    );
  }
  if (nextDependencies.length === 0) {
    delete document.metadata.dependencies;
  } else {
    document.metadata.dependencies = nextDependencies;
  }
  changedFields.push("dependencies");
}

function applyLogCollectionMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  applyLogCollectionMutation(
    document,
    "comments",
    context.options.comment,
    context.commentUpdates.values as Comment[] | undefined,
    context.clearFrontMatterKeys,
    changedFields,
  );
  applyLogCollectionMutation(
    document,
    "notes",
    context.options.note,
    context.noteUpdates.values as LogNote[] | undefined,
    context.clearFrontMatterKeys,
    changedFields,
  );
  applyLogCollectionMutation(
    document,
    "learnings",
    context.options.learning,
    context.learningUpdates.values as LogNote[] | undefined,
    context.clearFrontMatterKeys,
    changedFields,
  );
}

function applyLogCollectionMutation(
  document: ItemDocument,
  key: "comments" | "notes" | "learnings",
  optionValue: string[] | undefined,
  values: Comment[] | LogNote[] | undefined,
  clearFrontMatterKeys: ReadonlySet<string>,
  changedFields: string[],
): void {
  if (optionValue === undefined && !clearFrontMatterKeys.has(key)) {
    return;
  }
  if (clearFrontMatterKeys.has(key) || !values || values.length === 0) {
    delete document.metadata[key];
  } else {
    document.metadata[key] = [
      ...(document.metadata[key] ?? []),
      ...values,
    ] as never;
  }
  changedFields.push(key);
}

function applyEvidenceCollectionMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  applyUniqueLinkedCollectionMutation(
    document,
    "files",
    context.options.file,
    context.fileUpdates.values,
    fileKey,
    context.clearFrontMatterKeys,
    changedFields,
  );
  applyTestCollectionMutation(document, context, changedFields);
  applyUniqueLinkedCollectionMutation(
    document,
    "docs",
    context.options.doc,
    context.docUpdates.values,
    docKey,
    context.clearFrontMatterKeys,
    changedFields,
  );
}

function applyUniqueLinkedCollectionMutation<T extends LinkedFile | LinkedDoc>(
  document: ItemDocument,
  key: "files" | "docs",
  optionValue: string[] | undefined,
  values: T[] | undefined,
  keyOf: (value: T) => string,
  clearFrontMatterKeys: ReadonlySet<string>,
  changedFields: string[],
): void {
  if (optionValue === undefined && !clearFrontMatterKeys.has(key)) {
    return;
  }
  if (clearFrontMatterKeys.has(key) || !values || values.length === 0) {
    delete document.metadata[key];
  } else {
    const next = [...((document.metadata[key] as T[] | undefined) ?? [])];
    const seen = new Set(next.map((entry) => keyOf(entry)));
    for (const entry of values) {
      const keyValue = keyOf(entry);
      if (!seen.has(keyValue)) {
        next.push(entry);
        seen.add(keyValue);
      }
    }
    document.metadata[key] = next as never;
  }
  changedFields.push(key);
}

function applyTestCollectionMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.test === undefined &&
    !context.clearFrontMatterKeys.has("tests")
  ) {
    return;
  }
  if (
    context.clearFrontMatterKeys.has("tests") &&
    context.options.replaceTests === true
  ) {
    document.metadata.tests =
      dedupeLinkedTests(context.testUpdates.values) ?? [];
  } else if (
    context.clearFrontMatterKeys.has("tests") ||
    !context.testUpdates.values ||
    context.testUpdates.values.length === 0
  ) {
    delete document.metadata.tests;
  } else {
    document.metadata.tests = dedupeLinkedTests([
      ...(document.metadata.tests ?? []),
      ...context.testUpdates.values,
    ]);
  }
  if (
    document.metadata.tests !== undefined &&
    document.metadata.tests.length === 0
  ) {
    delete document.metadata.tests;
  }
  changedFields.push("tests");
}

function dedupeLinkedTests(
  values: LinkedTest[] | undefined,
): LinkedTest[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const next: LinkedTest[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const key = testKey(entry);
    if (!seen.has(key)) {
      next.push(entry);
      seen.add(key);
    }
  }
  return next;
}

function applyTagsAndPlanningMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  scalarMutationContext: UpdateScalarMutationContext,
): void {
  const addTagsValues = context.options.addTags;
  const removeTagsValues = context.options.removeTags;
  const hasAdditiveTagMutation =
    (Array.isArray(addTagsValues) && addTagsValues.length > 0) ||
    (Array.isArray(removeTagsValues) && removeTagsValues.length > 0);
  if (
    context.options.tags !== undefined ||
    context.clearFrontMatterKeys.has("tags") ||
    hasAdditiveTagMutation
  ) {
    const baseTags = context.clearFrontMatterKeys.has("tags")
      ? []
      : context.options.tags !== undefined
        ? parseTags(context.options.tags)
        : Array.isArray(document.metadata.tags)
          ? [...(document.metadata.tags as string[])]
          : [];
    document.metadata.tags = applyTagRemovals(
      mergeAdditiveTags(baseTags, addTagsValues),
      removeTagsValues,
    );
    scalarMutationContext.changedFields.push("tags");
  }
  applyUpdateScalarMutations(
    UPDATE_POST_TAG_SCALAR_MUTATIONS,
    context.options,
    scalarMutationContext,
  );
  applyOrderMutation(document, context, scalarMutationContext.changedFields);
}

function applyOrderMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  const orderRaw = context.options.order ?? context.options.rank;
  if (orderRaw === undefined && !context.clearFrontMatterKeys.has("order")) {
    return;
  }
  if (context.clearFrontMatterKeys.has("order")) {
    delete document.metadata.order;
  } else {
    const parsedOrder = parseOptionalNumber(orderRaw ?? "", "order");
    if (!Number.isInteger(parsedOrder)) {
      throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
    }
    document.metadata.order = parsedOrder;
  }
  changedFields.push("order");
}

function applyOwnershipAndIssueMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  scalarMutationContext: UpdateScalarMutationContext,
  warnings: string[],
): void {
  applyAssigneeMutation(document, context, scalarMutationContext.changedFields);
  applyParentMutation(document, context, scalarMutationContext.changedFields);
  applyUpdateScalarMutations(
    UPDATE_STAKEHOLDER_SCALAR_MUTATIONS,
    context.options,
    scalarMutationContext,
  );
  applySprintReleaseMutation(
    document,
    context,
    "sprint",
    warnings,
    scalarMutationContext.changedFields,
  );
  applySprintReleaseMutation(
    document,
    context,
    "release",
    warnings,
    scalarMutationContext.changedFields,
  );
  applyBlockedByMutation(
    document,
    context,
    scalarMutationContext.changedFields,
  );
  applyUpdateScalarMutations(
    UPDATE_ISSUE_SCALAR_MUTATIONS,
    context.options,
    scalarMutationContext,
  );
}

function applyAssigneeMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.assignee === undefined &&
    !context.clearFrontMatterKeys.has("assignee")
  ) {
    return;
  }
  if (context.clearFrontMatterKeys.has("assignee")) {
    delete document.metadata.assignee;
  } else {
    const assignee = context.options.assignee?.trim() ?? "";
    if (assignee === "") {
      throw new PmCliError(
        "--assignee must not be empty. Use --unset assignee to clear it.",
        EXIT_CODE.USAGE,
      );
    }
    document.metadata.assignee = assignee;
  }
  changedFields.push("assignee");
}

function applyParentMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.parent === undefined &&
    !context.clearFrontMatterKeys.has("parent")
  ) {
    return;
  }
  if (context.clearFrontMatterKeys.has("parent")) {
    delete document.metadata.parent;
  } else {
    document.metadata.parent = context.resolvedParentValue ?? "";
  }
  changedFields.push("parent");
}

function applySprintReleaseMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  key: "sprint" | "release",
  warnings: string[],
  changedFields: string[],
): void {
  if (
    context.options[key] === undefined &&
    !context.clearFrontMatterKeys.has(key)
  ) {
    return;
  }
  if (context.clearFrontMatterKeys.has(key)) {
    delete document.metadata[key];
  } else {
    const validation = validateSprintOrReleaseValue(
      key,
      context.options[key] ?? "",
      context.settings.validation.sprint_release_format,
    );
    document.metadata[key] = validation.value;
    warnings.push(...validation.warnings);
  }
  changedFields.push(key);
}

function applyBlockedByMutation(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.blockedBy === undefined &&
    !context.clearFrontMatterKeys.has("blocked_by")
  ) {
    return;
  }
  if (context.clearFrontMatterKeys.has("blocked_by")) {
    delete document.metadata.blocked_by;
  } else {
    document.metadata.blocked_by = context.options.blockedBy?.trim() ?? "";
  }
  changedFields.push("blocked_by");
  if (
    context.clearFrontMatterKeys.has("blocked_by") ||
    context.resolvedBlockedByDependencyId !== undefined
  ) {
    applyBlockedByDependencyEdge(
      document.metadata,
      context.resolvedBlockedByDependencyId,
      context.nowIso,
      context.author,
      changedFields,
    );
  }
}

function applyScheduleMutations(
  document: ItemDocument,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  if (
    context.options.reminder !== undefined ||
    context.clearFrontMatterKeys.has("reminders")
  ) {
    if (context.clearFrontMatterKeys.has("reminders")) {
      delete document.metadata.reminders;
    } else {
      document.metadata.reminders = parseReminderEntries(
        context.options.reminder ?? [],
        context.nowValue,
        { valueMode: "trimmed" },
      );
    }
    changedFields.push("reminders");
  }
  if (
    context.options.event !== undefined ||
    context.clearFrontMatterKeys.has("events")
  ) {
    if (context.clearFrontMatterKeys.has("events")) {
      delete document.metadata.events;
    } else {
      document.metadata.events = parseEventEntries(
        context.options.event ?? [],
        context.nowValue,
        {
          allDayEmptyGuard: "truthy",
          recurrenceEmptyNumericGuard: "truthy",
        },
      );
    }
    changedFields.push("events");
  }
}

function applyRuntimeAndRegisteredFieldMutations(
  metadataRecord: Record<string, unknown>,
  context: UpdateMutationContext,
  changedFields: string[],
): void {
  clearDynamicFields(
    metadataRecord,
    context.runtimeFieldRegistry.definitions.map(
      (definition) => definition.metadata_key,
    ),
    context.clearFrontMatterKeys,
    changedFields,
  );
  clearDynamicFields(
    metadataRecord,
    context.extensionFieldNames,
    context.clearFrontMatterKeys,
    changedFields,
  );
  for (const [fieldKey, fieldValue] of Object.entries(
    context.runtimeFieldUpdates,
  )) {
    if (context.clearFrontMatterKeys.has(fieldKey)) {
      const fieldFlag = fieldKey.replaceAll("_", "-");
      const definition = context.runtimeFieldRegistry.definitions.find(
        (candidate) => candidate.metadata_key === fieldKey,
      );
      const updateFlag = definition?.cli_flag ?? fieldFlag;
      throw new PmCliError(
        `Cannot combine --unset ${fieldFlag} with --${updateFlag}`,
        EXIT_CODE.USAGE,
      );
    }
    if (stableValueEquals(metadataRecord[fieldKey], fieldValue)) {
      continue;
    }
    metadataRecord[fieldKey] = fieldValue;
    changedFields.push(fieldKey);
  }

  const registeredItemFieldUpdates = parseRegisteredItemFieldAssignments(
    context.options.field,
    context.extensionRegistrations,
  );
  for (const fieldKey of Object.keys(registeredItemFieldUpdates)) {
    if (context.clearFrontMatterKeys.has(fieldKey)) {
      throw new PmCliError(
        `Cannot combine --unset ${fieldKey.replaceAll("_", "-")} with --field ${fieldKey}=...`,
        EXIT_CODE.USAGE,
      );
    }
  }
  for (const [fieldKey, fieldValue] of Object.entries(
    registeredItemFieldUpdates,
  )) {
    if (!stableValueEquals(metadataRecord[fieldKey], fieldValue)) {
      metadataRecord[fieldKey] = fieldValue;
      changedFields.push(fieldKey);
    }
  }
}

function clearDynamicFields(
  metadataRecord: Record<string, unknown>,
  fieldKeys: readonly string[],
  clearFrontMatterKeys: ReadonlySet<string>,
  changedFields: string[],
): void {
  for (const fieldKey of fieldKeys) {
    if (
      !clearFrontMatterKeys.has(fieldKey) ||
      metadataRecord[fieldKey] === undefined
    ) {
      continue;
    }
    delete metadataRecord[fieldKey];
    changedFields.push(fieldKey);
  }
}

function mutateUpdateDocument(
  document: ItemDocument,
  context: UpdateMutationContext,
): { changedFields: string[]; warnings: string[] } {
  const changedFields: string[] = [];
  const warnings: string[] = [];
  const previousStatusNormalized = applySimpleItemMutations(
    document,
    context.options,
    context.statusRegistry,
    changedFields,
  );
  const metadataRecord = toItemRecord(document.metadata);
  const scalarMutationContext: UpdateScalarMutationContext = {
    metadataRecord,
    clearFrontMatterKeys: context.clearFrontMatterKeys,
    changedFields,
    nowValue: context.nowValue,
  };

  applyStatusAndCloseReasonMutations(
    document,
    context,
    previousStatusNormalized,
    changedFields,
  );
  applyPriorityTypeAndOptions(document, context, changedFields);
  applyDependencyMutations(document, context, changedFields);
  applyLogCollectionMutations(document, context, changedFields);
  applyEvidenceCollectionMutations(document, context, changedFields);
  applyTagsAndPlanningMutations(document, context, scalarMutationContext);
  applyOwnershipAndIssueMutations(
    document,
    context,
    scalarMutationContext,
    warnings,
  );
  if (
    normalizeStatusInput(document.metadata.status, context.statusRegistry) ===
      context.statusRegistry.canceled_status &&
    document.metadata.assignee !== undefined
  ) {
    delete document.metadata.assignee;
    if (!changedFields.includes("assignee")) {
      changedFields.push("assignee");
    }
  }
  applyScheduleMutations(document, context, changedFields);
  applyRuntimeAndRegisteredFieldMutations(
    metadataRecord,
    context,
    changedFields,
  );
  try {
    applyRegisteredItemFieldDefaultsAndValidation(
      metadataRecord,
      context.extensionRegistrations,
      { skipDefaultFields: context.clearFrontMatterKeys },
    );
  } catch (error: unknown) {
    throw new PmCliError(
      error instanceof Error
        ? error.message
        : "Invalid extension item field values",
      EXIT_CODE.USAGE,
    );
  }
  return { changedFields, warnings };
}

/** Implements run update for the public runtime surface of this module. */
export async function runUpdate(
  id: string,
  options: UpdateCommandOptions,
  global: GlobalOptions,
): Promise<UpdateResult> {
  options = await resolveStdinUpdateOptions(options);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertUpdateTrackerInitialized(pmRoot);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const extensionRegistrations = getActiveExtensionRegistrations();
  const extensionFieldNames = collectRegisteredItemFieldNames(
    extensionRegistrations,
  );
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    extensionRegistrations,
  );
  // Per-type allowed-transition enforcement is read RAW (not preset-derived) so
  // existing projects are unaffected when unset; defaults to "off".
  const workflowEnforcement: GovernanceWorkflowEnforcement =
    settings.governance.workflow_enforcement ?? "off";
  const typeWorkflows =
    workflowEnforcement === "off" ? [] : resolveTypeWorkflows(settings.schema);
  const parentReferencePolicy = settings.validation.parent_reference;
  const unsetTargets = parseUpdateUnsetTargets(
    options.unset,
    runtimeFieldRegistry,
    extensionFieldNames,
  );
  const clearOptionKeys = new Set<string>(unsetTargets.optionKeys);
  const clearFrontMatterKeys = new Set<string>(unsetTargets.frontMatterKeys);

  validateReplaceOptions(options);
  applyClearCollectionDefinitions({
    definitions: buildClearCollectionDefinitions(options),
    options,
    clearOptionKeys,
    clearFrontMatterKeys,
  });
  enforceAllowAuditUpdateScope(id, options, clearFrontMatterKeys);

  rejectUnsetScalarConflicts(options, unsetTargets);
  rejectLegacyScalarTokens(options);

  const author = toAuthor(options.author, settings.author_default);
  const nowValue = new Date();
  const nowIso = nowValue.toISOString();
  const dependencyUpdates = parseDependencyAdditions(
    options.dep,
    settings.id_prefix,
    nowIso,
  );
  const dependencyRemovals = parseDependencyRemovals(
    options.depRemove,
    settings.id_prefix,
  );
  const parsedCommentUpdates = parseLogSeed(
    "--comment",
    options.comment,
    nowIso,
    author,
  );
  const commentUpdates =
    options.allowAuditUpdate === true && parsedCommentUpdates.values
      ? {
          ...parsedCommentUpdates,
          values: parsedCommentUpdates.values.map((entry) => ({
            ...entry,
            author,
          })),
        }
      : parsedCommentUpdates;
  const noteUpdates = parseLogSeed("--note", options.note, nowIso, author);
  const learningUpdates = parseLogSeed(
    "--learning",
    options.learning,
    nowIso,
    author,
  );
  const fileUpdates = parseFiles(options.file);
  const testUpdates = parseTests(options.test);
  const docUpdates = parseDocs(options.doc);
  const workflowTransitionWarnings: string[] = [];
  const parentReference = await resolveParentReferenceForUpdate({
    id,
    options,
    unsetTargets,
    pmRoot,
    settings,
    typeRegistry,
    parentReferencePolicy,
  });

  // pm-kyd6: resolve the --blocked-by target up front (async) so the sync
  // mutate callback can mirror create.ts and add a `blocked_by` dependency edge.
  const blockedByResolution = await resolveBlockedByDependencyTarget(
    options.blockedBy,
    clearFrontMatterKeys.has("blocked_by"),
    pmRoot,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  const resolvedBlockedByDependencyId = blockedByResolution.id;
  const parentReferenceWarnings = [
    ...parentReference.warnings,
    ...blockedByResolutionWarnings(blockedByResolution),
  ];

  const runtimeFieldUpdates = collectRuntimeUpdateFieldValues(
    options as Record<string, unknown>,
    runtimeFieldRegistry,
    options.runtimeFieldCommands,
  );
  const fieldFlags = buildUpdateFieldFlags(options, runtimeFieldUpdates);
  const changedFlags = Object.values(fieldFlags).some(Boolean);

  if (!changedFlags) {
    return buildNoopUpdateResult({ pmRoot, id, settings, typeRegistry });
  }

  workflowTransitionWarnings.push(
    ...(await collectWorkflowTransitionWarnings({
      options,
      fieldFlags,
      workflowEnforcement,
      typeWorkflows,
      statusRegistry,
      typeRegistry,
      pmRoot,
      id,
      settings,
    })),
  );
  const routedClose = await routeCloseStatusUpdate({
    options,
    fieldFlags,
    statusRegistry,
    workflowTransitionWarnings,
    global,
    id,
  });
  if (routedClose) {
    return routedClose;
  }
  assertMatchingOrderRank(options);

  const result = await mutateItem({
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    id,
    op:
      options.allowAuditUpdate === true || options.allowAuditDepUpdate === true
        ? "update_audit"
        : "update",
    author,
    message: options.message,
    force: options.force,
    bypassAssigneeConflict:
      options.allowAuditUpdate === true || options.allowAuditDepUpdate === true,
    extensionFieldNames,
    mutate(document) {
      return mutateUpdateDocument(document, {
        options,
        settings,
        typeRegistry,
        statusRegistry,
        runtimeFieldRegistry,
        extensionRegistrations,
        extensionFieldNames,
        clearFrontMatterKeys,
        dependencyUpdates,
        dependencyRemovals,
        commentUpdates,
        noteUpdates,
        learningUpdates,
        fileUpdates,
        testUpdates,
        docUpdates,
        resolvedParentValue: parentReference.resolvedParentValue,
        resolvedBlockedByDependencyId,
        runtimeFieldUpdates,
        nowValue,
        nowIso,
        author,
        pmRoot,
      });
    },
  });

  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    warnings: [
      ...workflowTransitionWarnings,
      ...parentReferenceWarnings,
      ...result.warnings,
    ],
    ...(options.allowAuditUpdate === true ||
    options.allowAuditDepUpdate === true
      ? { audit_update: true }
      : {}),
  };
}

/* c8 ignore stop */
/** Public contract for test only update command, shared by SDK and presentation-layer consumers. */
export const _testOnlyUpdateCommand = {
  applyStatusAndCloseReasonMutations,
  collectProvidedUpdatePolicyOptions,
  buildAuditScopeRestrictedOptionsError,
  enforceAllowAuditUpdateScope,
  enforceTypeWorkflowTransition,
  matchesDependencySelector,
  normalizeLegacyNoneUpdateOptions,
  normalizeUpdatePolicyOptionKey,
  parseDependencyAdditions,
  parseDependencyRemovals,
  parseUpdateUnsetTargets,
  reconcileBlockedByDependency,
  resolveRuntimeUnsetDefinition: (
    token: string,
    registry: RuntimeFieldRegistry | undefined,
  ) => resolveRuntimeUnsetFieldDefinition(token, "update", registry),
};
