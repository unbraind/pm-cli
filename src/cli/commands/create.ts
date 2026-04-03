import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import {
  normalizeParentReferenceValue,
  validateMissingParentReference,
} from "../../core/item/parent-reference-policy.js";
import { validateSprintOrReleaseValue } from "../../core/item/sprint-release-format.js";
import { createStdinTokenResolver, parseCsvKv, parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import { normalizeStatusInput } from "../../core/item/status.js";
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
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isNoneToken, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { applyRegisteredItemFieldDefaultsAndValidation } from "../../core/extensions/item-fields.js";
import { locateItem } from "../../core/store/item-store.js";
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { loadCreateTemplateOptions } from "./templates.js";
import type {
  CalendarEvent,
  Comment,
  Dependency,
  ItemDocument,
  ItemFrontMatter,
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
  SCOPE_VALUES,
  STATUS_VALUES,
} from "../../types/index.js";

export interface CreateCommandOptions {
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  tags?: string;
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
  template?: string;
  createMode?: string;
}

export interface CreateResult {
  item: ItemFrontMatter;
  changed_fields: string[];
  warnings: string[];
}

type CreateMode = "strict" | "progressive";
const CREATE_MODE_VALUES = ["strict", "progressive"] as const;

function ensureEnumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(
      `Invalid ${label} value "${value}". Allowed: ${allowed.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return value as T;
}

function parseStatusValue(value: string): ItemStatus {
  const normalized = normalizeStatusInput(value);
  if (!normalized) {
    throw new PmCliError(`Invalid status value "${value}". Allowed: ${STATUS_VALUES.join(", ")}`, EXIT_CODE.USAGE);
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

function parseOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (isNoneToken(value)) return undefined;
  return value;
}

function weekdayOrderIndex(value: (typeof RECURRENCE_WEEKDAY_VALUES)[number]): number {
  return RECURRENCE_WEEKDAY_VALUES.indexOf(value);
}

function parseDependencies(
  raw: string[] | undefined,
  nowValue: string,
  prefix: string,
): { values: Dependency[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--dep cannot mix 'none' with dependency values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values: Dependency[] = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--dep");
    const id = kv.id;
    const kind = kv.kind;
    if (!id || !kind) {
      throw new PmCliError("--dep requires id and kind", EXIT_CODE.USAGE);
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

function parseLogSeed(
  optionName: "--comment" | "--note" | "--learning",
  raw: string[] | undefined,
  nowValue: string,
  fallbackAuthor: string,
): { values: LogNote[] | Comment[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError(`${optionName} cannot mix 'none' with seed values`, EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, optionName);
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

function parseFiles(raw: string[] | undefined): { values: LinkedFile[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--file cannot mix 'none' with file values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--file");
    if (!kv.path) {
      throw new PmCliError("--file requires path=<value>", EXIT_CODE.USAGE);
    }
    return {
      path: kv.path,
      scope: ensureEnumValue(kv.scope ?? "project", SCOPE_VALUES, "file scope"),
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseTests(raw: string[] | undefined): { values: LinkedTest[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--test cannot mix 'none' with test values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--test");
    const command = parseOptionalString(kv.command);
    const filePath = parseOptionalString(kv.path);
    if (!command) {
      throw new PmCliError("--test requires command=<value> (path=<value> is optional metadata)", EXIT_CODE.USAGE);
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
      note: parseOptionalString(kv.note),
    };
  });
  return { values, explicitEmpty: false };
}

function parseDocs(raw: string[] | undefined): { values: LinkedDoc[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--doc cannot mix 'none' with doc values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--doc");
    if (!kv.path) {
      throw new PmCliError("--doc requires path=<value>", EXIT_CODE.USAGE);
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
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--reminder cannot mix 'none' with reminder values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--reminder");
    const atRaw = parseOptionalString(kv.at);
    const textRaw = parseOptionalString(kv.text);
    if (!atRaw || !textRaw) {
      throw new PmCliError("--reminder requires at=<iso|relative> and text=<value>", EXIT_CODE.USAGE);
    }
    const text = textRaw.trim();
    if (!text) {
      throw new PmCliError("--reminder text must not be empty", EXIT_CODE.USAGE);
    }
    return {
      at: resolveIsoOrRelative(atRaw, new Date(nowValue)),
      text,
    };
  });
  return { values, explicitEmpty: false };
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
  const freqRaw = parseOptionalString(kv.recur_freq)?.trim();
  const intervalRaw = parseOptionalString(kv.recur_interval)?.trim();
  const countRaw = parseOptionalString(kv.recur_count)?.trim();
  const untilRaw = parseOptionalString(kv.recur_until)?.trim();
  const byWeekdayRaw = parseOptionalString(kv.recur_by_weekday)?.trim();
  const byMonthDayRaw = parseOptionalString(kv.recur_by_month_day)?.trim();
  const exdatesRaw = parseOptionalString(kv.recur_exdates)?.trim();

  const recurrenceInputsProvided = [freqRaw, intervalRaw, countRaw, untilRaw, byWeekdayRaw, byMonthDayRaw, exdatesRaw].some(
    (value) => value !== undefined,
  );
  if (!recurrenceInputsProvided) {
    return undefined;
  }
  if (!freqRaw) {
    throw new PmCliError("--event recurrence fields require recur_freq=<daily|weekly|monthly|yearly>", EXIT_CODE.USAGE);
  }

  const freq = ensureEnumValue(freqRaw.toLowerCase(), RECURRENCE_FREQUENCY_VALUES, "event recurrence frequency");
  const interval = intervalRaw !== undefined ? parseOptionalNumber(intervalRaw, "event recur_interval") : undefined;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 1)) {
    throw new PmCliError("--event recur_interval must be an integer >= 1", EXIT_CODE.USAGE);
  }
  const count = countRaw !== undefined ? parseOptionalNumber(countRaw, "event recur_count") : undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    throw new PmCliError("--event recur_count must be an integer >= 1", EXIT_CODE.USAGE);
  }
  const until = untilRaw ? resolveIsoOrRelative(untilRaw, nowValue) : undefined;
  if (until && until < startAt) {
    throw new PmCliError("--event recur_until must be at or after start", EXIT_CODE.USAGE);
  }

  const byWeekday = Array.from(
    new Set(
      parseDelimitedList(byWeekdayRaw).map((value) => ensureEnumValue(value.toLowerCase(), RECURRENCE_WEEKDAY_VALUES, "event weekday")),
    ),
  ).sort(
    (left, right) =>
      weekdayOrderIndex(left as (typeof RECURRENCE_WEEKDAY_VALUES)[number]) -
      weekdayOrderIndex(right as (typeof RECURRENCE_WEEKDAY_VALUES)[number]),
  );

  const byMonthDay = Array.from(
    new Set(
      parseDelimitedList(byMonthDayRaw).map((value) => {
        const day = parseOptionalNumber(value, "event recur_by_month_day");
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          throw new PmCliError("--event recur_by_month_day values must be integers 1..31", EXIT_CODE.USAGE);
        }
        return day;
      }),
    ),
  ).sort((left, right) => left - right);

  const exdates = Array.from(new Set(parseDelimitedList(exdatesRaw).map((value) => resolveIsoOrRelative(value, nowValue)))).sort(
    (left, right) => left.localeCompare(right),
  );

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

function parseEvents(raw: string[] | undefined, nowValue: string): { values: CalendarEvent[] | undefined; explicitEmpty: boolean } {
  if (!raw || raw.length === 0) return { values: undefined, explicitEmpty: false };
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--event cannot mix 'none' with event values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
  const referenceDate = new Date(nowValue);
  const values = raw.map((entry) => {
    const kv = parseCsvKv(entry, "--event");
    const startRaw = parseOptionalString(kv.start)?.trim();
    if (!startRaw) {
      throw new PmCliError("--event requires start=<iso|relative>", EXIT_CODE.USAGE);
    }
    const startAt = resolveIsoOrRelative(startRaw, referenceDate);
    const endRaw = parseOptionalString(kv.end)?.trim();
    const endAt = endRaw ? resolveIsoOrRelative(endRaw, referenceDate) : undefined;
    if (endAt && endAt <= startAt) {
      throw new PmCliError("--event end must be after start", EXIT_CODE.USAGE);
    }

    const titleRaw = parseOptionalString(kv.title);
    const descriptionRaw = parseOptionalString(kv.description);
    const locationRaw = parseOptionalString(kv.location);
    const timezoneRaw = parseOptionalString(kv.timezone);
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

    const allDayRaw = parseOptionalString(kv.all_day)?.trim();
    const recurrence = parseRecurrenceRule(kv, startAt, referenceDate);

    return {
      start_at: startAt,
      end_at: endAt,
      title,
      description,
      location,
      all_day: allDayRaw !== undefined ? parseEventBoolean(allDayRaw, "--event all_day") : undefined,
      timezone,
      recurrence,
    };
  });
  return { values, explicitEmpty: false };
}

function buildChangedFields(frontMatter: ItemFrontMatter, explicitUnsets: string[]): string[] {
  const changed = [
    ...FRONT_MATTER_KEY_ORDER.filter((key) => frontMatter[key] !== undefined),
    "body",
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
  if (raw.some((entry) => isNoneToken(entry))) {
    if (raw.length > 1) {
      throw new PmCliError("--type-option cannot mix 'none' with option values", EXIT_CODE.USAGE);
    }
    return { values: undefined, explicitEmpty: true };
  }
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
      key = parseOptionalString(kv.key)?.trim();
      value = parseOptionalString(kv.value)?.trim();
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
  const sortedEntries = Object.entries(values).sort((left, right) => left[0].localeCompare(right[0]));
  return {
    values: Object.fromEntries(sortedEntries),
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
  };
}

function resolveCreateMode(createMode: string | undefined): CreateMode {
  if (createMode === undefined) {
    return "strict";
  }
  const normalized = createMode.trim().toLowerCase();
  if (normalized.length === 0) {
    return "strict";
  }
  if (normalized === "strict" || normalized === "progressive") {
    return normalized;
  }
  throw new PmCliError(
    `Invalid --create-mode value "${createMode}". Allowed: ${CREATE_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function requireCreateOptionByType(
  typeDefinition: ResolvedItemTypeDefinition,
  options: CreateCommandOptions,
  createMode: CreateMode,
): void {
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
  };

  const hasOptionValue = (optionKey: string): boolean => {
    if (optionKey in scalarValues) {
      return scalarValues[optionKey] !== undefined;
    }
    if (optionKey in repeatableValues) {
      const value = repeatableValues[optionKey];
      return Array.isArray(value) && value.length > 0;
    }
    return false;
  };

  const baseRequiredOptions = new Set<string>(["title", "description", "type"]);
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
    if (hasOptionValue(option)) {
      throw new PmCliError(
        `Option ${commandOptionFlagLabel("create", option)} is disabled for type "${typeName}" by command_option_policies`,
        EXIT_CODE.USAGE,
      );
    }
  }

  const missingRequiredOptions = policyState.required.filter((required) => !hasOptionValue(required));
  if (missingRequiredOptions.length > 0) {
    const missingFlags = [...new Set(missingRequiredOptions.map((required) => commandOptionFlagLabel("create", required)))]
      .sort((left, right) => left.localeCompare(right));
    if (missingFlags.length === 1) {
      throw new PmCliError(`Missing required option ${missingFlags[0]} for type "${typeName}"`, EXIT_CODE.USAGE);
    }
    throw new PmCliError(`Missing required options ${missingFlags.join(", ")} for type "${typeName}"`, EXIT_CODE.USAGE);
  }
}

function requireStringOption(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new PmCliError(`Missing required option ${flag}`, EXIT_CODE.USAGE);
  }
  return value;
}

