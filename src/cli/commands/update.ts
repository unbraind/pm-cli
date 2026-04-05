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
import {
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import { createStdinTokenResolver, parseCsvKv, parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isNoneToken, resolveIsoOrRelative } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { applyRegisteredItemFieldDefaultsAndValidation } from "../../core/extensions/item-fields.js";
import { locateItem, mutateItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  CalendarEvent,
  Comment,
  Dependency,
  ItemStatus,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  RecurrenceRule,
  Reminder,
} from "../../types/index.js";
import {
  CONFIDENCE_TEXT_VALUES,
  DEPENDENCY_KIND_VALUES,
  ISSUE_SEVERITY_VALUES,
  RECURRENCE_FREQUENCY_VALUES,
  RECURRENCE_WEEKDAY_VALUES,
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
  comment?: string[];
  note?: string[];
  learning?: string[];
  file?: string[];
  test?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
}

export interface UpdateResult {
  item: Record<string, unknown>;
  changed_fields: string[];
  warnings: string[];
}

function toAuthor(candidate: string | undefined, defaultAuthor: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? defaultAuthor;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function ensureEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(`Invalid ${label} value "${value}"`, EXIT_CODE.USAGE);
  }
  return value as T;
}

function parseStatus(value: string): ItemStatus {
  const normalized = normalizeStatusInput(value);
  if (!normalized) {
    throw new PmCliError(`Invalid --status value "${value}"`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function normalizeRiskInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "med" ? "medium" : trimmed;
}

function normalizeSeverityInput(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === "med" ? "medium" : trimmed;
}

function parseConfidenceInput(value: string): number | "low" | "medium" | "high" {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "med") {
    return "medium";
  }
  if (CONFIDENCE_TEXT_VALUES.includes(trimmed as (typeof CONFIDENCE_TEXT_VALUES)[number])) {
    return trimmed as (typeof CONFIDENCE_TEXT_VALUES)[number];
  }
  const parsed = parseOptionalNumber(value, "confidence");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new PmCliError("Confidence must be an integer 0..100 or one of low|med|medium|high", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseRegressionInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new PmCliError("Regression must be one of true|false|1|0", EXIT_CODE.USAGE);
}

function weekdayOrderIndex(value: (typeof RECURRENCE_WEEKDAY_VALUES)[number]): number {
  return RECURRENCE_WEEKDAY_VALUES.indexOf(value);
}

function parseReminderEntries(raw: string[], nowValue: Date): Reminder[] {
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--reminder");
    const atRaw = kv.at?.trim();
    const textRaw = kv.text?.trim();
    if (!atRaw || !textRaw || isNoneToken(atRaw) || isNoneToken(textRaw)) {
      throw new PmCliError("--reminder requires at=<iso|relative> and text=<value>", EXIT_CODE.USAGE);
    }
    return {
      at: resolveIsoOrRelative(atRaw, nowValue),
      text: textRaw,
    };
  });
}

