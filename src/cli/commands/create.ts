import { pathExists, removeFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { appendHistoryEntry, createHistoryEntry } from "../../core/history/history.js";
import { generateItemId, normalizeItemId } from "../../core/item/id.js";
import { canonicalDocument, normalizeFrontMatter, serializeItemDocument } from "../../core/item/item-format.js";
import { parseCsvKv, parseOptionalNumber, parseTags } from "../../core/item/parse.js";
import {
  resolveItemTypeRegistry,
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
import { getHistoryPath, getItemPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  CalendarEvent,
  Comment,
  Dependency,
  ItemDocument,
  ItemFrontMatter,
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
  type: string;
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
}

export interface CreateResult {
  item: ItemFrontMatter;
  changed_fields: string[];
  warnings: string[];
}

function ensureEnumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(
      `Invalid ${label} value "${value}". Allowed: ${allowed.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return value as T;
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
    if (!command && !filePath) {
      throw new PmCliError("--test requires command=<value> and/or path=<value>", EXIT_CODE.USAGE);
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

const CREATE_FIELD_FLAG_BY_KEY: Record<string, string> = {
  title: "--title",
  description: "--description",
  type: "--type",
  status: "--status",
  priority: "--priority",
  tags: "--tags",
  body: "--body",
  deadline: "--deadline",
  estimatedMinutes: "--estimate/--estimated-minutes",
  acceptanceCriteria: "--acceptance-criteria/--ac",
  author: "--author",
  message: "--message",
  assignee: "--assignee",
};

const CREATE_REPEATABLE_FLAG_BY_KEY: Record<string, string> = {
  dep: "--dep",
  comment: "--comment",
  note: "--note",
  learning: "--learning",
  file: "--file",
  test: "--test",
  doc: "--doc",
  reminder: "--reminder",
  event: "--event",
  typeOption: "--type-option",
};

const CREATE_FIELD_KEY_ALIASES: Record<string, string> = {
  estimated_minutes: "estimatedMinutes",
  acceptance_criteria: "acceptanceCriteria",
};

const CREATE_REPEATABLE_KEY_ALIASES: Record<string, string> = {
  type_options: "typeOption",
};

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
    if (trimmedEntry.includes(",")) {
      const kv = parseCsvKv(trimmedEntry, "--type-option");
      key = parseOptionalString(kv.key)?.trim();
      value = parseOptionalString(kv.value)?.trim();
    } else {
      const separatorIndex = trimmedEntry.indexOf("=");
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

function requireCreateOptionByType(
  typeName: string,
  options: CreateCommandOptions,
  requiredFields: string[],
  requiredRepeatables: string[],
): void {
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
    author: options.author,
    message: options.message,
    assignee: options.assignee,
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

  for (const field of requiredFields) {
    const normalizedField = CREATE_FIELD_KEY_ALIASES[field] ?? field;
    const flag = CREATE_FIELD_FLAG_BY_KEY[normalizedField];
    if (!flag) {
      throw new PmCliError(
        `Unsupported required_create_fields entry "${field}" for type "${typeName}"`,
        EXIT_CODE.CONFLICT,
      );
    }
    if (scalarValues[normalizedField] === undefined) {
      throw new PmCliError(`Missing required option ${flag} for type "${typeName}"`, EXIT_CODE.USAGE);
    }
  }
  for (const field of requiredRepeatables) {
    const normalizedField = CREATE_REPEATABLE_KEY_ALIASES[field] ?? field;
    const flag = CREATE_REPEATABLE_FLAG_BY_KEY[normalizedField];
    if (!flag) {
      throw new PmCliError(
        `Unsupported required_create_repeatables entry "${field}" for type "${typeName}"`,
        EXIT_CODE.CONFLICT,
      );
    }
    const value = repeatableValues[normalizedField];
    if (!Array.isArray(value) || value.length === 0) {
      throw new PmCliError(`Missing required repeatable option ${flag} for type "${typeName}"`, EXIT_CODE.USAGE);
    }
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

function ensureInitHasRun(pmRoot: string): Promise<void> {
  return pathExists(getSettingsPath(pmRoot)).then((exists) => {
    if (!exists) {
      throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
    }
  });
}

export async function runCreate(options: CreateCommandOptions, global: GlobalOptions): Promise<CreateResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await ensureInitHasRun(pmRoot);

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const resolvedTypeName = resolveTypeName(options.type, typeRegistry);
  if (!resolvedTypeName) {
    throw new PmCliError(
      `Invalid type value "${options.type}". Allowed: ${typeRegistry.types.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  const typeDefinition = resolveTypeDefinition(resolvedTypeName, typeRegistry);
  if (!typeDefinition) {
    throw new PmCliError(`Invalid type value "${options.type}"`, EXIT_CODE.USAGE);
  }
  requireCreateOptionByType(
    typeDefinition.name,
    options,
    typeDefinition.required_create_fields,
    typeDefinition.required_create_repeatables,
  );
  const nowValue = nowIso();
  const author = selectAuthor(options.author, settings.author_default);
  const explicitUnsets: string[] = [];

  const dependencies = parseDependencies(options.dep, nowValue, settings.id_prefix);
  if (dependencies.explicitEmpty) explicitUnsets.push("dependencies");
  const comments = parseLogSeed("--comment", options.comment, nowValue, author);
  if (comments.explicitEmpty) explicitUnsets.push("comments");
  const notes = parseLogSeed("--note", options.note, nowValue, author);
  if (notes.explicitEmpty) explicitUnsets.push("notes");
  const learnings = parseLogSeed("--learning", options.learning, nowValue, author);
  if (learnings.explicitEmpty) explicitUnsets.push("learnings");
  const files = parseFiles(options.file);
  if (files.explicitEmpty) explicitUnsets.push("files");
  const tests = parseTests(options.test);
  if (tests.explicitEmpty) explicitUnsets.push("tests");
  const docs = parseDocs(options.doc);
  if (docs.explicitEmpty) explicitUnsets.push("docs");
  const reminders = parseReminders(options.reminder, nowValue);
  if (reminders.explicitEmpty) explicitUnsets.push("reminders");
  const events = parseEvents(options.event, nowValue);
  if (events.explicitEmpty) explicitUnsets.push("events");
  const typeOptions = parseTypeOptions(options.typeOption);
  if (typeOptions.explicitEmpty) explicitUnsets.push("type_options");

  const scalarExplicitUnsetCandidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [options.deadline, "deadline"],
    [options.estimatedMinutes, "estimated_minutes"],
    [options.acceptanceCriteria, "acceptance_criteria"],
    [options.definitionOfReady, "definition_of_ready"],
    [options.order, "order"],
    [options.rank, "order"],
    [options.goal, "goal"],
    [options.objective, "objective"],
    [options.value, "value"],
    [options.impact, "impact"],
    [options.outcome, "outcome"],
    [options.whyNow, "why_now"],
    [options.assignee, "assignee"],
    [options.author, "author"],
    [options.parent, "parent"],
    [options.reviewer, "reviewer"],
    [options.risk, "risk"],
    [options.confidence, "confidence"],
    [options.sprint, "sprint"],
    [options.release, "release"],
    [options.blockedBy, "blocked_by"],
    [options.blockedReason, "blocked_reason"],
    [options.unblockNote, "unblock_note"],
    [options.reporter, "reporter"],
    [options.severity, "severity"],
    [options.environment, "environment"],
    [options.reproSteps, "repro_steps"],
    [options.resolution, "resolution"],
    [options.expectedResult, "expected_result"],
    [options.actualResult, "actual_result"],
    [options.affectedVersion, "affected_version"],
    [options.fixedVersion, "fixed_version"],
    [options.component, "component"],
    [options.regression, "regression"],
    [options.customerImpact, "customer_impact"],
  ];
  for (const [value, key] of scalarExplicitUnsetCandidates) {
    if (isNoneToken(value)) {
      explicitUnsets.push(key);
    }
  }

  const id = await generateItemId(pmRoot, settings.id_prefix);
  const type = typeDefinition.name;
  const status = options.status !== undefined ? ensureEnumValue(options.status, STATUS_VALUES, "status") : "open";
  const priority = options.priority !== undefined ? ensurePriority(options.priority) : 2;
  const tags = options.tags !== undefined ? parseTags(options.tags) : [];

  const deadline =
    options.deadline === undefined || isNoneToken(options.deadline)
      ? undefined
      : resolveIsoOrRelative(options.deadline, new Date(nowValue));
  const estimatedMinutes =
    options.estimatedMinutes === undefined || isNoneToken(options.estimatedMinutes)
      ? undefined
      : parseOptionalNumber(options.estimatedMinutes, "estimated-minutes");
  const acceptanceCriteria =
    options.acceptanceCriteria === undefined || isNoneToken(options.acceptanceCriteria)
      ? undefined
      : options.acceptanceCriteria;
  const definitionOfReady = options.definitionOfReady !== undefined ? parseOptionalString(options.definitionOfReady) : undefined;
  if (options.order !== undefined && options.rank !== undefined && options.order !== options.rank) {
    throw new PmCliError("--order and --rank must match when both are provided", EXIT_CODE.USAGE);
  }
  const orderRaw = options.order ?? options.rank;
  const order = orderRaw === undefined || isNoneToken(orderRaw) ? undefined : parseOptionalNumber(orderRaw, "order");
  if (order !== undefined && !Number.isInteger(order)) {
    throw new PmCliError("Order must be an integer", EXIT_CODE.USAGE);
  }
  const goal = options.goal !== undefined ? parseOptionalString(options.goal) : undefined;
  const objective = options.objective !== undefined ? parseOptionalString(options.objective) : undefined;
  const value = options.value !== undefined ? parseOptionalString(options.value) : undefined;
  const impact = options.impact !== undefined ? parseOptionalString(options.impact) : undefined;
  const outcome = options.outcome !== undefined ? parseOptionalString(options.outcome) : undefined;
  const whyNow = options.whyNow !== undefined ? parseOptionalString(options.whyNow) : undefined;
  const assignee = options.assignee !== undefined ? parseOptionalString(options.assignee) : undefined;
  const authorValue = parseOptionalString(options.author) ?? author;
  const parent = options.parent !== undefined ? parseOptionalString(options.parent) : undefined;
  const reviewer = options.reviewer !== undefined ? parseOptionalString(options.reviewer) : undefined;
  const riskRaw = options.risk !== undefined ? parseOptionalString(options.risk) : undefined;
  const risk = riskRaw !== undefined ? ensureEnumValue(normalizeRiskInput(riskRaw), RISK_VALUES, "risk") : undefined;
  const confidenceRaw = options.confidence !== undefined ? parseOptionalString(options.confidence) : undefined;
  const confidence = confidenceRaw !== undefined ? parseConfidenceInput(confidenceRaw) : undefined;
  const sprint = options.sprint !== undefined ? parseOptionalString(options.sprint) : undefined;
  const release = options.release !== undefined ? parseOptionalString(options.release) : undefined;
  const blockedBy = options.blockedBy !== undefined ? parseOptionalString(options.blockedBy) : undefined;
  const blockedReason = options.blockedReason !== undefined ? parseOptionalString(options.blockedReason) : undefined;
  const unblockNote = options.unblockNote !== undefined ? parseOptionalString(options.unblockNote) : undefined;
  const reporter = options.reporter !== undefined ? parseOptionalString(options.reporter) : undefined;
  const severityRaw = options.severity !== undefined ? parseOptionalString(options.severity) : undefined;
  const severity =
    severityRaw !== undefined ? ensureEnumValue(normalizeSeverityInput(severityRaw), ISSUE_SEVERITY_VALUES, "severity") : undefined;
  const environment = options.environment !== undefined ? parseOptionalString(options.environment) : undefined;
  const reproSteps = options.reproSteps !== undefined ? parseOptionalString(options.reproSteps) : undefined;
  const resolution = options.resolution !== undefined ? parseOptionalString(options.resolution) : undefined;
  const expectedResult = options.expectedResult !== undefined ? parseOptionalString(options.expectedResult) : undefined;
  const actualResult = options.actualResult !== undefined ? parseOptionalString(options.actualResult) : undefined;
  const affectedVersion = options.affectedVersion !== undefined ? parseOptionalString(options.affectedVersion) : undefined;
  const fixedVersion = options.fixedVersion !== undefined ? parseOptionalString(options.fixedVersion) : undefined;
  const component = options.component !== undefined ? parseOptionalString(options.component) : undefined;
  const regressionRaw = options.regression !== undefined ? parseOptionalString(options.regression) : undefined;
  const regression = regressionRaw !== undefined ? parseRegressionInput(regressionRaw) : undefined;
  const customerImpact = options.customerImpact !== undefined ? parseOptionalString(options.customerImpact) : undefined;
  const validatedTypeOptions = validateTypeOptions(type, typeOptions.values, typeRegistry);
  if (validatedTypeOptions.errors.length > 0) {
    throw new PmCliError(validatedTypeOptions.errors.join("; "), EXIT_CODE.USAGE);
  }
  const title = requireStringOption(options.title, "--title");
  const description = requireStringOption(options.description, "--description");
  const body = options.body ?? "";

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
  const historyMessage = buildHistoryMessage(options.message, explicitUnsets);
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
    warnings: hookWarnings,
  };
}