function selectAuthor(explicitAuthor: string | undefined, settingsAuthor: string): string {
  const candidate = parseOptionalString(explicitAuthor) ?? process.env.PM_AUTHOR ?? settingsAuthor;
  const trimmed = candidate.trim();
  return trimmed || "unknown";
}

function ensurePriority(rawPriority: string): 0 | 1 | 2 | 3 | 4 {
  const parsed = parseOptionalNumber(rawPriority, "priority");
  if (![0, 1, 2, 3, 4].includes(parsed)) {
    throw new PmCliError("Priority must be one of 0, 1, 2, 3, or 4", EXIT_CODE.USAGE);
  }
  return parsed as 0 | 1 | 2 | 3 | 4;
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

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    if (!exists) {
      throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
    }
  });
}

export async function runCreate(options: CreateCommandOptions, global: GlobalOptions): Promise<CreateResult> {
  let resolvedOptions = await resolveCreateStdinInputs(options);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  if (resolvedOptions.template !== undefined && !isNoneToken(resolvedOptions.template)) {
    const templateName = resolvedOptions.template.trim();
    if (templateName.length === 0) {
      throw new PmCliError("--template must not be empty. Use --template none to disable template usage.", EXIT_CODE.USAGE);
    }
    const templateOptions = await loadCreateTemplateOptions(pmRoot, templateName);
    resolvedOptions = mergeCreateOptionsWithTemplate(templateOptions, resolvedOptions);
  }
  if (resolvedOptions.type === undefined) {
    throw new PmCliError("Missing required option --type", EXIT_CODE.USAGE);
  }
  const resolvedTypeName = resolveTypeName(resolvedOptions.type, typeRegistry);
  if (!resolvedTypeName) {
    throw new PmCliError(
      `Invalid type value "${resolvedOptions.type}". Allowed: ${typeRegistry.types.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  const typeDefinition = resolveTypeDefinition(resolvedTypeName, typeRegistry);
  if (!typeDefinition) {
    throw new PmCliError(`Invalid type value "${resolvedOptions.type}"`, EXIT_CODE.USAGE);
  }
  const createMode = resolveCreateMode(resolvedOptions.createMode);
  requireCreateOptionByType(typeDefinition, resolvedOptions, createMode);
  const nowValue = nowIso();
  const author = selectAuthor(resolvedOptions.author, settings.author_default);
  const explicitUnsets: string[] = [];

  const dependencies = parseDependencies(resolvedOptions.dep, nowValue, settings.id_prefix);
  if (dependencies.explicitEmpty) explicitUnsets.push("dependencies");
  const comments = parseLogSeed("--comment", resolvedOptions.comment, nowValue, author);
  if (comments.explicitEmpty) explicitUnsets.push("comments");
  const notes = parseLogSeed("--note", resolvedOptions.note, nowValue, author);
  if (notes.explicitEmpty) explicitUnsets.push("notes");
  const learnings = parseLogSeed("--learning", resolvedOptions.learning, nowValue, author);
  if (learnings.explicitEmpty) explicitUnsets.push("learnings");
  const files = parseFiles(resolvedOptions.file);
  if (files.explicitEmpty) explicitUnsets.push("files");
  const tests = parseTests(resolvedOptions.test);
  if (tests.explicitEmpty) explicitUnsets.push("tests");
  const docs = parseDocs(resolvedOptions.doc);
  if (docs.explicitEmpty) explicitUnsets.push("docs");
  const reminders = parseReminders(resolvedOptions.reminder, nowValue);
  if (reminders.explicitEmpty) explicitUnsets.push("reminders");
  const events = parseEvents(resolvedOptions.event, nowValue);
  if (events.explicitEmpty) explicitUnsets.push("events");
  const typeOptions = parseTypeOptions(resolvedOptions.typeOption);
  if (typeOptions.explicitEmpty) explicitUnsets.push("type_options");

  const scalarExplicitUnsetCandidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [resolvedOptions.deadline, "deadline"],
    [resolvedOptions.estimatedMinutes, "estimated_minutes"],
    [resolvedOptions.acceptanceCriteria, "acceptance_criteria"],
    [resolvedOptions.definitionOfReady, "definition_of_ready"],
    [resolvedOptions.order, "order"],
    [resolvedOptions.rank, "order"],
    [resolvedOptions.goal, "goal"],
    [resolvedOptions.objective, "objective"],
    [resolvedOptions.value, "value"],
    [resolvedOptions.impact, "impact"],
    [resolvedOptions.outcome, "outcome"],
    [resolvedOptions.whyNow, "why_now"],
    [resolvedOptions.assignee, "assignee"],
    [resolvedOptions.author, "author"],
    [resolvedOptions.parent, "parent"],
    [resolvedOptions.reviewer, "reviewer"],
    [resolvedOptions.risk, "risk"],
    [resolvedOptions.confidence, "confidence"],
    [resolvedOptions.sprint, "sprint"],
    [resolvedOptions.release, "release"],
    [resolvedOptions.blockedBy, "blocked_by"],
    [resolvedOptions.blockedReason, "blocked_reason"],
    [resolvedOptions.unblockNote, "unblock_note"],
    [resolvedOptions.reporter, "reporter"],
    [resolvedOptions.severity, "severity"],
    [resolvedOptions.environment, "environment"],
    [resolvedOptions.reproSteps, "repro_steps"],
    [resolvedOptions.resolution, "resolution"],
    [resolvedOptions.expectedResult, "expected_result"],
    [resolvedOptions.actualResult, "actual_result"],
    [resolvedOptions.affectedVersion, "affected_version"],
    [resolvedOptions.fixedVersion, "fixed_version"],
    [resolvedOptions.component, "component"],
    [resolvedOptions.regression, "regression"],
    [resolvedOptions.customerImpact, "customer_impact"],
  ];
  for (const [value, key] of scalarExplicitUnsetCandidates) {
    if (isNoneToken(value)) {
      explicitUnsets.push(key);
    }
  }

  const id = await generateItemId(pmRoot, settings.id_prefix);
  const type = typeDefinition.name;
  const status = resolvedOptions.status !== undefined ? parseStatusValue(resolvedOptions.status) : "open";
  const priority = resolvedOptions.priority !== undefined ? ensurePriority(resolvedOptions.priority) : 2;
  const tags = resolvedOptions.tags !== undefined ? parseTags(resolvedOptions.tags) : [];

  const deadline =
    resolvedOptions.deadline === undefined || isNoneToken(resolvedOptions.deadline)
      ? undefined
      : resolveIsoOrRelative(resolvedOptions.deadline, new Date(nowValue));
  const estimatedMinutes =
    resolvedOptions.estimatedMinutes === undefined || isNoneToken(resolvedOptions.estimatedMinutes)
      ? undefined
      : parseOptionalNumber(resolvedOptions.estimatedMinutes, "estimated-minutes");
  const acceptanceCriteria =
    resolvedOptions.acceptanceCriteria === undefined || isNoneToken(resolvedOptions.acceptanceCriteria)
      ? undefined
      : resolvedOptions.acceptanceCriteria;
  const definitionOfReady =
    resolvedOptions.definitionOfReady !== undefined ? parseOptionalString(resolvedOptions.definitionOfReady) : undefined;
  if (
    resolvedOptions.order !== undefined &&
    resolvedOptions.rank !== undefined &&
    resolvedOptions.order !== resolvedOptions.rank
  ) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }
  const orderRaw = resolvedOptions.order ?? resolvedOptions.rank;
  const order = orderRaw === undefined || isNoneToken(orderRaw) ? undefined : parseOptionalNumber(orderRaw, "order");
  if (order !== undefined && !Number.isInteger(order)) {
    throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
  }
  const goal = resolvedOptions.goal !== undefined ? parseOptionalString(resolvedOptions.goal) : undefined;
  const objective = resolvedOptions.objective !== undefined ? parseOptionalString(resolvedOptions.objective) : undefined;
  const value = resolvedOptions.value !== undefined ? parseOptionalString(resolvedOptions.value) : undefined;
  const impact = resolvedOptions.impact !== undefined ? parseOptionalString(resolvedOptions.impact) : undefined;
  const outcome = resolvedOptions.outcome !== undefined ? parseOptionalString(resolvedOptions.outcome) : undefined;
  const whyNow = resolvedOptions.whyNow !== undefined ? parseOptionalString(resolvedOptions.whyNow) : undefined;
  const assignee = resolvedOptions.assignee !== undefined ? parseOptionalString(resolvedOptions.assignee) : undefined;
  const authorValue = parseOptionalString(resolvedOptions.author) ?? author;
  let parent = resolvedOptions.parent !== undefined ? parseOptionalString(resolvedOptions.parent) : undefined;
  const reviewer = resolvedOptions.reviewer !== undefined ? parseOptionalString(resolvedOptions.reviewer) : undefined;
  const riskRaw = resolvedOptions.risk !== undefined ? parseOptionalString(resolvedOptions.risk) : undefined;
  const risk = riskRaw !== undefined ? ensureEnumValue(normalizeRiskInput(riskRaw), RISK_VALUES, "risk") : undefined;
  const confidenceRaw = resolvedOptions.confidence !== undefined ? parseOptionalString(resolvedOptions.confidence) : undefined;
  const confidence = confidenceRaw !== undefined ? parseConfidenceInput(confidenceRaw) : undefined;
  const parentReferencePolicy = settings.validation.parent_reference;
  const sprintReleasePolicy = settings.validation.sprint_release_format;
  const validationWarnings: string[] = [];
  if (parent !== undefined) {
    parent = normalizeParentReferenceValue(parent);
    const parentLocated = await locateItem(pmRoot, parent, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!parentLocated) {
      const normalizedParentId = normalizeItemId(parent, settings.id_prefix);
      validationWarnings.push(...validateMissingParentReference(normalizedParentId, parentReferencePolicy).warnings);
    }
  }
  let sprint = resolvedOptions.sprint !== undefined ? parseOptionalString(resolvedOptions.sprint) : undefined;
  if (sprint !== undefined) {
    const sprintValidation = validateSprintOrReleaseValue("sprint", sprint, sprintReleasePolicy);
    sprint = sprintValidation.value;
    validationWarnings.push(...sprintValidation.warnings);
  }
  let release = resolvedOptions.release !== undefined ? parseOptionalString(resolvedOptions.release) : undefined;
  if (release !== undefined) {
    const releaseValidation = validateSprintOrReleaseValue("release", release, sprintReleasePolicy);
    release = releaseValidation.value;
    validationWarnings.push(...releaseValidation.warnings);
  }
  const blockedBy = resolvedOptions.blockedBy !== undefined ? parseOptionalString(resolvedOptions.blockedBy) : undefined;
  const blockedReason =
    resolvedOptions.blockedReason !== undefined ? parseOptionalString(resolvedOptions.blockedReason) : undefined;
  const unblockNote = resolvedOptions.unblockNote !== undefined ? parseOptionalString(resolvedOptions.unblockNote) : undefined;
  const reporter = resolvedOptions.reporter !== undefined ? parseOptionalString(resolvedOptions.reporter) : undefined;
  const severityRaw = resolvedOptions.severity !== undefined ? parseOptionalString(resolvedOptions.severity) : undefined;
  const severity =
    severityRaw !== undefined ? ensureEnumValue(normalizeSeverityInput(severityRaw), ISSUE_SEVERITY_VALUES, "severity") : undefined;
  const environment = resolvedOptions.environment !== undefined ? parseOptionalString(resolvedOptions.environment) : undefined;
  const reproSteps = resolvedOptions.reproSteps !== undefined ? parseOptionalString(resolvedOptions.reproSteps) : undefined;
  const resolution = resolvedOptions.resolution !== undefined ? parseOptionalString(resolvedOptions.resolution) : undefined;
  const expectedResult =
    resolvedOptions.expectedResult !== undefined ? parseOptionalString(resolvedOptions.expectedResult) : undefined;
  const actualResult = resolvedOptions.actualResult !== undefined ? parseOptionalString(resolvedOptions.actualResult) : undefined;
  const affectedVersion =
    resolvedOptions.affectedVersion !== undefined ? parseOptionalString(resolvedOptions.affectedVersion) : undefined;
  const fixedVersion =
    resolvedOptions.fixedVersion !== undefined ? parseOptionalString(resolvedOptions.fixedVersion) : undefined;
  const component = resolvedOptions.component !== undefined ? parseOptionalString(resolvedOptions.component) : undefined;
  const regressionRaw = resolvedOptions.regression !== undefined ? parseOptionalString(resolvedOptions.regression) : undefined;
  const regression = regressionRaw !== undefined ? parseRegressionInput(regressionRaw) : undefined;
  const customerImpact =
    resolvedOptions.customerImpact !== undefined ? parseOptionalString(resolvedOptions.customerImpact) : undefined;
  const validatedTypeOptions = validateTypeOptions(type, typeOptions.values, typeRegistry);
  if (validatedTypeOptions.errors.length > 0) {
    throw new PmCliError(validatedTypeOptions.errors.join("; "), EXIT_CODE.USAGE);
  }
  const title = requireStringOption(resolvedOptions.title, "--title");
  const description = requireStringOption(resolvedOptions.description, "--description");
  const body = resolvedOptions.body ?? "";

  const frontMatter: ItemFrontMatter = normalizeFrontMatter({
    id,
    title,
    description,
    type,
    type_options: validatedTypeOptions.normalized,
    status,
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
    dependencies: dependencies.values,
    comments: comments.values as Comment[] | undefined,
    notes: notes.values as LogNote[] | undefined,
    learnings: learnings.values as LogNote[] | undefined,
    files: files.values,
    tests: tests.values,
    docs: docs.values,
    reminders: reminders.values,
    events: events.values,
  });
  try {
    applyRegisteredItemFieldDefaultsAndValidation(
      frontMatter as unknown as Record<string, unknown>,
      getActiveExtensionRegistrations(),
    );
  } catch (error: unknown) {
    throw new PmCliError(error instanceof Error ? error.message : "Invalid extension item field values", EXIT_CODE.USAGE);
  }

  const afterDocument: ItemDocument = canonicalDocument({
    front_matter: frontMatter,
    body,
  });
  const beforeDocument: ItemDocument = {
    front_matter: {} as ItemFrontMatter,
    body: "",
  };

  const itemPath = getItemPath(pmRoot, type, id, settings.item_format, typeRegistry.type_to_folder);
  const historyPath = getHistoryPath(pmRoot, id);
  const lockRelease = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author);
  const historyMessage = buildHistoryMessage(resolvedOptions.message, explicitUnsets);
  let hookWarnings: string[] = [];

  try {
    await writeFileAtomic(itemPath, serializeItemDocument(afterDocument, { format: settings.item_format }));
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
      })),
      ...(await runActiveOnWriteHooks({
        path: historyPath,
        scope: "project",
        op: "create:history",
      })),
    ];
  } finally {
    await lockRelease();
  }

  const changedFields = buildChangedFields(frontMatter, explicitUnsets);
  const outputItem = structuredClone(frontMatter);
  return {
    item: outputItem,
    changed_fields: changedFields,
    warnings: [...validationWarnings, ...hookWarnings],
  };
}