function parseEventBoolean(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new PmCliError(`${flag} must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
}

function parseDelimitedList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("|")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseRecurrenceRule(kv: Record<string, string>, startAt: string, nowValue: Date): RecurrenceRule | undefined {
  const freqRaw = kv.recur_freq?.trim();
  const intervalRaw = kv.recur_interval?.trim();
  const countRaw = kv.recur_count?.trim();
  const untilRaw = kv.recur_until?.trim();
  const byWeekdayRaw = kv.recur_by_weekday?.trim();
  const byMonthDayRaw = kv.recur_by_month_day?.trim();
  const exdatesRaw = kv.recur_exdates?.trim();

  const recurrenceInputsProvided = [freqRaw, intervalRaw, countRaw, untilRaw, byWeekdayRaw, byMonthDayRaw, exdatesRaw].some(
    (value) => value !== undefined && !isNoneToken(value),
  );
  if (!recurrenceInputsProvided) {
    return undefined;
  }
  if (!freqRaw || isNoneToken(freqRaw)) {
    throw new PmCliError("--event recurrence fields require recur_freq=<daily|weekly|monthly|yearly>", EXIT_CODE.USAGE);
  }

  const freq = ensureEnum(freqRaw.toLowerCase(), RECURRENCE_FREQUENCY_VALUES, "event recurrence frequency");
  const interval = intervalRaw && !isNoneToken(intervalRaw) ? parseOptionalNumber(intervalRaw, "event recur_interval") : undefined;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 1)) {
    throw new PmCliError("--event recur_interval must be an integer >= 1", EXIT_CODE.USAGE);
  }
  const count = countRaw && !isNoneToken(countRaw) ? parseOptionalNumber(countRaw, "event recur_count") : undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    throw new PmCliError("--event recur_count must be an integer >= 1", EXIT_CODE.USAGE);
  }
  const until = untilRaw && !isNoneToken(untilRaw) ? resolveIsoOrRelative(untilRaw, nowValue) : undefined;
  if (until && until < startAt) {
    throw new PmCliError("--event recur_until must be at or after start", EXIT_CODE.USAGE);
  }

  const byWeekday = Array.from(
    new Set(
      parseDelimitedList(byWeekdayRaw)
        .filter((value) => !isNoneToken(value))
        .map((value) => ensureEnum(value.toLowerCase(), RECURRENCE_WEEKDAY_VALUES, "event weekday")),
    ),
  ).sort(
    (left, right) =>
      weekdayOrderIndex(left as (typeof RECURRENCE_WEEKDAY_VALUES)[number]) -
      weekdayOrderIndex(right as (typeof RECURRENCE_WEEKDAY_VALUES)[number]),
  );

  const byMonthDay = Array.from(
    new Set(
      parseDelimitedList(byMonthDayRaw)
        .filter((value) => !isNoneToken(value))
        .map((value) => {
          const day = parseOptionalNumber(value, "event recur_by_month_day");
          if (!Number.isInteger(day) || day < 1 || day > 31) {
            throw new PmCliError("--event recur_by_month_day values must be integers 1..31", EXIT_CODE.USAGE);
          }
          return day;
        }),
    ),
  ).sort((left, right) => left - right);

  const exdates = Array.from(
    new Set(
      parseDelimitedList(exdatesRaw)
        .filter((value) => !isNoneToken(value))
        .map((value) => resolveIsoOrRelative(value, nowValue)),
    ),
  ).sort((left, right) => left.localeCompare(right));

  return {
    freq,
    interval,
    count,
    until,
    by_weekday: byWeekday.length > 0 ? byWeekday : undefined,
    by_month_day: byMonthDay.length > 0 ? byMonthDay : undefined,
    exdates: exdates.length > 0 ? exdates : undefined,
  };
}

function parseEventEntries(raw: string[], nowValue: Date): CalendarEvent[] {
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--event");
    const startRaw = kv.start?.trim();
    if (!startRaw || isNoneToken(startRaw)) {
      throw new PmCliError("--event requires start=<iso|relative>", EXIT_CODE.USAGE);
    }
    const startAt = resolveIsoOrRelative(startRaw, nowValue);
    const endRaw = kv.end?.trim();
    const endAt = endRaw && !isNoneToken(endRaw) ? resolveIsoOrRelative(endRaw, nowValue) : undefined;
    if (endAt && endAt <= startAt) {
      throw new PmCliError("--event end must be after start", EXIT_CODE.USAGE);
    }

    const titleRaw = kv.title;
    const descriptionRaw = kv.description;
    const locationRaw = kv.location;
    const timezoneRaw = kv.timezone;
    if (titleRaw !== undefined && isNoneToken(titleRaw)) {
      throw new PmCliError("--event title cannot be none", EXIT_CODE.USAGE);
    }
    if (descriptionRaw !== undefined && isNoneToken(descriptionRaw)) {
      throw new PmCliError("--event description cannot be none", EXIT_CODE.USAGE);
    }
    if (locationRaw !== undefined && isNoneToken(locationRaw)) {
      throw new PmCliError("--event location cannot be none", EXIT_CODE.USAGE);
    }
    if (timezoneRaw !== undefined && isNoneToken(timezoneRaw)) {
      throw new PmCliError("--event timezone cannot be none", EXIT_CODE.USAGE);
    }

    const title = titleRaw?.trim();
    const description = descriptionRaw?.trim();
    const location = locationRaw?.trim();
    const timezone = timezoneRaw?.trim();
    if (titleRaw !== undefined && !title) {
      throw new PmCliError("--event title must not be empty", EXIT_CODE.USAGE);
    }
    if (descriptionRaw !== undefined && !description) {
      throw new PmCliError("--event description must not be empty", EXIT_CODE.USAGE);
    }
    if (locationRaw !== undefined && !location) {
      throw new PmCliError("--event location must not be empty", EXIT_CODE.USAGE);
    }
    if (timezoneRaw !== undefined && !timezone) {
      throw new PmCliError("--event timezone must not be empty", EXIT_CODE.USAGE);
    }

    const allDayRaw = kv.all_day?.trim();
    const recurrence = parseRecurrenceRule(kv, startAt, nowValue);

    return {
      start_at: startAt,
      end_at: endAt,
      title,
      description,
      location,
      all_day: allDayRaw && !isNoneToken(allDayRaw) ? parseEventBoolean(allDayRaw, "--event all_day") : undefined,
      timezone,
      recurrence,
    };
  });
}

function parseTypeOptionEntries(raw: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of raw) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      throw new PmCliError("--type-option values must not be empty", EXIT_CODE.USAGE);
    }
    let key: string | undefined;
    let value: string | undefined;
    const prefersStructuredKv =
      trimmedEntry.includes(",") ||
      trimmedEntry.includes("\n") ||
      trimmedEntry.startsWith("```") ||
      /^(?:[-*+]\s+)?(?:key|value)\s*[:=]/i.test(trimmedEntry);
    if (prefersStructuredKv) {
      const kv = parseCsvKv(trimmedEntry, "--type-option");
      key = kv.key?.trim();
      value = kv.value?.trim();
    } else {
      const equalsIndex = trimmedEntry.indexOf("=");
      const colonIndex = trimmedEntry.indexOf(":");
      let separatorIndex = equalsIndex;
      if (equalsIndex <= 0 && colonIndex > 0) {
        separatorIndex = colonIndex;
      }
      if (separatorIndex <= 0 || separatorIndex === trimmedEntry.length - 1) {
        throw new PmCliError(
          "--type-option requires key=value or key=<name>,value=<value> entries",
          EXIT_CODE.USAGE,
        );
      }
      key = trimmedEntry.slice(0, separatorIndex).trim();
      value = trimmedEntry.slice(separatorIndex + 1).trim();
    }
    if (!key || !value) {
      throw new PmCliError("--type-option requires key and value", EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  return Object.fromEntries(Object.entries(values).sort((left, right) => left[0].localeCompare(right[0])));
}

interface ParsedDependencyUpdates {
  clear: boolean;
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
  if (isNoneToken(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDependencyAdditions(raw: string[] | undefined, prefix: string, nowIso: string): ParsedDependencyUpdates {
  if (!raw) {
    return { clear: false, additions: [] };
  }
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--dep cannot mix 'none' with dependency values", EXIT_CODE.USAGE);
    }
    return { clear: true, additions: [] };
  }
  const additions: Dependency[] = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--dep");
    const id = kv.id?.trim();
    const kind = kv.kind?.trim();
    if (!id || !kind) {
      throw new PmCliError("--dep requires id and kind", EXIT_CODE.USAGE);
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
  return { clear: false, additions };
}

function parseDependencyRemovals(raw: string[] | undefined, prefix: string): DependencyRemovalSelector[] {
  if (!raw) {
    return [];
  }
  if (raw.some((entry) => isNoneToken(entry))) {
    throw new PmCliError("--dep-remove does not accept 'none'. Omit the flag when no removals are needed.", EXIT_CODE.USAGE);
  }
  return raw.map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new PmCliError("--dep-remove requires id or key/value selectors", EXIT_CODE.USAGE);
    }
    if (trimmed.includes("=") || /^(?:[-*+]\s+)?(?:id|kind|source_kind)\s*[:=]/i.test(trimmed) || trimmed.startsWith("```")) {
      const kv = parseCsvKv(trimmed, "--dep-remove");
      const idRaw = kv.id?.trim();
      if (!idRaw) {
        throw new PmCliError("--dep-remove key/value form requires id=<value>", EXIT_CODE.USAGE);
      }
      const kindRaw = parseOptionalDependencyString(kv.kind);
      const sourceKind = parseOptionalDependencyString(kv.source_kind);
      return {
        id: normalizeItemId(idRaw, prefix),
        kind: kindRaw ? ensureEnum(kindRaw, DEPENDENCY_KIND_VALUES, "dependency kind") : undefined,
        source_kind: sourceKind,
      };
    }
    return {
      id: normalizeItemId(trimmed, prefix),
    };
  });
}

function dependencyKey(value: Pick<Dependency, "id" | "kind" | "source_kind">): string {
  return `${value.id}::${value.kind}::${value.source_kind ?? ""}`;
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

function ensurePriority(raw: string): 0 | 1 | 2 | 3 | 4 {
  const parsed = parseOptionalNumber(raw, "priority");
  if (![0, 1, 2, 3, 4].includes(parsed)) {
    throw new PmCliError("Priority must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed as 0 | 1 | 2 | 3 | 4;
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
  mark("tags", options.tags !== undefined);
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
  mark("comment", options.comment !== undefined);
  mark("note", options.note !== undefined);
  mark("learning", options.learning !== undefined);
  mark("file", options.file !== undefined);
  mark("test", options.test !== undefined);
  mark("doc", options.doc !== undefined);
  mark("reminder", options.reminder !== undefined);
  mark("event", options.event !== undefined);
  mark("typeOption", options.typeOption !== undefined);
  mark("force", options.force === true);
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
  options = {
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
  };
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const parentReferencePolicy = settings.validation.parent_reference;
  const sprintReleasePolicy = settings.validation.sprint_release_format;
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
  if (options.parent !== undefined && !isNoneToken(options.parent)) {
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

  const changedFlags = [
    options.title !== undefined,
    options.description !== undefined,
    options.body !== undefined,
    options.status !== undefined,
    options.closeReason !== undefined,
    options.priority !== undefined,
    options.type !== undefined,
    options.tags !== undefined,
    options.deadline !== undefined,
    options.estimatedMinutes !== undefined,
    options.acceptanceCriteria !== undefined,
    options.definitionOfReady !== undefined,
    options.order !== undefined,
    options.rank !== undefined,
    options.goal !== undefined,
    options.objective !== undefined,
    options.value !== undefined,
    options.impact !== undefined,
    options.outcome !== undefined,
    options.whyNow !== undefined,
    options.assignee !== undefined,
    options.parent !== undefined,
    options.reviewer !== undefined,
    options.risk !== undefined,
    options.confidence !== undefined,
    options.sprint !== undefined,
    options.release !== undefined,
    options.blockedBy !== undefined,
    options.blockedReason !== undefined,
    options.unblockNote !== undefined,
    options.reporter !== undefined,
    options.severity !== undefined,
    options.environment !== undefined,
    options.reproSteps !== undefined,
    options.resolution !== undefined,
    options.expectedResult !== undefined,
    options.actualResult !== undefined,
    options.affectedVersion !== undefined,
    options.fixedVersion !== undefined,
    options.component !== undefined,
    options.regression !== undefined,
    options.customerImpact !== undefined,
    options.dep !== undefined,
    options.depRemove !== undefined,
    options.comment !== undefined,
    options.note !== undefined,
    options.learning !== undefined,
    options.file !== undefined,
    options.test !== undefined,
    options.doc !== undefined,
    options.reminder !== undefined,
    options.event !== undefined,
    options.typeOption !== undefined,
  ].some(Boolean);

  if (!changedFlags) {
    throw new PmCliError("No update flags provided", EXIT_CODE.USAGE);
  }
  if (options.order !== undefined && options.rank !== undefined && options.order !== options.rank) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }

  const result = await mutateItem({
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    id,
    op: "update",
    author,
    message: options.message,
    force: options.force,
    mutate(document) {
      const changedFields: string[] = [];
      const warnings: string[] = [];
      let activeTypeName = resolveTypeName(document.front_matter.type, typeRegistry) ?? document.front_matter.type;

      if (options.title !== undefined) {
        document.front_matter.title = options.title;
        changedFields.push("title");
      }
      if (options.description !== undefined) {
        document.front_matter.description = options.description;
        changedFields.push("description");
      }
      if (options.body !== undefined) {
        document.body = options.body;
        changedFields.push("body");
      }
      const previousStatus = document.front_matter.status;
      if (options.status !== undefined) {
        const status = parseStatus(options.status);
        if (status === "closed") {
          throw new PmCliError(
            'Invalid --status value "closed". Use "pm close <ID> <TEXT>" to close an item.',
            EXIT_CODE.USAGE,
          );
        }
        document.front_matter.status = status;
        if (status === "canceled") {
          delete document.front_matter.assignee;
        }
        changedFields.push("status");
      }
      if (options.closeReason !== undefined) {
        if (isNoneToken(options.closeReason)) {
          delete document.front_matter.close_reason;
        } else {
          const closeReason = options.closeReason.trim();
          if (closeReason.length === 0) {
            throw new PmCliError("--close-reason must not be empty", EXIT_CODE.USAGE);
          }
          document.front_matter.close_reason = closeReason;
        }
        changedFields.push("close_reason");
      } else if (
        options.status !== undefined &&
        previousStatus === "closed" &&
        document.front_matter.status !== "canceled" &&
        document.front_matter.close_reason !== undefined
      ) {
        delete document.front_matter.close_reason;
        changedFields.push("close_reason");
      }
      if (options.priority !== undefined) {
        document.front_matter.priority = ensurePriority(options.priority);
        changedFields.push("priority");
      }
      if (options.type !== undefined) {
        if (isNoneToken(options.type)) {
          throw new PmCliError("--type cannot be none", EXIT_CODE.USAGE);
        }
        const resolvedTypeName = resolveTypeName(options.type, typeRegistry);
        if (!resolvedTypeName) {
          throw new PmCliError(
            `Invalid type value "${options.type}". Allowed: ${typeRegistry.types.join(", ")}`,
            EXIT_CODE.USAGE,
          );
        }
        document.front_matter.type = resolvedTypeName;
        activeTypeName = resolvedTypeName;
        changedFields.push("type");
      }
      enforceUpdateOptionsByType(activeTypeName, options, typeRegistry);
      if (options.typeOption !== undefined) {
        if (options.typeOption.some((entry) => isNoneToken(entry))) {
          if (options.typeOption.length > 1) {
            throw new PmCliError("--type-option cannot mix 'none' with type option values", EXIT_CODE.USAGE);
          }
          delete document.front_matter.type_options;
        } else {
          const parsedTypeOptions = parseTypeOptionEntries(options.typeOption);
          const validation = validateTypeOptions(activeTypeName, parsedTypeOptions, typeRegistry);
          if (validation.errors.length > 0) {
            throw new PmCliError(validation.errors.join("; "), EXIT_CODE.USAGE);
          }
          document.front_matter.type_options = validation.normalized;
        }
        changedFields.push("type_options");
      } else if (options.type !== undefined && document.front_matter.type_options !== undefined) {
        const validation = validateTypeOptions(activeTypeName, document.front_matter.type_options, typeRegistry);
        if (validation.errors.length > 0) {
          throw new PmCliError(
            `Current type options are incompatible with type "${activeTypeName}". ${validation.errors.join("; ")}. Provide --type-option none to clear them.`,
            EXIT_CODE.USAGE,
          );
        }
        document.front_matter.type_options = validation.normalized;
      }
      if (options.dep !== undefined || options.depRemove !== undefined) {
        let nextDependencies = [...(document.front_matter.dependencies ?? [])];
        if (dependencyUpdates.clear) {
          nextDependencies = [];
        } else if (dependencyUpdates.additions.length > 0) {
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
          delete document.front_matter.dependencies;
        } else {
          document.front_matter.dependencies = nextDependencies;
        }
        changedFields.push("dependencies");
      }
      if (options.comment !== undefined) {
        if (commentUpdates.explicitEmpty || !commentUpdates.values || commentUpdates.values.length === 0) {
          delete document.front_matter.comments;
        } else {
          document.front_matter.comments = [...(document.front_matter.comments ?? []), ...(commentUpdates.values as Comment[])];
        }
        changedFields.push("comments");
      }
      if (options.note !== undefined) {
        if (noteUpdates.explicitEmpty || !noteUpdates.values || noteUpdates.values.length === 0) {
          delete document.front_matter.notes;
        } else {
          document.front_matter.notes = [...(document.front_matter.notes ?? []), ...(noteUpdates.values as LogNote[])];
        }
        changedFields.push("notes");
      }
      if (options.learning !== undefined) {
        if (learningUpdates.explicitEmpty || !learningUpdates.values || learningUpdates.values.length === 0) {
          delete document.front_matter.learnings;
        } else {
          document.front_matter.learnings = [...(document.front_matter.learnings ?? []), ...(learningUpdates.values as LogNote[])];
        }
        changedFields.push("learnings");
      }
      if (options.file !== undefined) {
        if (fileUpdates.explicitEmpty || !fileUpdates.values || fileUpdates.values.length === 0) {
          delete document.front_matter.files;
        } else {
          const nextFiles = [...(document.front_matter.files ?? [])];
          const seen = new Set(nextFiles.map((entry) => fileKey(entry)));
          for (const entry of fileUpdates.values) {
            const key = fileKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextFiles.push(entry);
            seen.add(key);
          }
          document.front_matter.files = nextFiles;
        }
        changedFields.push("files");
      }
      if (options.test !== undefined) {
        if (testUpdates.explicitEmpty || !testUpdates.values || testUpdates.values.length === 0) {
          delete document.front_matter.tests;
        } else {
          const nextTests = [...(document.front_matter.tests ?? [])];
          const seen = new Set(nextTests.map((entry) => testKey(entry)));
          for (const entry of testUpdates.values) {
            const key = testKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextTests.push(entry);
            seen.add(key);
          }
          document.front_matter.tests = nextTests;
        }
        changedFields.push("tests");
      }
      if (options.doc !== undefined) {
        if (docUpdates.explicitEmpty || !docUpdates.values || docUpdates.values.length === 0) {
          delete document.front_matter.docs;
        } else {
          const nextDocs = [...(document.front_matter.docs ?? [])];
          const seen = new Set(nextDocs.map((entry) => docKey(entry)));
          for (const entry of docUpdates.values) {
            const key = docKey(entry);
            if (seen.has(key)) {
              continue;
            }
            nextDocs.push(entry);
            seen.add(key);
          }
          document.front_matter.docs = nextDocs;
        }
        changedFields.push("docs");
      }
      if (options.tags !== undefined) {
        document.front_matter.tags = parseTags(options.tags);
        changedFields.push("tags");
      }
      if (options.deadline !== undefined) {
        if (isNoneToken(options.deadline)) {
          delete document.front_matter.deadline;
        } else {
          document.front_matter.deadline = resolveIsoOrRelative(options.deadline);
        }
        changedFields.push("deadline");
      }
      if (options.estimatedMinutes !== undefined) {
        if (isNoneToken(options.estimatedMinutes)) {
          delete document.front_matter.estimated_minutes;
        } else {
          document.front_matter.estimated_minutes = parseOptionalNumber(
            options.estimatedMinutes,
            "estimated-minutes",
          );
        }
        changedFields.push("estimated_minutes");
      }
      if (options.acceptanceCriteria !== undefined) {
        if (isNoneToken(options.acceptanceCriteria)) {
          delete document.front_matter.acceptance_criteria;
        } else {
          document.front_matter.acceptance_criteria = options.acceptanceCriteria;
        }
        changedFields.push("acceptance_criteria");
      }
      if (options.definitionOfReady !== undefined) {
        if (isNoneToken(options.definitionOfReady)) {
          delete document.front_matter.definition_of_ready;
        } else {
          document.front_matter.definition_of_ready = options.definitionOfReady.trim();
        }
        changedFields.push("definition_of_ready");
      }
      const orderRaw = options.order ?? options.rank;
      if (orderRaw !== undefined) {
        if (isNoneToken(orderRaw)) {
          delete document.front_matter.order;
        } else {
          const parsedOrder = parseOptionalNumber(orderRaw, "order");
          if (!Number.isInteger(parsedOrder)) {
            throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
          }
          document.front_matter.order = parsedOrder;
        }
        changedFields.push("order");
      }
      if (options.goal !== undefined) {
        if (isNoneToken(options.goal)) {
          delete document.front_matter.goal;
        } else {
          document.front_matter.goal = options.goal.trim();
        }
        changedFields.push("goal");
      }
      if (options.objective !== undefined) {
        if (isNoneToken(options.objective)) {
          delete document.front_matter.objective;
        } else {
          document.front_matter.objective = options.objective.trim();
        }
        changedFields.push("objective");
      }
      if (options.value !== undefined) {
        if (isNoneToken(options.value)) {
          delete document.front_matter.value;
        } else {
          document.front_matter.value = options.value.trim();
        }
        changedFields.push("value");
      }
      if (options.impact !== undefined) {
        if (isNoneToken(options.impact)) {
          delete document.front_matter.impact;
        } else {
          document.front_matter.impact = options.impact.trim();
        }
        changedFields.push("impact");
      }
      if (options.outcome !== undefined) {
        if (isNoneToken(options.outcome)) {
          delete document.front_matter.outcome;
        } else {
          document.front_matter.outcome = options.outcome.trim();
        }
        changedFields.push("outcome");
      }
      if (options.whyNow !== undefined) {
        if (isNoneToken(options.whyNow)) {
          delete document.front_matter.why_now;
        } else {
          document.front_matter.why_now = options.whyNow.trim();
        }
        changedFields.push("why_now");
      }
      if (options.assignee !== undefined) {
        if (isNoneToken(options.assignee) || options.assignee.trim() === "") {
          delete document.front_matter.assignee;
        } else {
          document.front_matter.assignee = options.assignee.trim();
        }
        changedFields.push("assignee");
      }
      if (options.parent !== undefined) {
        if (isNoneToken(options.parent)) {
          delete document.front_matter.parent;
        } else {
          document.front_matter.parent = resolvedParentValue as string;
        }
        changedFields.push("parent");
      }
      if (options.reviewer !== undefined) {
        if (isNoneToken(options.reviewer)) {
          delete document.front_matter.reviewer;
        } else {
          document.front_matter.reviewer = options.reviewer.trim();
        }
        changedFields.push("reviewer");
      }
      if (options.risk !== undefined) {
        if (isNoneToken(options.risk)) {
          delete document.front_matter.risk;
        } else {
          document.front_matter.risk = ensureEnum(normalizeRiskInput(options.risk), RISK_VALUES, "risk");
        }
        changedFields.push("risk");
      }
      if (options.confidence !== undefined) {
        if (isNoneToken(options.confidence)) {
          delete document.front_matter.confidence;
        } else {
          document.front_matter.confidence = parseConfidenceInput(options.confidence);
        }
        changedFields.push("confidence");
      }
      if (options.sprint !== undefined) {
        if (isNoneToken(options.sprint)) {
          delete document.front_matter.sprint;
        } else {
          const sprintValidation = validateSprintOrReleaseValue("sprint", options.sprint, sprintReleasePolicy);
          document.front_matter.sprint = sprintValidation.value;
          warnings.push(...sprintValidation.warnings);
        }
        changedFields.push("sprint");
      }
      if (options.release !== undefined) {
        if (isNoneToken(options.release)) {
          delete document.front_matter.release;
        } else {
          const releaseValidation = validateSprintOrReleaseValue("release", options.release, sprintReleasePolicy);
          document.front_matter.release = releaseValidation.value;
          warnings.push(...releaseValidation.warnings);
        }
        changedFields.push("release");
      }
      if (options.blockedBy !== undefined) {
        if (isNoneToken(options.blockedBy)) {
          delete document.front_matter.blocked_by;
        } else {
          document.front_matter.blocked_by = options.blockedBy.trim();
        }
        changedFields.push("blocked_by");
      }
      if (options.blockedReason !== undefined) {
        if (isNoneToken(options.blockedReason)) {
          delete document.front_matter.blocked_reason;
        } else {
          document.front_matter.blocked_reason = options.blockedReason.trim();
        }
        changedFields.push("blocked_reason");
      }
      if (options.unblockNote !== undefined) {
        if (isNoneToken(options.unblockNote)) {
          delete document.front_matter.unblock_note;
        } else {
          document.front_matter.unblock_note = options.unblockNote.trim();
        }
        changedFields.push("unblock_note");
      }
      if (options.reporter !== undefined) {
        if (isNoneToken(options.reporter)) {
          delete document.front_matter.reporter;
        } else {
          document.front_matter.reporter = options.reporter.trim();
        }
        changedFields.push("reporter");
      }
      if (options.severity !== undefined) {
        if (isNoneToken(options.severity)) {
          delete document.front_matter.severity;
        } else {
          document.front_matter.severity = ensureEnum(normalizeSeverityInput(options.severity), ISSUE_SEVERITY_VALUES, "severity");
        }
        changedFields.push("severity");
      }
      if (options.environment !== undefined) {
        if (isNoneToken(options.environment)) {
          delete document.front_matter.environment;
        } else {
          document.front_matter.environment = options.environment.trim();
        }
        changedFields.push("environment");
      }
      if (options.reproSteps !== undefined) {
        if (isNoneToken(options.reproSteps)) {
          delete document.front_matter.repro_steps;
        } else {
          document.front_matter.repro_steps = options.reproSteps.trim();
        }
        changedFields.push("repro_steps");
      }
      if (options.resolution !== undefined) {
        if (isNoneToken(options.resolution)) {
          delete document.front_matter.resolution;
        } else {
          document.front_matter.resolution = options.resolution.trim();
        }
        changedFields.push("resolution");
      }
      if (options.expectedResult !== undefined) {
        if (isNoneToken(options.expectedResult)) {
          delete document.front_matter.expected_result;
        } else {
          document.front_matter.expected_result = options.expectedResult.trim();
        }
        changedFields.push("expected_result");
      }
      if (options.actualResult !== undefined) {
        if (isNoneToken(options.actualResult)) {
          delete document.front_matter.actual_result;
        } else {
          document.front_matter.actual_result = options.actualResult.trim();
        }
        changedFields.push("actual_result");
      }
      if (options.affectedVersion !== undefined) {
        if (isNoneToken(options.affectedVersion)) {
          delete document.front_matter.affected_version;
        } else {
          document.front_matter.affected_version = options.affectedVersion.trim();
        }
        changedFields.push("affected_version");
      }
      if (options.fixedVersion !== undefined) {
        if (isNoneToken(options.fixedVersion)) {
          delete document.front_matter.fixed_version;
        } else {
          document.front_matter.fixed_version = options.fixedVersion.trim();
        }
        changedFields.push("fixed_version");
      }
      if (options.component !== undefined) {
        if (isNoneToken(options.component)) {
          delete document.front_matter.component;
        } else {
          document.front_matter.component = options.component.trim();
        }
        changedFields.push("component");
      }
      if (options.regression !== undefined) {
        if (isNoneToken(options.regression)) {
          delete document.front_matter.regression;
        } else {
          document.front_matter.regression = parseRegressionInput(options.regression);
        }
        changedFields.push("regression");
      }
      if (options.customerImpact !== undefined) {
        if (isNoneToken(options.customerImpact)) {
          delete document.front_matter.customer_impact;
        } else {
          document.front_matter.customer_impact = options.customerImpact.trim();
        }
        changedFields.push("customer_impact");
      }
      if (options.reminder !== undefined) {
        if (options.reminder.some((entry) => isNoneToken(entry))) {
          if (options.reminder.length > 1) {
            throw new PmCliError("--reminder cannot mix 'none' with reminder values", EXIT_CODE.USAGE);
          }
          delete document.front_matter.reminders;
        } else {
          document.front_matter.reminders = parseReminderEntries(options.reminder, nowValue);
        }
        changedFields.push("reminders");
      }
      if (options.event !== undefined) {
        if (options.event.some((entry) => isNoneToken(entry))) {
          if (options.event.length > 1) {
            throw new PmCliError("--event cannot mix 'none' with event values", EXIT_CODE.USAGE);
          }
          delete document.front_matter.events;
        } else {
          document.front_matter.events = parseEventEntries(options.event, nowValue);
        }
        changedFields.push("events");
      }

      try {
        applyRegisteredItemFieldDefaultsAndValidation(
          document.front_matter as unknown as Record<string, unknown>,
          getActiveExtensionRegistrations(),
        );
      } catch (error: unknown) {
        throw new PmCliError(error instanceof Error ? error.message : "Invalid extension item field values", EXIT_CODE.USAGE);
      }

      return { changedFields, warnings };
    },
  });

  return {
    item: result.item as unknown as Record<string, unknown>,
    changed_fields: result.changedFields,
    warnings: [...parentReferenceWarnings, ...result.warnings],
  };
}
