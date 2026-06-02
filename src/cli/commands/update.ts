import { pathExists } from "../../core/fs/fs-utils.js";
import {
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
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import {
  applyTagRemovals,
  createStdinTokenResolver,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNumber,
  parseTags,
} from "../../core/item/parse.js";
import { resolvePriority } from "../../core/item/priority.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { collectRuntimeUpdateFieldValues } from "../../core/schema/runtime-field-values.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { stableValueEquals } from "../../core/shared/serialization.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { applyRegisteredItemFieldDefaultsAndValidation } from "../../core/extensions/item-fields.js";
import { buildItemNotFoundError, locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runClose } from "./close.js";
import {
  normalizeRiskInput,
  normalizeSeverityInput,
  parseConfidenceInput,
  parseRegressionInput,
} from "./metadata-normalizers.js";
import { assertNoLegacyNoneToken, assertNoLegacyNoneTokens, isLegacyNoneToken } from "./legacy-none-tokens.js";
import { ensureEnumValue as ensureEnum } from "./recurrence-parsers.js";
import {
  parseEventEntries,
  parseReminderEntries,
  parseTypeOptionEntries,
} from "./repeatable-metadata-parsers.js";
import type {
  Comment,
  Dependency,
  ItemFormat,
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

export interface UpdateCommandOptions {
  title?: string;
  description?: string;
  body?: string;
  status?: string;
  closeReason?: string;
  priority?: string;
  type?: string;
  tags?: string;
  addTags?: string[];
  removeTags?: string[];
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
  force?: boolean;
  allowAuditUpdate?: boolean;
  allowAuditDepUpdate?: boolean;
  assignee?: string;
  parent?: string;
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
  depRemove?: string[];
  replaceDeps?: boolean;
  replaceTests?: boolean;
  comment?: string[];
  note?: string[];
  learning?: string[];
  file?: string[];
  test?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
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

export interface UpdateResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  warnings: string[];
  audit_update?: boolean;
}

interface UpdateUnsetFieldDefinition {
  optionKey: string;
  frontMatterKey: string;
}

const UPDATE_UNSET_FIELD_DEFINITIONS: ReadonlyArray<{
  canonical: string;
  aliases: readonly string[];
  optionKey: string;
  frontMatterKey: string;
}> = [
  { canonical: "tags", aliases: ["tags"], optionKey: "tags", frontMatterKey: "tags" },
  { canonical: "close-reason", aliases: ["close_reason", "close-reason"], optionKey: "closeReason", frontMatterKey: "close_reason" },
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
  UPDATE_UNSET_FIELD_DEFINITIONS.map((definition) => [definition.optionKey, definition.canonical]),
);

const UPDATE_UNSET_SUPPORTED_CANONICAL_FIELDS = UPDATE_UNSET_FIELD_DEFINITIONS.map((definition) => definition.canonical)
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

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

interface LegacyNoneCollectionNormalizationDefinition {
  optionKey: keyof UpdateCommandOptions;
  clearFlagKey: keyof UpdateCommandOptions;
  valueFlag: string;
  clearFlag: string;
  disableReplaceFlagKey?: "replaceDeps" | "replaceTests";
}

const UPDATE_LEGACY_NONE_COLLECTION_NORMALIZERS: ReadonlyArray<LegacyNoneCollectionNormalizationDefinition> = [
  { optionKey: "dep", clearFlagKey: "clearDeps", valueFlag: "--dep", clearFlag: "--clear-deps", disableReplaceFlagKey: "replaceDeps" },
  { optionKey: "comment", clearFlagKey: "clearComments", valueFlag: "--comment", clearFlag: "--clear-comments" },
  { optionKey: "note", clearFlagKey: "clearNotes", valueFlag: "--note", clearFlag: "--clear-notes" },
  { optionKey: "learning", clearFlagKey: "clearLearnings", valueFlag: "--learning", clearFlag: "--clear-learnings" },
  { optionKey: "file", clearFlagKey: "clearFiles", valueFlag: "--file", clearFlag: "--clear-files" },
  { optionKey: "test", clearFlagKey: "clearTests", valueFlag: "--test", clearFlag: "--clear-tests", disableReplaceFlagKey: "replaceTests" },
  { optionKey: "doc", clearFlagKey: "clearDocs", valueFlag: "--doc", clearFlag: "--clear-docs" },
  { optionKey: "reminder", clearFlagKey: "clearReminders", valueFlag: "--reminder", clearFlag: "--clear-reminders" },
  { optionKey: "event", clearFlagKey: "clearEvents", valueFlag: "--event", clearFlag: "--clear-events" },
  { optionKey: "typeOption", clearFlagKey: "clearTypeOptions", valueFlag: "--type-option", clearFlag: "--clear-type-options" },
];

function normalizeLegacyNoneUpdateOptions(options: UpdateCommandOptions): UpdateCommandOptions {
  const normalized: UpdateCommandOptions = {
    ...options,
    unset: options.unset ? [...options.unset] : undefined,
  };
  const appendUnsetTarget = (value: string): void => {
    const current = normalized.unset ? [...normalized.unset] : [];
    if (!current.includes(value)) {
      current.push(value);
    }
    normalized.unset = current;
  };

  const scalarOptionKeys = new Set<string>([...UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.keys(), "rank"]);
  for (const optionKey of scalarOptionKeys) {
    const candidate = normalized[optionKey];
    if (typeof candidate !== "string" || !isLegacyNoneToken(candidate)) {
      continue;
    }
    const canonicalUnset = optionKey === "rank" ? "order" : (UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey);
    appendUnsetTarget(canonicalUnset);
    normalized[optionKey] = undefined;
  }

  for (const definition of UPDATE_LEGACY_NONE_COLLECTION_NORMALIZERS) {
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
    if (definition.disableReplaceFlagKey) {
      normalized[definition.disableReplaceFlagKey] = false;
    }
  }

  return normalized;
}

function resolveRuntimeUnsetDefinition(
  token: string,
  runtimeFieldRegistry: RuntimeFieldRegistry | undefined,
): UpdateUnsetFieldDefinition | undefined {
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

function parseUpdateUnsetTargets(
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
    const definition = UPDATE_UNSET_ALIAS_MAP.get(trimmed) ?? resolveRuntimeUnsetDefinition(trimmed, runtimeFieldRegistry);
    if (!definition) {
      throw new PmCliError(
        `Unsupported --unset field "${entry}". Supported fields: ${UPDATE_UNSET_SUPPORTED_CANONICAL_FIELDS}`,
        EXIT_CODE.USAGE,
      );
    }
    frontMatterKeys.add(definition.frontMatterKey);
    optionKeys.add(definition.optionKey);
  }

  return { frontMatterKeys, optionKeys };
}

function enforceAllowAuditUpdateScope(options: UpdateCommandOptions, clearFrontMatterKeys: Set<string>): void {
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
    pushIf(options.closeReason !== undefined, "--close-reason", disallowedFlags);
    pushIf(options.priority !== undefined, "--priority", disallowedFlags);
    pushIf(options.type !== undefined, "--type", disallowedFlags);
    pushIf(options.tags !== undefined, "--tags", disallowedFlags);
    pushIf(Array.isArray(options.addTags) && options.addTags.length > 0, "--add-tags", disallowedFlags);
    pushIf(Array.isArray(options.removeTags) && options.removeTags.length > 0, "--remove-tags", disallowedFlags);
    pushIf(options.deadline !== undefined, "--deadline", disallowedFlags);
    pushIf(options.estimatedMinutes !== undefined, "--estimate", disallowedFlags);
    pushIf(options.acceptanceCriteria !== undefined, "--acceptance-criteria", disallowedFlags);
    pushIf(options.definitionOfReady !== undefined, "--definition-of-ready", disallowedFlags);
    pushIf(options.order !== undefined || options.rank !== undefined, "--order/--rank", disallowedFlags);
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
    pushIf(options.blockedReason !== undefined, "--blocked-reason", disallowedFlags);
    pushIf(options.unblockNote !== undefined, "--unblock-note", disallowedFlags);
    pushIf(options.reporter !== undefined, "--reporter", disallowedFlags);
    pushIf(options.severity !== undefined, "--severity", disallowedFlags);
    pushIf(options.environment !== undefined, "--environment", disallowedFlags);
    pushIf(options.reproSteps !== undefined, "--repro-steps", disallowedFlags);
    pushIf(options.resolution !== undefined, "--resolution", disallowedFlags);
    pushIf(options.expectedResult !== undefined, "--expected-result", disallowedFlags);
    pushIf(options.actualResult !== undefined, "--actual-result", disallowedFlags);
    pushIf(options.affectedVersion !== undefined, "--affected-version", disallowedFlags);
    pushIf(options.fixedVersion !== undefined, "--fixed-version", disallowedFlags);
    pushIf(options.component !== undefined, "--component", disallowedFlags);
    pushIf(options.regression !== undefined, "--regression", disallowedFlags);
    pushIf(options.customerImpact !== undefined, "--customer-impact", disallowedFlags);
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
    pushIf(options.clearLearnings === true, "--clear-learnings", disallowedFlags);
    pushIf(options.clearFiles === true, "--clear-files", disallowedFlags);
    pushIf(options.clearTests === true, "--clear-tests", disallowedFlags);
    pushIf(options.clearDocs === true, "--clear-docs", disallowedFlags);
    pushIf(options.clearReminders === true, "--clear-reminders", disallowedFlags);
    pushIf(options.clearEvents === true, "--clear-events", disallowedFlags);
    pushIf(options.clearTypeOptions === true, "--clear-type-options", disallowedFlags);
    pushIf(options.force === true, "--force", disallowedFlags);
    pushIf(clearFrontMatterKeys.size > 0, "--unset", disallowedFlags);
    if (options.dep === undefined || options.dep.length === 0) {
      throw new PmCliError("--allow-audit-dep-update requires at least one --dep value", EXIT_CODE.USAGE);
    }
    if (disallowedFlags.length > 0) {
      throw new PmCliError(
        `--allow-audit-dep-update supports append-only dependency additions via --dep. Remove restricted options: ${disallowedFlags.join(", ")}`,
        EXIT_CODE.USAGE,
      );
    }
    return;
  }

  const disallowedFlags: string[] = [];
  if (options.status !== undefined) {
    disallowedFlags.push("--status");
  }
  if (options.closeReason !== undefined) {
    disallowedFlags.push("--close-reason");
  }
  if (options.assignee !== undefined) {
    disallowedFlags.push("--assignee");
  }
  if (options.parent !== undefined) {
    disallowedFlags.push("--parent");
  }
  if (options.blockedBy !== undefined) {
    disallowedFlags.push("--blocked-by");
  }
  if (options.blockedReason !== undefined) {
    disallowedFlags.push("--blocked-reason");
  }
  if (options.unblockNote !== undefined) {
    disallowedFlags.push("--unblock-note");
  }
  if (options.dep !== undefined) {
    disallowedFlags.push("--dep");
  }
  if (options.depRemove !== undefined) {
    disallowedFlags.push("--dep-remove");
  }
  if (options.replaceDeps === true) {
    disallowedFlags.push("--replace-deps");
  }
  if (options.replaceTests === true) {
    disallowedFlags.push("--replace-tests");
  }
  if (options.comment !== undefined) {
    disallowedFlags.push("--comment");
  }
  if (options.note !== undefined) {
    disallowedFlags.push("--note");
  }
  if (options.learning !== undefined) {
    disallowedFlags.push("--learning");
  }
  if (options.file !== undefined) {
    disallowedFlags.push("--file");
  }
  if (options.test !== undefined) {
    disallowedFlags.push("--test");
  }
  if (options.doc !== undefined) {
    disallowedFlags.push("--doc");
  }
  if (options.reminder !== undefined) {
    disallowedFlags.push("--reminder");
  }
  if (options.event !== undefined) {
    disallowedFlags.push("--event");
  }
  if (options.clearDeps === true) {
    disallowedFlags.push("--clear-deps");
  }
  if (options.clearComments === true) {
    disallowedFlags.push("--clear-comments");
  }
  if (options.clearNotes === true) {
    disallowedFlags.push("--clear-notes");
  }
  if (options.clearLearnings === true) {
    disallowedFlags.push("--clear-learnings");
  }
  if (options.clearFiles === true) {
    disallowedFlags.push("--clear-files");
  }
  if (options.clearTests === true) {
    disallowedFlags.push("--clear-tests");
  }
  if (options.clearDocs === true) {
    disallowedFlags.push("--clear-docs");
  }
  if (options.clearReminders === true) {
    disallowedFlags.push("--clear-reminders");
  }
  if (options.clearEvents === true) {
    disallowedFlags.push("--clear-events");
  }

  const disallowedUnset = [...clearFrontMatterKeys]
    .filter((field) => AUDIT_UPDATE_DISALLOWED_UNSET_FRONT_MATTER_KEYS.has(field))
    .sort((left, right) => left.localeCompare(right))
    .map((field) => `--unset ${field.replaceAll("_", "-")}`);
  disallowedFlags.push(...disallowedUnset);

  if (disallowedFlags.length > 0) {
    throw new PmCliError(
      `--allow-audit-update only supports non-lifecycle metadata fields. Remove restricted options: ${disallowedFlags.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
}

function parseStatus(value: string, statusRegistry: RuntimeStatusRegistry): ItemStatus {
  const normalized = normalizeStatusInput(value, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(`Invalid --status value "${value}". Allowed: ${allowedStatuses.join(", ")}`, EXIT_CODE.USAGE);
  }
  return normalized;
}

interface ParsedDependencyUpdates {
  additions: Dependency[];
}

interface DependencyRemovalSelector {
  id: string;
  kind?: (typeof DEPENDENCY_KIND_VALUES)[number];
  source_kind?: string;
}

function parseDependencyCreatedAt(value: string | undefined, currentIso: string): string {
  if (!value || value.trim() === "" || value.trim().toLowerCase() === "now") {
    return currentIso;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(`Invalid dependency created_at timestamp "${value}"`, EXIT_CODE.USAGE);
  }
  return new Date(parsed).toISOString();
}

function parseOptionalDependencyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function looksLikeStructuredDependencyEntry(raw: string): boolean {
  if (raw.startsWith("```") || raw.includes("\n")) {
    return true;
  }
  return /^(?:[-*+]\s+)?(?:id|kind|type|author|created_at|source_kind)\s*[:=]/i.test(raw);
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

function normalizeDependencyKindInput(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return raw;
  }
  const trimmed = raw.trim();
  const alias = DEPENDENCY_KIND_INPUT_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

function parseDependencyAdditions(raw: string[] | undefined, prefix: string, nowIso: string): ParsedDependencyUpdates {
  if (!raw) {
    return { additions: [] };
  }
  assertNoLegacyNoneTokens(raw, "--dep", "Use --clear-deps to clear dependencies.");
  const additions: Dependency[] = raw.map((entry) => {
    const trimmedEntry = entry.trim();
    const kv = looksLikeStructuredDependencyEntry(trimmedEntry) ? parseCsvKv(entry, "--dep") : { id: trimmedEntry, kind: "related" };
    const id = kv.id?.trim();
    const kind = normalizeDependencyKindInput((kv.kind ?? kv.type)?.trim());
    if (!id || !kind) {
      throw new PmCliError("--dep requires id and kind, or a bare item id to add a related dependency", EXIT_CODE.USAGE);
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

function parseDependencyRemovals(raw: string[] | undefined, prefix: string): DependencyRemovalSelector[] {
  if (!raw) {
    return [];
  }
  assertNoLegacyNoneTokens(raw, "--dep-remove");
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--dep-remove requires id or key/value selectors", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?(?:id|kind|type|source_kind)\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--dep-remove");
      const idRaw = kv.id?.trim();
      if (!idRaw) {
        throw new PmCliError("--dep-remove key/value form requires id=<value>", EXIT_CODE.USAGE);
      }
      if (idRaw.toLowerCase() === "undefined") {
        throw new PmCliError(`--dep-remove id must not use placeholder token "${idRaw}"`, EXIT_CODE.USAGE);
      }
      const kindRaw = normalizeDependencyKindInput(parseOptionalDependencyString(kv.kind ?? kv.type));
      const sourceKind = parseOptionalDependencyString(kv.source_kind);
      return {
        id: normalizeItemId(idRaw, prefix),
        kind: kindRaw ? ensureEnum(kindRaw, DEPENDENCY_KIND_VALUES, "dependency kind") : undefined,
        source_kind: sourceKind,
      };
    }
    if (trimmed.toLowerCase() === "undefined") {
      throw new PmCliError(`--dep-remove id must not use placeholder token "${trimmed}"`, EXIT_CODE.USAGE);
    }
    return {
      id: normalizeItemId(trimmed, prefix),
    };
  });
}

function dependencyKey(value: Pick<Dependency, "id" | "kind" | "source_kind">): string {
  return `${value.id}::${value.kind}::${value.source_kind ?? ""}`;
}

// pm-kyd6: `--blocked-by` writes the `blocked_by` scalar, but the dependency
// graph (`pm deps`) is built only from the `dependencies` array. Mirror the
// behaviour create.ts already has so the metadata and the graph agree: a
// resolvable blocker also gets a `blocked_by` dependency edge, clearing the
// scalar removes that edge, and re-pointing it replaces the prior edge.
function reconcileBlockedByDependency(
  current: Dependency[] | undefined,
  nextBlockedById: string | undefined,
  nowIsoValue: string,
  author: string,
): { dependencies: Dependency[] | undefined; changed: boolean } {
  let next = [...(current ?? [])];
  let changed = false;
  const filtered = next.filter((dep) => dep.kind !== "blocked_by" || dep.id === nextBlockedById);
  if (filtered.length !== next.length) {
    next = filtered;
    changed = true;
  }
  if (nextBlockedById && !next.some((dep) => dep.kind === "blocked_by" && dep.id === nextBlockedById)) {
    next.push({ id: nextBlockedById, kind: "blocked_by", created_at: nowIsoValue, author });
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
  const located = await locateItem(pmRoot, normalizeItemId(blockedByValue, idPrefix), idPrefix, itemFormat, typeToFolder);
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

function testKey(value: Pick<LinkedTest, "command" | "path" | "scope" | "pm_context_mode">): string {
  return `${value.command}::${value.path ?? ""}::${value.scope}::${value.pm_context_mode ?? ""}`;
}

function matchesDependencySelector(value: Dependency, selector: DependencyRemovalSelector): boolean {
  if (value.id !== selector.id) {
    return false;
  }
  if (selector.kind && value.kind !== selector.kind) {
    return false;
  }
  if (selector.source_kind !== undefined && (value.source_kind ?? undefined) !== selector.source_kind) {
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

function collectProvidedUpdatePolicyOptions(options: UpdateCommandOptions): Set<string> {
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
    const unsetTargets = parseUpdateUnsetTargets(options.unset);
    for (const optionKey of unsetTargets.optionKeys) {
      mark(optionKey, true);
    }
  }
  return provided;
}

function enforceUpdateOptionsByType(typeName: string, options: UpdateCommandOptions, typeRegistry: ReturnType<typeof resolveItemTypeRegistry>): void {
  const typeDefinition = resolveTypeDefinition(typeName, typeRegistry);
  if (!typeDefinition) {
    throw new PmCliError(`Invalid type value "${typeName}"`, EXIT_CODE.USAGE);
  }
  const policyState = resolveCommandOptionPolicyState(typeDefinition, "update", []);
  if (policyState.errors.length > 0) {
    throw new PmCliError(policyState.errors.join("; "), EXIT_CODE.CONFLICT);
  }

  const provided = collectProvidedUpdatePolicyOptions(options);
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

export async function runUpdate(id: string, options: UpdateCommandOptions, global: GlobalOptions): Promise<UpdateResult> {
  const stdinResolver = createStdinTokenResolver();
  options = normalizeLegacyNoneUpdateOptions({
    ...options,
    body: await stdinResolver.resolveValue(options.body, "--body"),
    dep: await stdinResolver.resolveList(options.dep, "--dep"),
    depRemove: await stdinResolver.resolveList(options.depRemove, "--dep-remove"),
    comment: await stdinResolver.resolveList(options.comment, "--comment"),
    note: await stdinResolver.resolveList(options.note, "--note"),
    learning: await stdinResolver.resolveList(options.learning, "--learning"),
    file: await stdinResolver.resolveList(options.file, "--file"),
    test: await stdinResolver.resolveList(options.test, "--test"),
    doc: await stdinResolver.resolveList(options.doc, "--doc"),
    reminder: await stdinResolver.resolveList(options.reminder, "--reminder"),
    event: await stdinResolver.resolveList(options.event, "--event"),
    typeOption: await stdinResolver.resolveList(options.typeOption, "--type-option"),
  });
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const parentReferencePolicy = settings.validation.parent_reference;
  const sprintReleasePolicy = settings.validation.sprint_release_format;
  const unsetTargets = parseUpdateUnsetTargets(options.unset, runtimeFieldRegistry);
  const clearOptionKeys = new Set<string>(unsetTargets.optionKeys);
  const clearFrontMatterKeys = new Set<string>(unsetTargets.frontMatterKeys);

  const clearCollectionDefinitions: ReadonlyArray<{
    enabled: boolean | undefined;
    optionKey: string;
    clearFlag: string;
    valueFlag: string;
    values: string[] | undefined;
    frontMatterKey: string;
  }> = [
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
  if (options.replaceDeps === true && (options.dep === undefined || options.dep.length === 0)) {
    throw new PmCliError("--replace-deps requires at least one --dep entry", EXIT_CODE.USAGE);
  }
  if (options.replaceDeps === true && options.depRemove !== undefined && options.depRemove.length > 0) {
    throw new PmCliError("--replace-deps cannot be combined with --dep-remove", EXIT_CODE.USAGE);
  }
  if (options.replaceTests === true && (options.test === undefined || options.test.length === 0)) {
    throw new PmCliError("--replace-tests requires at least one --test entry", EXIT_CODE.USAGE);
  }
  if (options.replaceTests === true && options.clearTests === true) {
    throw new PmCliError("--replace-tests cannot be combined with --clear-tests", EXIT_CODE.USAGE);
  }
  for (const definition of clearCollectionDefinitions) {
    if (!definition.enabled) {
      continue;
    }
    if (
      definition.values &&
      definition.values.length > 0 &&
      !(
        (definition.optionKey === "dep" && options.replaceDeps === true) ||
        (definition.optionKey === "test" && options.replaceTests === true)
      )
    ) {
      throw new PmCliError(`Cannot combine ${definition.clearFlag} with ${definition.valueFlag}`, EXIT_CODE.USAGE);
    }
    clearOptionKeys.add(definition.optionKey);
    clearFrontMatterKeys.add(definition.frontMatterKey);
  }
  enforceAllowAuditUpdateScope(options, clearFrontMatterKeys);

  const scalarOptionPresence: Record<string, boolean> = {
    tags: options.tags !== undefined,
    closeReason: options.closeReason !== undefined,
    deadline: options.deadline !== undefined,
    estimatedMinutes: options.estimatedMinutes !== undefined,
    acceptanceCriteria: options.acceptanceCriteria !== undefined,
    definitionOfReady: options.definitionOfReady !== undefined,
    order: options.order !== undefined || options.rank !== undefined,
    goal: options.goal !== undefined,
    objective: options.objective !== undefined,
    value: options.value !== undefined,
    impact: options.impact !== undefined,
    outcome: options.outcome !== undefined,
    whyNow: options.whyNow !== undefined,
    assignee: options.assignee !== undefined,
    parent: options.parent !== undefined,
    reviewer: options.reviewer !== undefined,
    risk: options.risk !== undefined,
    confidence: options.confidence !== undefined,
    sprint: options.sprint !== undefined,
    release: options.release !== undefined,
    blockedBy: options.blockedBy !== undefined,
    blockedReason: options.blockedReason !== undefined,
    unblockNote: options.unblockNote !== undefined,
    reporter: options.reporter !== undefined,
    severity: options.severity !== undefined,
    environment: options.environment !== undefined,
    reproSteps: options.reproSteps !== undefined,
    resolution: options.resolution !== undefined,
    expectedResult: options.expectedResult !== undefined,
    actualResult: options.actualResult !== undefined,
    affectedVersion: options.affectedVersion !== undefined,
    fixedVersion: options.fixedVersion !== undefined,
    component: options.component !== undefined,
    regression: options.regression !== undefined,
    customerImpact: options.customerImpact !== undefined,
  };
  for (const [optionKey, hasValue] of Object.entries(scalarOptionPresence)) {
    if (!hasValue || !unsetTargets.optionKeys.has(optionKey)) {
      continue;
    }
    const unsetField = UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey) ?? optionKey;
    throw new PmCliError(
      `Cannot combine --unset ${unsetField} with ${commandOptionFlagLabel("update", optionKey)}`,
      EXIT_CODE.USAGE,
    );
  }
  // `--add-tags`/`--remove-tags` aren't in the scalar presence map above (they
  // are repeatable), but combining them with `--unset tags` is the same
  // contradiction as `--unset tags --tags ...`, so reject it explicitly.
  if (clearFrontMatterKeys.has("tags")) {
    if (Array.isArray(options.addTags) && options.addTags.length > 0) {
      throw new PmCliError("Cannot combine --unset tags with --add-tags", EXIT_CODE.USAGE);
    }
    if (Array.isArray(options.removeTags) && options.removeTags.length > 0) {
      throw new PmCliError("Cannot combine --unset tags with --remove-tags", EXIT_CODE.USAGE);
    }
  }

  const assertNoLegacyScalarToken = (value: string | undefined, optionKey: string): void => {
    const unsetField = UPDATE_OPTION_KEY_TO_UNSET_CANONICAL.get(optionKey);
    const hint = unsetField ? `Use --unset ${unsetField} to clear this field.` : undefined;
    assertNoLegacyNoneToken(value, commandOptionFlagLabel("update", optionKey), hint);
  };
  assertNoLegacyScalarToken(options.tags, "tags");
  assertNoLegacyScalarToken(options.closeReason, "closeReason");
  assertNoLegacyScalarToken(options.deadline, "deadline");
  assertNoLegacyScalarToken(options.estimatedMinutes, "estimatedMinutes");
  assertNoLegacyScalarToken(options.acceptanceCriteria, "acceptanceCriteria");
  assertNoLegacyScalarToken(options.definitionOfReady, "definitionOfReady");
  assertNoLegacyScalarToken(options.order ?? options.rank, "order");
  assertNoLegacyScalarToken(options.goal, "goal");
  assertNoLegacyScalarToken(options.objective, "objective");
  assertNoLegacyScalarToken(options.value, "value");
  assertNoLegacyScalarToken(options.impact, "impact");
  assertNoLegacyScalarToken(options.outcome, "outcome");
  assertNoLegacyScalarToken(options.whyNow, "whyNow");
  assertNoLegacyScalarToken(options.assignee, "assignee");
  assertNoLegacyScalarToken(options.parent, "parent");
  assertNoLegacyScalarToken(options.reviewer, "reviewer");
  assertNoLegacyScalarToken(options.risk, "risk");
  assertNoLegacyScalarToken(options.confidence, "confidence");
  assertNoLegacyScalarToken(options.sprint, "sprint");
  assertNoLegacyScalarToken(options.release, "release");
  assertNoLegacyScalarToken(options.blockedBy, "blockedBy");
  assertNoLegacyScalarToken(options.blockedReason, "blockedReason");
  assertNoLegacyScalarToken(options.unblockNote, "unblockNote");
  assertNoLegacyScalarToken(options.reporter, "reporter");
  assertNoLegacyScalarToken(options.severity, "severity");
  assertNoLegacyScalarToken(options.environment, "environment");
  assertNoLegacyScalarToken(options.reproSteps, "reproSteps");
  assertNoLegacyScalarToken(options.resolution, "resolution");
  assertNoLegacyScalarToken(options.expectedResult, "expectedResult");
  assertNoLegacyScalarToken(options.actualResult, "actualResult");
  assertNoLegacyScalarToken(options.affectedVersion, "affectedVersion");
  assertNoLegacyScalarToken(options.fixedVersion, "fixedVersion");
  assertNoLegacyScalarToken(options.component, "component");
  assertNoLegacyScalarToken(options.regression, "regression");
  assertNoLegacyScalarToken(options.customerImpact, "customerImpact");
  assertNoLegacyNoneTokens(options.reminder, "--reminder", "Use --clear-reminders to clear reminders.");
  assertNoLegacyNoneTokens(options.event, "--event", "Use --clear-events to clear linked events.");

  const author = toAuthor(options.author, settings.author_default);
  const nowValue = new Date();
  const nowIso = nowValue.toISOString();
  const dependencyUpdates = parseDependencyAdditions(options.dep, settings.id_prefix, nowIso);
  const dependencyRemovals = parseDependencyRemovals(options.depRemove, settings.id_prefix);
  const commentUpdates = parseLogSeed("--comment", options.comment, nowIso, author);
  const noteUpdates = parseLogSeed("--note", options.note, nowIso, author);
  const learningUpdates = parseLogSeed("--learning", options.learning, nowIso, author);
  const fileUpdates = parseFiles(options.file);
  const testUpdates = parseTests(options.test);
  const docUpdates = parseDocs(options.doc);
  const parentReferenceWarnings: string[] = [];
  let resolvedParentValue: string | undefined;
  if (options.parent !== undefined && !unsetTargets.frontMatterKeys.has("parent")) {
    resolvedParentValue = normalizeParentReferenceValue(options.parent);
    const parentLocated = await locateItem(
      pmRoot,
      resolvedParentValue,
      settings.id_prefix,
      settings.item_format,
      typeRegistry.type_to_folder,
    );
    if (!parentLocated) {
      const normalizedParentId = normalizeItemId(resolvedParentValue, settings.id_prefix);
      parentReferenceWarnings.push(...validateMissingParentReference(normalizedParentId, parentReferencePolicy).warnings);
    }
  }

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
  if (blockedByResolution.unresolved !== undefined) {
    parentReferenceWarnings.push(`blocked_by_unresolved:${blockedByResolution.unresolved}`);
  }

  const fieldFlags: Record<string, boolean> = {
    title: options.title !== undefined,
    description: options.description !== undefined,
    body: options.body !== undefined,
    status: options.status !== undefined,
    closeReason: options.closeReason !== undefined,
    priority: options.priority !== undefined,
    type: options.type !== undefined,
    tags: options.tags !== undefined,
    addTags: Array.isArray(options.addTags) && options.addTags.length > 0,
    removeTags: Array.isArray(options.removeTags) && options.removeTags.length > 0,
    deadline: options.deadline !== undefined,
    estimatedMinutes: options.estimatedMinutes !== undefined,
    acceptanceCriteria: options.acceptanceCriteria !== undefined,
    definitionOfReady: options.definitionOfReady !== undefined,
    order: options.order !== undefined,
    rank: options.rank !== undefined,
    goal: options.goal !== undefined,
    objective: options.objective !== undefined,
    value: options.value !== undefined,
    impact: options.impact !== undefined,
    outcome: options.outcome !== undefined,
    whyNow: options.whyNow !== undefined,
    assignee: options.assignee !== undefined,
    parent: options.parent !== undefined,
    reviewer: options.reviewer !== undefined,
    risk: options.risk !== undefined,
    confidence: options.confidence !== undefined,
    sprint: options.sprint !== undefined,
    release: options.release !== undefined,
    blockedBy: options.blockedBy !== undefined,
    blockedReason: options.blockedReason !== undefined,
    unblockNote: options.unblockNote !== undefined,
    reporter: options.reporter !== undefined,
    severity: options.severity !== undefined,
    environment: options.environment !== undefined,
    reproSteps: options.reproSteps !== undefined,
    resolution: options.resolution !== undefined,
    expectedResult: options.expectedResult !== undefined,
    actualResult: options.actualResult !== undefined,
    affectedVersion: options.affectedVersion !== undefined,
    fixedVersion: options.fixedVersion !== undefined,
    component: options.component !== undefined,
    regression: options.regression !== undefined,
    customerImpact: options.customerImpact !== undefined,
    dep: options.dep !== undefined,
    depRemove: options.depRemove !== undefined,
    replaceDeps: options.replaceDeps === true,
    comment: options.comment !== undefined,
    note: options.note !== undefined,
    learning: options.learning !== undefined,
    file: options.file !== undefined,
    test: options.test !== undefined,
    replaceTests: options.replaceTests === true,
    doc: options.doc !== undefined,
    reminder: options.reminder !== undefined,
    event: options.event !== undefined,
    typeOption: options.typeOption !== undefined,
    unset: options.unset !== undefined && options.unset.length > 0,
    clearDeps: options.clearDeps === true,
    clearComments: options.clearComments === true,
    clearNotes: options.clearNotes === true,
    clearLearnings: options.clearLearnings === true,
    clearFiles: options.clearFiles === true,
    clearTests: options.clearTests === true,
    clearDocs: options.clearDocs === true,
    clearReminders: options.clearReminders === true,
    clearEvents: options.clearEvents === true,
    clearTypeOptions: options.clearTypeOptions === true,
  };
  const changedFlags = Object.values(fieldFlags).some(Boolean);

  if (!changedFlags) {
    const located = await locateItem(
      pmRoot,
      id,
      settings.id_prefix,
      settings.item_format,
      typeRegistry.type_to_folder,
    );
    if (!located) {
      throw await buildItemNotFoundError(pmRoot, id, settings.id_prefix, typeRegistry.type_to_folder);
    }
    const { document } = await readLocatedItem(located, { schema: settings.schema });
    return {
      item: toItemRecord(document.metadata),
      changed_fields: [],
      warnings: ["noop_no_update_fields"],
    };
  }

  // `pm update --status <close_status>` always routes to the auditable close
  // workflow so agents are never blocked by close-through-update errors. Any
  // other field updates in the same call are applied first, then the item is
  // closed with the supplied --close-reason (or a derived default when omitted).
  if (fieldFlags.status) {
    const targetStatus = normalizeStatusInput(options.status as ItemStatus, statusRegistry);
    if (targetStatus === statusRegistry.close_status) {
      const otherFieldKeys = Object.entries(fieldFlags)
        .filter(([key, value]) => value && key !== "status" && key !== "closeReason")
        .map(([key]) => key);

      const routeWarnings: string[] = [];
      let preChangedFields: string[] = [];
      if (otherFieldKeys.length > 0) {
        const preUpdate = await runUpdate(
          id,
          { ...options, status: undefined, closeReason: undefined, message: undefined },
          global,
        );
        preChangedFields = preUpdate.changed_fields;
        routeWarnings.push(...preUpdate.warnings);
      }

      const explicitReason = typeof options.closeReason === "string" ? options.closeReason.trim() : "";
      const fallbackMessage = typeof options.message === "string" ? options.message.trim() : "";
      const closeReason = explicitReason || fallbackMessage || "Closed via pm update";
      // Only flag a defaulted reason when neither --close-reason nor --message
      // supplied any text and we had to invent the generic placeholder.
      const reasonDefaulted = explicitReason.length === 0 && fallbackMessage.length === 0;

      const closeResult = await runClose(
        id,
        closeReason,
        {
          author: options.author,
          message: options.message,
          force: options.force,
        },
        global,
      );

      const warnings = [...routeWarnings, ...closeResult.warnings, "auto_routed_from_update_to_close"];
      if (reasonDefaulted) {
        warnings.push("close_reason_defaulted");
      }
      return {
        item: closeResult.item,
        changed_fields: [...preChangedFields, ...closeResult.changed_fields],
        warnings,
      };
    }
  }
  if (options.order !== undefined && options.rank !== undefined && options.order !== options.rank) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    id,
    op: options.allowAuditUpdate === true || options.allowAuditDepUpdate === true ? "update_audit" : "update",
    author,
    message: options.message,
    force: options.force,
    bypassAssigneeConflict: options.allowAuditUpdate === true || options.allowAuditDepUpdate === true,
    mutate(document) {
      const changedFields: string[] = [];
      const warnings: string[] = [];
      let activeTypeName = resolveTypeName(document.metadata.type, typeRegistry) ?? document.metadata.type;

      // Declarative set-or-clear helpers for the many string scalar fields that
      // share an identical shape: set from `--flag` (optionally transformed) or
      // delete when `--unset <field>` was requested, then record the change.
      // Each call is placed in the same position the inline block occupied so
      // the order of `changedFields` is preserved exactly (pm-why9).
      const metadataRecord = toItemRecord(document.metadata);
      const setOrClearScalar = (
        optionValue: string | undefined,
        metadataKey: string,
        transform: (value: string) => unknown,
      ): void => {
        if (optionValue === undefined && !clearFrontMatterKeys.has(metadataKey)) {
          return;
        }
        if (clearFrontMatterKeys.has(metadataKey)) {
          delete metadataRecord[metadataKey];
        } else {
          metadataRecord[metadataKey] = transform(optionValue as string);
        }
        changedFields.push(metadataKey);
      };
      const setOrClearTrimScalar = (optionValue: string | undefined, metadataKey: string): void => {
        setOrClearScalar(optionValue, metadataKey, (value) => value.trim());
      };

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
      const previousStatus = document.metadata.status;
      const previousStatusNormalized = normalizeStatusInput(previousStatus, statusRegistry) ?? previousStatus;
      if (options.status !== undefined) {
        // Close-status routing (with reason + audit) is handled before mutateItem
        // by the close gate above, so only non-close transitions reach this path.
        const status = parseStatus(options.status, statusRegistry);
        document.metadata.status = status;
        if (status === statusRegistry.canceled_status) {
          delete document.metadata.assignee;
        }
        changedFields.push("status");
      }
      if (options.closeReason !== undefined || clearFrontMatterKeys.has("close_reason")) {
        if (clearFrontMatterKeys.has("close_reason")) {
          delete document.metadata.close_reason;
        } else {
          const closeReason = options.closeReason!.trim();
          if (closeReason.length === 0) {
            throw new PmCliError("--close-reason must not be empty", EXIT_CODE.USAGE);
          }
          document.metadata.close_reason = closeReason;
        }
        changedFields.push("close_reason");
      } else if (
        options.status !== undefined &&
        previousStatusNormalized === statusRegistry.close_status &&
        document.metadata.status !== statusRegistry.canceled_status &&
        document.metadata.close_reason !== undefined
      ) {
        delete document.metadata.close_reason;
        changedFields.push("close_reason");
      }
      if (options.priority !== undefined) {
        document.metadata.priority = ensurePriority(options.priority);
        changedFields.push("priority");
      }
      if (options.type !== undefined) {
        const resolvedTypeName = resolveTypeName(options.type, typeRegistry);
        if (!resolvedTypeName) {
          throw new PmCliError(
            buildInvalidTypeError(options.type, typeRegistry.types),
            EXIT_CODE.USAGE,
          );
        }
        document.metadata.type = resolvedTypeName;
        activeTypeName = resolvedTypeName;
        changedFields.push("type");
      }
      enforceUpdateOptionsByType(activeTypeName, options, typeRegistry);
      if (options.typeOption !== undefined || clearFrontMatterKeys.has("type_options")) {
        if (clearFrontMatterKeys.has("type_options")) {
          delete document.metadata.type_options;
        } else {
          const parsedTypeOptions = parseTypeOptionEntries(options.typeOption!);
          const validation = validateTypeOptions(activeTypeName, parsedTypeOptions, typeRegistry);
          if (validation.errors.length > 0) {
            throw new PmCliError(validation.errors.join("; "), EXIT_CODE.USAGE);
          }
          document.metadata.type_options = validation.normalized;
        }
        changedFields.push("type_options");
      } else if (options.type !== undefined && document.metadata.type_options !== undefined) {
        const validation = validateTypeOptions(activeTypeName, document.metadata.type_options, typeRegistry);
        if (validation.errors.length > 0) {
          throw new PmCliError(
            `Current type options are incompatible with type "${activeTypeName}". ${validation.errors.join("; ")}. Use --clear-type-options to clear them.`,
            EXIT_CODE.USAGE,
          );
        }
        document.metadata.type_options = validation.normalized;
      }
      if (options.dep !== undefined || options.depRemove !== undefined || clearFrontMatterKeys.has("dependencies")) {
        let nextDependencies = clearFrontMatterKeys.has("dependencies") ? [] : [...(document.metadata.dependencies ?? [])];
        if (dependencyUpdates.additions.length > 0) {
          const seen = new Set(nextDependencies.map((entry) => dependencyKey(entry)));
          for (const addition of dependencyUpdates.additions) {
            const key = dependencyKey(addition);
            if (seen.has(key)) {
              continue;
            }
            nextDependencies.push(addition);
            seen.add(key);
          }
        }
        if (dependencyRemovals.length > 0) {
          nextDependencies = nextDependencies.filter(
            (entry) => !dependencyRemovals.some((selector) => matchesDependencySelector(entry, selector)),
          );
        }
        if (nextDependencies.length === 0) {
          delete document.metadata.dependencies;
        } else {
          document.metadata.dependencies = nextDependencies;
        }
        changedFields.push("dependencies");
      }
      if (options.comment !== undefined || clearFrontMatterKeys.has("comments")) {
        if (clearFrontMatterKeys.has("comments") || !commentUpdates.values || commentUpdates.values.length === 0) {
          delete document.metadata.comments;
        } else {
          document.metadata.comments = [...(document.metadata.comments ?? []), ...(commentUpdates.values as Comment[])];
        }
        changedFields.push("comments");
      }
      if (options.note !== undefined || clearFrontMatterKeys.has("notes")) {
        if (clearFrontMatterKeys.has("notes") || !noteUpdates.values || noteUpdates.values.length === 0) {
          delete document.metadata.notes;
        } else {
          document.metadata.notes = [...(document.metadata.notes ?? []), ...(noteUpdates.values as LogNote[])];
        }
        changedFields.push("notes");
      }
      if (options.learning !== undefined || clearFrontMatterKeys.has("learnings")) {
        if (clearFrontMatterKeys.has("learnings") || !learningUpdates.values || learningUpdates.values.length === 0) {
          delete document.metadata.learnings;
        } else {
          document.metadata.learnings = [...(document.metadata.learnings ?? []), ...(learningUpdates.values as LogNote[])];
        }
        changedFields.push("learnings");
      }
      if (options.file !== undefined || clearFrontMatterKeys.has("files")) {
        if (clearFrontMatterKeys.has("files") || !fileUpdates.values || fileUpdates.values.length === 0) {
          delete document.metadata.files;
        } else {
          const nextFiles = [...(document.metadata.files ?? [])];
          const seen = new Set(nextFiles.map((entry) => fileKey(entry)));
          for (const entry of fileUpdates.values) {
            const key = fileKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextFiles.push(entry);
            seen.add(key);
          }
          document.metadata.files = nextFiles;
        }
        changedFields.push("files");
      }
      if (options.test !== undefined || clearFrontMatterKeys.has("tests")) {
        if (clearFrontMatterKeys.has("tests") && options.replaceTests === true) {
          if (!testUpdates.values || testUpdates.values.length === 0) {
            delete document.metadata.tests;
          } else {
            const replacementTests: LinkedTest[] = [];
            const seen = new Set<string>();
            for (const entry of testUpdates.values) {
              const key = testKey(entry);
              if (seen.has(key)) {
                continue;
              }
              replacementTests.push(entry);
              seen.add(key);
            }
            document.metadata.tests = replacementTests;
          }
        } else if (clearFrontMatterKeys.has("tests") || !testUpdates.values || testUpdates.values.length === 0) {
          delete document.metadata.tests;
        } else {
          const nextTests = [...(document.metadata.tests ?? [])];
          const seen = new Set(nextTests.map((entry) => testKey(entry)));
          for (const entry of testUpdates.values) {
            const key = testKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextTests.push(entry);
            seen.add(key);
          }
          document.metadata.tests = nextTests;
        }
        changedFields.push("tests");
      }
      if (options.doc !== undefined || clearFrontMatterKeys.has("docs")) {
        if (clearFrontMatterKeys.has("docs") || !docUpdates.values || docUpdates.values.length === 0) {
          delete document.metadata.docs;
        } else {
          const nextDocs = [...(document.metadata.docs ?? [])];
          const seen = new Set(nextDocs.map((entry) => docKey(entry)));
          for (const entry of docUpdates.values) {
            const key = docKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextDocs.push(entry);
            seen.add(key);
          }
          document.metadata.docs = nextDocs;
        }
        changedFields.push("docs");
      }
      const addTagsValues = options.addTags;
      const removeTagsValues = options.removeTags;
      const hasAdditiveTagMutation =
        (Array.isArray(addTagsValues) && addTagsValues.length > 0) ||
        (Array.isArray(removeTagsValues) && removeTagsValues.length > 0);
      if (options.tags !== undefined || clearFrontMatterKeys.has("tags") || hasAdditiveTagMutation) {
        const baseTags = clearFrontMatterKeys.has("tags")
          ? []
          : options.tags !== undefined
            ? parseTags(options.tags!)
            : Array.isArray(document.metadata.tags)
              ? [...(document.metadata.tags as string[])]
              : [];
        const withAdditions = mergeAdditiveTags(baseTags, addTagsValues);
        const finalTags = applyTagRemovals(withAdditions, removeTagsValues);
        document.metadata.tags = finalTags;
        changedFields.push("tags");
      }
      setOrClearScalar(options.deadline, "deadline", (value) => resolveIsoOrRelative(value, nowValue, "deadline"));
      setOrClearScalar(options.estimatedMinutes, "estimated_minutes", (value) =>
        parseOptionalNumber(value, "estimated-minutes"),
      );
      setOrClearScalar(options.acceptanceCriteria, "acceptance_criteria", (value) => value);
      setOrClearTrimScalar(options.definitionOfReady, "definition_of_ready");
      const orderRaw = options.order ?? options.rank;
      if (orderRaw !== undefined || clearFrontMatterKeys.has("order")) {
        if (clearFrontMatterKeys.has("order")) {
          delete document.metadata.order;
        } else {
          const parsedOrder = parseOptionalNumber(orderRaw!, "order");
          if (!Number.isInteger(parsedOrder)) {
            throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
          }
          document.metadata.order = parsedOrder;
        }
        changedFields.push("order");
      }
      setOrClearTrimScalar(options.goal, "goal");
      setOrClearTrimScalar(options.objective, "objective");
      setOrClearTrimScalar(options.value, "value");
      setOrClearTrimScalar(options.impact, "impact");
      setOrClearTrimScalar(options.outcome, "outcome");
      setOrClearTrimScalar(options.whyNow, "why_now");
      if (options.assignee !== undefined || clearFrontMatterKeys.has("assignee")) {
        if (clearFrontMatterKeys.has("assignee")) {
          delete document.metadata.assignee;
        } else {
          if (options.assignee!.trim() === "") {
            throw new PmCliError("--assignee must not be empty. Use --unset assignee to clear it.", EXIT_CODE.USAGE);
          }
          document.metadata.assignee = options.assignee!.trim();
        }
        changedFields.push("assignee");
      }
      if (options.parent !== undefined || clearFrontMatterKeys.has("parent")) {
        if (clearFrontMatterKeys.has("parent")) {
          delete document.metadata.parent;
        } else {
          document.metadata.parent = resolvedParentValue as string;
        }
        changedFields.push("parent");
      }
      setOrClearTrimScalar(options.reviewer, "reviewer");
      setOrClearScalar(options.risk, "risk", (value) => ensureEnum(normalizeRiskInput(value), RISK_VALUES, "risk"));
      setOrClearScalar(options.confidence, "confidence", (value) => parseConfidenceInput(value));
      if (options.sprint !== undefined || clearFrontMatterKeys.has("sprint")) {
        if (clearFrontMatterKeys.has("sprint")) {
          delete document.metadata.sprint;
        } else {
          const sprintValidation = validateSprintOrReleaseValue("sprint", options.sprint!, sprintReleasePolicy);
          document.metadata.sprint = sprintValidation.value;
          warnings.push(...sprintValidation.warnings);
        }
        changedFields.push("sprint");
      }
      if (options.release !== undefined || clearFrontMatterKeys.has("release")) {
        if (clearFrontMatterKeys.has("release")) {
          delete document.metadata.release;
        } else {
          const releaseValidation = validateSprintOrReleaseValue("release", options.release!, sprintReleasePolicy);
          document.metadata.release = releaseValidation.value;
          warnings.push(...releaseValidation.warnings);
        }
        changedFields.push("release");
      }
      if (options.blockedBy !== undefined || clearFrontMatterKeys.has("blocked_by")) {
        if (clearFrontMatterKeys.has("blocked_by")) {
          delete document.metadata.blocked_by;
        } else {
          document.metadata.blocked_by = options.blockedBy!.trim();
        }
        changedFields.push("blocked_by");
        // pm-kyd6: keep the dependency graph in sync with the blocked_by scalar.
        applyBlockedByDependencyEdge(
          document.metadata,
          resolvedBlockedByDependencyId,
          nowIso,
          author,
          changedFields,
        );
      }
      setOrClearTrimScalar(options.blockedReason, "blocked_reason");
      setOrClearTrimScalar(options.unblockNote, "unblock_note");
      setOrClearTrimScalar(options.reporter, "reporter");
      setOrClearScalar(options.severity, "severity", (value) =>
        ensureEnum(normalizeSeverityInput(value), ISSUE_SEVERITY_VALUES, "severity"),
      );
      setOrClearTrimScalar(options.environment, "environment");
      setOrClearTrimScalar(options.reproSteps, "repro_steps");
      setOrClearTrimScalar(options.resolution, "resolution");
      setOrClearTrimScalar(options.expectedResult, "expected_result");
      setOrClearTrimScalar(options.actualResult, "actual_result");
      setOrClearTrimScalar(options.affectedVersion, "affected_version");
      setOrClearTrimScalar(options.fixedVersion, "fixed_version");
      setOrClearTrimScalar(options.component, "component");
      setOrClearScalar(options.regression, "regression", (value) => parseRegressionInput(value));
      setOrClearTrimScalar(options.customerImpact, "customer_impact");
      if (options.reminder !== undefined || clearFrontMatterKeys.has("reminders")) {
        if (clearFrontMatterKeys.has("reminders")) {
          delete document.metadata.reminders;
        } else {
          document.metadata.reminders = parseReminderEntries(options.reminder!, nowValue, { valueMode: "trimmed" });
        }
        changedFields.push("reminders");
      }
      if (options.event !== undefined || clearFrontMatterKeys.has("events")) {
        if (clearFrontMatterKeys.has("events")) {
          delete document.metadata.events;
        } else {
          document.metadata.events = parseEventEntries(options.event!, nowValue, {
            allDayEmptyGuard: "truthy",
            recurrenceEmptyNumericGuard: "truthy",
          });
        }
        changedFields.push("events");
      }

      for (const definition of runtimeFieldRegistry.definitions) {
        if (!clearFrontMatterKeys.has(definition.metadata_key)) {
          continue;
        }
        if (metadataRecord[definition.metadata_key] === undefined) {
          continue;
        }
        delete metadataRecord[definition.metadata_key];
        changedFields.push(definition.metadata_key);
      }

      const runtimeFieldUpdates = collectRuntimeUpdateFieldValues(options as Record<string, unknown>, runtimeFieldRegistry);
      for (const [fieldKey, fieldValue] of Object.entries(runtimeFieldUpdates)) {
        if (clearFrontMatterKeys.has(fieldKey)) {
          continue;
        }
        if (stableValueEquals(metadataRecord[fieldKey], fieldValue)) {
          continue;
        }
        metadataRecord[fieldKey] = fieldValue;
        changedFields.push(fieldKey);
      }

      try {
        applyRegisteredItemFieldDefaultsAndValidation(
          metadataRecord,
          getActiveExtensionRegistrations(),
        );
      } catch (error: unknown) {
        throw new PmCliError(error instanceof Error ? error.message : "Invalid extension item field values", EXIT_CODE.USAGE);
      }

      return { changedFields, warnings };
    },
  });

  return {
    item: toItemRecord(result.item),
    changed_fields: result.changedFields,
    warnings: [...parentReferenceWarnings, ...result.warnings],
    ...(options.allowAuditUpdate === true || options.allowAuditDepUpdate === true ? { audit_update: true } : {}),
  };
}
