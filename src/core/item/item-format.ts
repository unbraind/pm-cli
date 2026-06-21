/**
 * @module core/item/item-format
 *
 * Defines item parsing, formatting, and lifecycle helpers for Item Format.
 */
import { encode as encodeToon } from "@toon-format/toon";
import type {
  CalendarEvent,
  Comment,
  Dependency,
  ItemDocument,
  ItemMetadata,
  RuntimeSchemaSettings,
  ItemTestRunSummary,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
  LogNote,
  PlanDecision,
  PlanDiscovery,
  PlanStep,
  PlanStepDoc,
  PlanStepFile,
  PlanStepLink,
  PlanStepStatus,
  PlanValidationCheck,
  RecurrenceRule,
  Reminder,
} from "../../types/index.js";
import type { ItemFormat } from "../../types/index.js";
import {
  CONFIDENCE_TEXT_VALUES,
  ISSUE_SEVERITY_VALUES,
  RECURRENCE_FREQUENCY_VALUES,
  RECURRENCE_WEEKDAY_VALUES,
  STATUS_VALUES,
  weekdayOrderIndex,
} from "../../types/index.js";
import { coerceRuntimeFieldValue } from "../schema/runtime-field-values.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeFieldRegistry,
  type RuntimeStatusRegistry,
} from "../schema/runtime-schema.js";
import { normalizeItemFormatVersion } from "./item-format-version.js";
import { normalizeStatusInput } from "./status.js";
import { decodeToonItemContent } from "./toon-decode.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { findFirstMergeConflictMarker } from "../shared/conflict-markers.js";
import { PmCliError } from "../shared/errors.js";
import { orderObject } from "../shared/serialization.js";
import { compareTimestampStrings, isTimestampLiteral } from "../shared/time.js";

const LINKED_TEST_PM_CONTEXT_MODE_VALUES = new Set(["schema", "tracker", "auto"]);

function normalizePathValue(value: string): string {
  return value.replaceAll("\\", "/");
}

function firstNonZeroComparison(comparisons: readonly number[]): number {
  for (const comparison of comparisons) {
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

const REQUIRED_STRING_FIELDS = [
  "id",
  "title",
  "description",
  "created_at",
  "updated_at",
] as const;

const STATIC_FRONT_MATTER_FIELD_SET = new Set(FRONT_MATTER_KEY_ORDER);

interface RuntimeSchemaValidationContext {
  statusRegistry?: RuntimeStatusRegistry;
  fieldRegistry?: RuntimeFieldRegistry;
  unknownFieldPolicy: "allow" | "warn" | "reject";
  extensionFieldNames: ReadonlySet<string>;
  onWarning?: (warning: string) => void;
}

/**
 * Documents the item document format options payload exchanged by command, SDK, and package integrations.
 */
export interface ItemDocumentFormatOptions {
  format?: ItemFormat;
  schema?: RuntimeSchemaSettings;
  extensionFieldNames?: readonly string[];
  onWarning?: (warning: string) => void;
}

function resolveRuntimeSchemaValidationContext(
  options: ItemDocumentFormatOptions | undefined,
): RuntimeSchemaValidationContext | undefined {
  if (!options?.schema) {
    return undefined;
  }
  return {
    statusRegistry: resolveRuntimeStatusRegistry(options.schema),
    fieldRegistry: resolveRuntimeFieldRegistry(options.schema),
    unknownFieldPolicy: options.schema.unknown_field_policy ?? "allow",
    extensionFieldNames: new Set(options.extensionFieldNames ?? []),
    onWarning: options.onWarning,
  };
}

function runtimeFieldRequiredForType(definition: RuntimeFieldRegistry["definitions"][number], typeName: string): boolean {
  if (!definition.required) {
    return false;
  }
  if (definition.required_types.length === 0) {
    return true;
  }
  return definition.required_types.map((value) => value.toLowerCase()).includes(typeName.trim().toLowerCase());
}

function validationError(message: string): never {
  throw new PmCliError(`Invalid item front matter: ${message}`, EXIT_CODE.GENERIC_FAILURE);
}

function buildKnownFrontMatterKeys(runtimeContext: RuntimeSchemaValidationContext): Set<string> {
  const knownKeys = new Set(STATIC_FRONT_MATTER_FIELD_SET);
  for (const definition of runtimeContext.fieldRegistry?.definitions ?? []) {
    knownKeys.add(definition.metadata_key);
  }
  for (const fieldName of runtimeContext.extensionFieldNames) {
    knownKeys.add(fieldName);
  }
  return knownKeys;
}

function assertFrontMatterCondition(condition: boolean, message: string): void {
  if (!condition) {
    validationError(message);
  }
}

function assertTimestampField(record: Record<string, unknown>, fieldName: "created_at" | "updated_at" | "deadline"): void {
  const rawValue = record[fieldName];
  assertFrontMatterCondition(typeof rawValue === "string", `${fieldName} must be a string`);
  const timestamp = rawValue as string;
  assertFrontMatterCondition(isTimestampLiteral(timestamp), `${fieldName} must be a valid ISO timestamp`);
}

function assertValidRecurrenceRule(recurrence: unknown): void {
  assertFrontMatterCondition(
    typeof recurrence === "object" && recurrence !== null && !Array.isArray(recurrence),
    "event.recurrence must be an object",
  );
  const recurrenceRecord = recurrence as Record<string, unknown>;
  assertFrontMatterCondition(typeof recurrenceRecord.freq === "string", "event.recurrence.freq must be a string");
  const frequency = (recurrenceRecord.freq as string).trim().toLowerCase();
  assertFrontMatterCondition(
    RECURRENCE_FREQUENCY_VALUES.includes(frequency as (typeof RECURRENCE_FREQUENCY_VALUES)[number]),
    `event.recurrence.freq must be one of: ${RECURRENCE_FREQUENCY_VALUES.join(", ")}`,
  );

  if (recurrenceRecord.interval !== undefined) {
    assertFrontMatterCondition(
      typeof recurrenceRecord.interval === "number" &&
        Number.isInteger(recurrenceRecord.interval) &&
        (recurrenceRecord.interval as number) >= 1,
      "event.recurrence.interval must be an integer >= 1",
    );
  }

  if (recurrenceRecord.count !== undefined) {
    assertFrontMatterCondition(
      typeof recurrenceRecord.count === "number" && Number.isInteger(recurrenceRecord.count) && (recurrenceRecord.count as number) >= 1,
      "event.recurrence.count must be an integer >= 1",
    );
  }

  if (recurrenceRecord.until !== undefined) {
    assertFrontMatterCondition(typeof recurrenceRecord.until === "string", "event.recurrence.until must be a string");
    assertFrontMatterCondition(
      isTimestampLiteral(recurrenceRecord.until as string),
      "event.recurrence.until must be a valid ISO timestamp",
    );
  }

  if (recurrenceRecord.by_weekday !== undefined) {
    assertFrontMatterCondition(Array.isArray(recurrenceRecord.by_weekday), "event.recurrence.by_weekday must be an array");
    for (const weekday of recurrenceRecord.by_weekday as unknown[]) {
      assertFrontMatterCondition(typeof weekday === "string", "event.recurrence.by_weekday entries must be strings");
      const normalizedWeekday = (weekday as string).trim().toLowerCase();
      assertFrontMatterCondition(
        RECURRENCE_WEEKDAY_VALUES.includes(normalizedWeekday as (typeof RECURRENCE_WEEKDAY_VALUES)[number]),
        `event.recurrence.by_weekday entries must be one of: ${RECURRENCE_WEEKDAY_VALUES.join(", ")}`,
      );
    }
  }

  if (recurrenceRecord.by_month_day !== undefined) {
    assertFrontMatterCondition(Array.isArray(recurrenceRecord.by_month_day), "event.recurrence.by_month_day must be an array");
    for (const day of recurrenceRecord.by_month_day as unknown[]) {
      assertFrontMatterCondition(
        typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31,
        "event.recurrence.by_month_day entries must be integers 1..31",
      );
    }
  }

  if (recurrenceRecord.exdates !== undefined) {
    assertFrontMatterCondition(Array.isArray(recurrenceRecord.exdates), "event.recurrence.exdates must be an array");
    for (const exdate of recurrenceRecord.exdates as unknown[]) {
      assertFrontMatterCondition(typeof exdate === "string", "event.recurrence.exdates entries must be strings");
      assertFrontMatterCondition(isTimestampLiteral(exdate as string), "event.recurrence.exdates entries must be valid ISO timestamps");
    }
  }
}

function assertValidFrontMatter(
  frontMatter: unknown,
  runtimeContext?: RuntimeSchemaValidationContext,
): asserts frontMatter is ItemMetadata {
  assertFrontMatterCondition(
    typeof frontMatter === "object" && frontMatter !== null && !Array.isArray(frontMatter),
    "front matter must be an object",
  );

  const record = frontMatter as Record<string, unknown>;
  for (const fieldName of REQUIRED_STRING_FIELDS) {
    assertFrontMatterCondition(typeof record[fieldName] === "string", `${fieldName} is required and must be a string`);
  }

  const itemType = record.type;
  assertFrontMatterCondition(typeof itemType === "string" && itemType.trim().length > 0, "type must be a non-empty string");

  const formatVersion = record.pm_format_version;
  if (formatVersion !== undefined) {
    assertFrontMatterCondition(
      typeof formatVersion === "number" && Number.isInteger(formatVersion) && formatVersion >= 1,
      "pm_format_version must be an integer >= 1",
    );
  }

  const status = record.status;
  assertFrontMatterCondition(
    typeof status === "string" && status.trim().length > 0,
    "status must be a non-empty string",
  );
  const statusRegistry = runtimeContext?.statusRegistry;
  const normalizedStatus = normalizeStatusInput(status as string, statusRegistry);
  const statusDomain = statusRegistry
    ? statusRegistry.definitions.map((definition) => definition.id)
    : [...STATUS_VALUES];
  assertFrontMatterCondition(normalizedStatus !== undefined, `status must be one of: ${statusDomain.join(", ")}`);

  const priority = record.priority;
  assertFrontMatterCondition(
    typeof priority === "number" && Number.isInteger(priority) && [0, 1, 2, 3, 4].includes(priority),
    "priority must be an integer 0..4",
  );

  const tags = record.tags;
  assertFrontMatterCondition(Array.isArray(tags), "tags must be an array");
  for (const tag of tags as unknown[]) {
    assertFrontMatterCondition(typeof tag === "string", "tags entries must be strings");
  }

  const confidence = record.confidence;
  if (confidence !== undefined) {
    if (typeof confidence === "number") {
      assertFrontMatterCondition(
        Number.isInteger(confidence) && confidence >= 0 && confidence <= 100,
        "confidence number value must be an integer 0..100",
      );
    } else if (typeof confidence === "string") {
      const normalizedConfidence = confidence.trim().toLowerCase();
      const isKnownTextConfidence =
        normalizedConfidence === "med" || CONFIDENCE_TEXT_VALUES.includes(normalizedConfidence as (typeof CONFIDENCE_TEXT_VALUES)[number]);
      assertFrontMatterCondition(
        isKnownTextConfidence,
        `confidence string value must be one of: ${[...CONFIDENCE_TEXT_VALUES, "med"].join(", ")}`,
      );
    } else {
      assertFrontMatterCondition(false, "confidence must be a number or string");
    }
  }

  const severity = record.severity;
  if (severity !== undefined) {
    if (typeof severity !== "string") {
      validationError("severity must be a string");
    }
    const normalizedSeverity = severity.trim().toLowerCase();
    const isKnownSeverity =
      normalizedSeverity === "med" || ISSUE_SEVERITY_VALUES.includes(normalizedSeverity as (typeof ISSUE_SEVERITY_VALUES)[number]);
    assertFrontMatterCondition(
      isKnownSeverity,
      `severity value must be one of: ${[...ISSUE_SEVERITY_VALUES, "med"].join(", ")}`,
    );
  }

  const regression = record.regression;
  if (regression !== undefined) {
    if (typeof regression !== "boolean") {
      validationError("regression must be a boolean");
    }
  }

  assertTimestampField(record, "created_at");
  assertTimestampField(record, "updated_at");
  if (record.deadline !== undefined) {
    assertTimestampField(record, "deadline");
  }
  if (record.reminders !== undefined) {
    const reminders = record.reminders;
    assertFrontMatterCondition(Array.isArray(reminders), "reminders must be an array");
    for (const reminder of reminders as unknown[]) {
      assertFrontMatterCondition(typeof reminder === "object" && reminder !== null && !Array.isArray(reminder), "reminders entries must be objects");
      const reminderRecord = reminder as Record<string, unknown>;
      assertFrontMatterCondition(typeof reminderRecord.at === "string", "reminder.at must be a string");
      assertFrontMatterCondition(isTimestampLiteral(reminderRecord.at as string), "reminder.at must be a valid ISO timestamp");
      assertFrontMatterCondition(typeof reminderRecord.text === "string", "reminder.text must be a string");
      assertFrontMatterCondition((reminderRecord.text as string).trim().length > 0, "reminder.text must not be empty");
    }
  }
  if (record.events !== undefined) {
    const events = record.events;
    assertFrontMatterCondition(Array.isArray(events), "events must be an array");
    for (const event of events as unknown[]) {
      assertFrontMatterCondition(typeof event === "object" && event !== null && !Array.isArray(event), "events entries must be objects");
      const eventRecord = event as Record<string, unknown>;
      assertFrontMatterCondition(typeof eventRecord.start_at === "string", "event.start_at must be a string");
      assertFrontMatterCondition(isTimestampLiteral(eventRecord.start_at as string), "event.start_at must be a valid ISO timestamp");

      if (eventRecord.end_at !== undefined) {
        assertFrontMatterCondition(typeof eventRecord.end_at === "string", "event.end_at must be a string");
        assertFrontMatterCondition(isTimestampLiteral(eventRecord.end_at as string), "event.end_at must be a valid ISO timestamp");
        assertFrontMatterCondition(
          compareTimestampStrings(eventRecord.end_at as string, eventRecord.start_at as string) > 0,
          "event.end_at must be after event.start_at",
        );
      }

      for (const stringField of ["title", "description", "location", "timezone"] as const) {
        if (eventRecord[stringField] !== undefined) {
          assertFrontMatterCondition(typeof eventRecord[stringField] === "string", `event.${stringField} must be a string`);
          assertFrontMatterCondition(
            (eventRecord[stringField] as string).trim().length > 0,
            `event.${stringField} must not be empty`,
          );
        }
      }

      if (eventRecord.all_day !== undefined) {
        assertFrontMatterCondition(typeof eventRecord.all_day === "boolean", "event.all_day must be a boolean");
      }

      if (eventRecord.recurrence !== undefined) {
        assertValidRecurrenceRule(eventRecord.recurrence);
        if ((eventRecord.recurrence as Record<string, unknown>).until !== undefined) {
          assertFrontMatterCondition(
            compareTimestampStrings(
              (eventRecord.recurrence as Record<string, unknown>).until as string,
              eventRecord.start_at as string,
            ) >= 0,
            "event.recurrence.until must be at or after event.start_at",
          );
        }
      }
    }
  }
  if (record.closed_at !== undefined) {
    const closedAt = record.closed_at;
    assertFrontMatterCondition(typeof closedAt === "string", "closed_at must be a string");
    assertFrontMatterCondition(isTimestampLiteral(closedAt as string), "closed_at must be a valid ISO timestamp");
  }
  for (const fieldName of ["source_type", "source_owner", "design", "external_ref"] as const) {
    const value = record[fieldName];
    if (value !== undefined) {
      assertFrontMatterCondition(typeof value === "string", `${fieldName} must be a string`);
    }
  }
  const typeOptions = record.type_options;
  if (typeOptions !== undefined) {
    assertFrontMatterCondition(
      typeof typeOptions === "object" && typeOptions !== null && !Array.isArray(typeOptions),
      "type_options must be an object",
    );
    for (const [optionKey, optionValue] of Object.entries(typeOptions as Record<string, unknown>)) {
      assertFrontMatterCondition(optionKey.trim().length > 0, "type_options keys must be non-empty");
      assertFrontMatterCondition(typeof optionValue === "string", "type_options values must be strings");
      const optionText = optionValue as string;
      assertFrontMatterCondition(optionText.trim().length > 0, "type_options values must be non-empty strings");
    }
  }

  if (runtimeContext?.fieldRegistry) {
    for (const definition of runtimeContext.fieldRegistry.definitions) {
      const fieldValue = record[definition.metadata_key];
      if (fieldValue === undefined) {
        if (runtimeFieldRequiredForType(definition, itemType as string)) {
          validationError(`missing required schema field: ${definition.metadata_key}`);
        }
        continue;
      }
      try {
        record[definition.metadata_key] = coerceRuntimeFieldValue(
          definition,
          fieldValue,
          `metadata field "${definition.metadata_key}"`,
        );
      } catch (error: unknown) {
        validationError(String((error as { message?: unknown })?.message).replace(/^Invalid\s+/u, ""));
      }
    }
  }

  if (runtimeContext && runtimeContext.unknownFieldPolicy !== "allow") {
    const knownKeys = buildKnownFrontMatterKeys(runtimeContext);
    const unknownKeys = Object.keys(record).filter((key) => !knownKeys.has(key)).sort((left, right) => left.localeCompare(right));
    if (unknownKeys.length > 0) {
      if (runtimeContext.unknownFieldPolicy === "reject") {
        validationError(`unknown schema fields are not allowed: ${unknownKeys.join(", ")}`);
      } else {
        runtimeContext.onWarning?.(`item_unknown_schema_fields:${unknownKeys.join(",")}`);
      }
    }
  }
}

function sortDependencies(values: Dependency[] | undefined): Dependency[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values]
    .map((value) => ({
      id: value.id.trim().toLowerCase(),
      kind: value.kind,
      created_at: value.created_at,
      author: value.author?.trim() || undefined,
      source_kind: value.source_kind?.trim() || undefined,
    }))
    .sort((a, b) => {
      const byCreated = compareTimestampStrings(a.created_at, b.created_at);
      if (byCreated !== 0) return byCreated;
      const byId = a.id.localeCompare(b.id);
      if (byId !== 0) return byId;
      const byKind = a.kind.localeCompare(b.kind);
      if (byKind !== 0) return byKind;
      return (a.source_kind ?? "").localeCompare(b.source_kind ?? "");
    });
}

function sortLogValues<T extends Comment | LogNote>(values: T[] | undefined): T[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values].sort((a, b) => {
    const byCreated = compareTimestampStrings(a.created_at, b.created_at);
    if (byCreated !== 0) return byCreated;
    const byText = a.text.localeCompare(b.text);
    if (byText !== 0) return byText;
    return a.author.localeCompare(b.author);
  });
}

function sortReminders(values: Reminder[] | undefined): Reminder[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = [...values]
    .map((value) => ({
      at: value.at,
      text: value.text.trim(),
    }))
    .filter((value) => value.text.length > 0)
    .sort((a, b) => {
      const byAt = compareTimestampStrings(a.at, b.at);
      if (byAt !== 0) return byAt;
      return a.text.localeCompare(b.text);
    });
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeRecurrenceRule(value: RecurrenceRule | undefined): RecurrenceRule | undefined {
  if (!value) {
    return undefined;
  }
  const normalizedFrequency = value.freq.trim().toLowerCase();
  if (!RECURRENCE_FREQUENCY_VALUES.includes(normalizedFrequency as (typeof RECURRENCE_FREQUENCY_VALUES)[number])) {
    return undefined;
  }

  const byWeekday = Array.from(
    new Set(
      (value.by_weekday ?? [])
        .map((weekday) => weekday.trim().toLowerCase())
        .filter((weekday) => RECURRENCE_WEEKDAY_VALUES.includes(weekday as (typeof RECURRENCE_WEEKDAY_VALUES)[number])),
    ),
  ).sort(
    (a, b) =>
      weekdayOrderIndex(a as (typeof RECURRENCE_WEEKDAY_VALUES)[number]) -
      weekdayOrderIndex(b as (typeof RECURRENCE_WEEKDAY_VALUES)[number]),
  );

  const byMonthDay = Array.from(
    new Set(
      (value.by_month_day ?? [])
        .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31)
        .map((day) => day as number),
    ),
  ).sort((a, b) => a - b);

  const exdates = Array.from(
    new Set(
      (value.exdates ?? [])
        .map((timestamp) => timestamp.trim())
        .filter((timestamp) => isTimestampLiteral(timestamp)),
    ),
  ).sort((a, b) => compareTimestampStrings(a, b));

  const normalized: RecurrenceRule = {
    freq: normalizedFrequency as (typeof RECURRENCE_FREQUENCY_VALUES)[number],
    interval: value.interval !== undefined && value.interval > 1 ? value.interval : undefined,
    count: value.count,
    until: value.until?.trim() || undefined,
    by_weekday: byWeekday.length > 0 ? (byWeekday as (typeof RECURRENCE_WEEKDAY_VALUES)[number][]) : undefined,
    by_month_day: byMonthDay.length > 0 ? byMonthDay : undefined,
    exdates: exdates.length > 0 ? exdates : undefined,
  };
  for (const [key, fieldValue] of Object.entries(normalized)) {
    if (fieldValue === undefined) {
      delete (normalized as unknown as Record<string, unknown>)[key];
    }
  }
  return normalized;
}

function sortEvents(values: CalendarEvent[] | undefined): CalendarEvent[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = [...values]
    .map((value) => {
      const event: CalendarEvent = {
        start_at: value.start_at,
        end_at: value.end_at || undefined,
        title: value.title?.trim() || undefined,
        description: value.description?.trim() || undefined,
        location: value.location?.trim() || undefined,
        all_day: value.all_day,
        timezone: value.timezone?.trim() || undefined,
        recurrence: normalizeRecurrenceRule(value.recurrence),
      };
      for (const [key, fieldValue] of Object.entries(event)) {
        if (fieldValue === undefined) {
          delete (event as unknown as Record<string, unknown>)[key];
        }
      }
      return event;
    })
    .sort((a, b) => {
      const byStart = compareTimestampStrings(a.start_at, b.start_at);
      if (byStart !== 0) return byStart;
      const byEnd = (a.end_at ?? "").localeCompare(b.end_at ?? "");
      if (byEnd !== 0) return byEnd;
      const byTitle = (a.title ?? "").localeCompare(b.title ?? "");
      if (byTitle !== 0) return byTitle;
      const byAllDay = Number(Boolean(a.all_day)) - Number(Boolean(b.all_day));
      if (byAllDay !== 0) return byAllDay;
      const byTimezone = (a.timezone ?? "").localeCompare(b.timezone ?? "");
      if (byTimezone !== 0) return byTimezone;
      const byLocation = (a.location ?? "").localeCompare(b.location ?? "");
      if (byLocation !== 0) return byLocation;
      const byDescription = (a.description ?? "").localeCompare(b.description ?? "");
      if (byDescription !== 0) return byDescription;
      return JSON.stringify(a.recurrence ?? {}).localeCompare(JSON.stringify(b.recurrence ?? {}));
    });
  return normalized;
}

function normalizeFiles(values: LinkedFile[] | undefined): LinkedFile[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values
    .map((value) => ({
      path: normalizePathValue(value.path),
      scope: value.scope,
      note: value.note?.trim() || undefined,
    }));
}

function normalizeTestRunSummaries(values: ItemTestRunSummary[] | undefined): ItemTestRunSummary[] | undefined {
  if (!values || values.length === 0) return undefined;
  const normalized = values
    .map((value) => {
      const runId = typeof value.run_id === "string" ? value.run_id.trim() : "";
      const kind = value.kind === "test" || value.kind === "test-all" ? value.kind : "test";
      const status =
        value.status === "passed" || value.status === "failed" || value.status === "stopped" || value.status === "canceled"
          ? value.status
          : "failed";
      const startedAt = typeof value.started_at === "string" ? value.started_at : "";
      const finishedAt = typeof value.finished_at === "string" ? value.finished_at : "";
      const recordedAt = typeof value.recorded_at === "string" ? value.recorded_at : "";
      const passed = typeof value.passed === "number" && Number.isFinite(value.passed) ? Math.max(0, Math.floor(value.passed)) : 0;
      const failed = typeof value.failed === "number" && Number.isFinite(value.failed) ? Math.max(0, Math.floor(value.failed)) : 0;
      const skipped = typeof value.skipped === "number" && Number.isFinite(value.skipped) ? Math.max(0, Math.floor(value.skipped)) : 0;
      return {
        run_id: runId,
        kind,
        status,
        started_at: startedAt,
        finished_at: finishedAt,
        recorded_at: recordedAt,
        attempt:
          typeof value.attempt === "number" && Number.isFinite(value.attempt) && value.attempt >= 1
            ? Math.floor(value.attempt)
            : undefined,
        resumed_from: value.resumed_from?.trim() || undefined,
        passed,
        failed,
        skipped,
        items:
          typeof value.items === "number" && Number.isFinite(value.items) && value.items >= 0
            ? Math.floor(value.items)
            : undefined,
        linked_tests:
          typeof value.linked_tests === "number" && Number.isFinite(value.linked_tests) && value.linked_tests >= 0
            ? Math.floor(value.linked_tests)
            : undefined,
        fail_on_skipped_triggered: value.fail_on_skipped_triggered === true ? true : undefined,
      };
    })
    .filter((value) => value.run_id.length > 0 && value.started_at.length > 0 && value.finished_at.length > 0 && value.recorded_at.length > 0)
    .sort((a, b) =>
      firstNonZeroComparison([
        compareTimestampStrings(a.recorded_at, b.recorded_at),
        a.run_id.localeCompare(b.run_id),
        a.kind.localeCompare(b.kind),
      ]),
    );
  return normalized.length > 0 ? normalized : undefined;
}

function sortTests(values: LinkedTest[] | undefined): LinkedTest[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values]
    .map((value) => ({
      command: value.command?.trim() || undefined,
      path: value.path ? normalizePathValue(value.path) : undefined,
      scope: value.scope,
      timeout_seconds:
        typeof value.timeout_seconds === "number" && Number.isFinite(value.timeout_seconds) && value.timeout_seconds > 0
          ? value.timeout_seconds
          : undefined,
      pm_context_mode: (() => {
        const normalized = value.pm_context_mode?.trim().toLowerCase();
        if (!normalized || !LINKED_TEST_PM_CONTEXT_MODE_VALUES.has(normalized)) {
          return undefined;
        }
        return normalized as LinkedTest["pm_context_mode"];
      })(),
      env_set: value.env_set
        ? Object.fromEntries(
            Object.entries(value.env_set)
              .map(([key, envValue]) => [key.trim(), String(envValue).trim()] as const)
              .filter(([key, envValue]) => key.length > 0 && envValue.length > 0)
              .sort(([left], [right]) => left.localeCompare(right)),
          )
        : undefined,
      env_clear: value.env_clear
        ? [...new Set(value.env_clear.map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : undefined,
      shared_host_safe: value.shared_host_safe === true ? true : undefined,
      assert_stdout_contains: value.assert_stdout_contains
        ? [...new Set(value.assert_stdout_contains.map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : undefined,
      assert_stdout_regex: value.assert_stdout_regex
        ? [...new Set(value.assert_stdout_regex.map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : undefined,
      assert_stderr_contains: value.assert_stderr_contains
        ? [...new Set(value.assert_stderr_contains.map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : undefined,
      assert_stderr_regex: value.assert_stderr_regex
        ? [...new Set(value.assert_stderr_regex.map((entry) => entry.trim()).filter((entry) => entry.length > 0))].sort((a, b) =>
            a.localeCompare(b),
          )
        : undefined,
      assert_stdout_min_lines:
        typeof value.assert_stdout_min_lines === "number" &&
          Number.isFinite(value.assert_stdout_min_lines) &&
          value.assert_stdout_min_lines >= 0
          ? Math.floor(value.assert_stdout_min_lines)
          : undefined,
      assert_json_field_equals: value.assert_json_field_equals
        ? Object.fromEntries(
            Object.entries(value.assert_json_field_equals)
              .map(([key, expectedValue]) => [key.trim(), String(expectedValue).trim()] as const)
              .filter(([key, expectedValue]) => key.length > 0 && expectedValue.length > 0)
              .sort(([left], [right]) => left.localeCompare(right)),
          )
        : undefined,
      assert_json_field_gte: value.assert_json_field_gte
        ? Object.fromEntries(
            Object.entries(value.assert_json_field_gte)
              .map(([key, expectedValue]) => [key.trim(), Number(expectedValue)] as const)
              .filter(([key, expectedValue]) => key.length > 0 && Number.isFinite(expectedValue))
              .sort(([left], [right]) => left.localeCompare(right)),
          )
        : undefined,
      note: value.note?.trim() || undefined,
    }))
    .sort((a, b) =>
      firstNonZeroComparison([
        a.scope.localeCompare(b.scope),
        (a.path ?? "").localeCompare(b.path ?? ""),
        (a.command ?? "").localeCompare(b.command ?? ""),
        (a.timeout_seconds ?? 0) - (b.timeout_seconds ?? 0),
        (a.pm_context_mode ?? "").localeCompare(b.pm_context_mode ?? ""),
        Number(Boolean(a.shared_host_safe)) - Number(Boolean(b.shared_host_safe)),
        JSON.stringify(a.env_clear ?? []).localeCompare(JSON.stringify(b.env_clear ?? [])),
        JSON.stringify(a.env_set ?? {}).localeCompare(JSON.stringify(b.env_set ?? {})),
        JSON.stringify(a.assert_stdout_contains ?? []).localeCompare(JSON.stringify(b.assert_stdout_contains ?? [])),
        JSON.stringify(a.assert_stdout_regex ?? []).localeCompare(JSON.stringify(b.assert_stdout_regex ?? [])),
        JSON.stringify(a.assert_stderr_contains ?? []).localeCompare(JSON.stringify(b.assert_stderr_contains ?? [])),
        JSON.stringify(a.assert_stderr_regex ?? []).localeCompare(JSON.stringify(b.assert_stderr_regex ?? [])),
        (a.assert_stdout_min_lines ?? 0) - (b.assert_stdout_min_lines ?? 0),
        JSON.stringify(a.assert_json_field_equals ?? {}).localeCompare(JSON.stringify(b.assert_json_field_equals ?? {})),
        JSON.stringify(a.assert_json_field_gte ?? {}).localeCompare(JSON.stringify(b.assert_json_field_gte ?? {})),
        (a.note ?? "").localeCompare(b.note ?? ""),
      ]),
    );
}

function sortDocs(values: LinkedDoc[] | undefined): LinkedDoc[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values]
    .map((value) => ({
      path: normalizePathValue(value.path),
      scope: value.scope,
      note: value.note?.trim() || undefined,
    }))
    .sort((a, b) => {
      const byScope = a.scope.localeCompare(b.scope);
      if (byScope !== 0) return byScope;
      const byPath = a.path.localeCompare(b.path);
      if (byPath !== 0) return byPath;
      return (a.note ?? "").localeCompare(b.note ?? "");
    });
}

function trimStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlanStepLinks(value: unknown): PlanStepLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanStepLink[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = trimStringOrUndefined(record.id);
    const kind = trimStringOrUndefined(record.kind);
    if (!id || !kind) continue;
    const link: PlanStepLink = { id, kind: kind as PlanStepLink["kind"] };
    const note = trimStringOrUndefined(record.note);
    if (note) link.note = note;
    if (record.required_before_step === true) link.required_before_step = true;
    out.push(link);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanStepFiles(value: unknown): PlanStepFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanStepFile[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = trimStringOrUndefined(record.path);
    if (!path) continue;
    const file: PlanStepFile = { path: normalizePathValue(path) };
    if (record.scope === "project" || record.scope === "global") file.scope = record.scope;
    const note = trimStringOrUndefined(record.note);
    if (note) file.note = note;
    out.push(file);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanStepTests(value: unknown): { command?: string; path?: string; note?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { command?: string; path?: string; note?: string }[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const command = trimStringOrUndefined(record.command);
    const path = trimStringOrUndefined(record.path);
    if (!command && !path) continue;
    const test: { command?: string; path?: string; note?: string } = {};
    if (command) test.command = command;
    if (path) test.path = normalizePathValue(path);
    const note = trimStringOrUndefined(record.note);
    if (note) test.note = note;
    out.push(test);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanStepDocs(value: unknown): PlanStepDoc[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanStepDoc[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = trimStringOrUndefined(record.path);
    if (!path) continue;
    const doc: PlanStepDoc = { path: normalizePathValue(path) };
    if (record.scope === "project" || record.scope === "global") doc.scope = record.scope;
    const note = trimStringOrUndefined(record.note);
    if (note) doc.note = note;
    out.push(doc);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanSteps(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanStep[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = trimStringOrUndefined(record.id);
    const title = trimStringOrUndefined(record.title);
    const status = trimStringOrUndefined(record.status);
    const orderRaw = record.order;
    const order = typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : Number(orderRaw);
    if (!id || !title || !status || !Number.isFinite(order)) continue;
    const created_at = typeof record.created_at === "string" ? record.created_at : "";
    const updated_at = typeof record.updated_at === "string" ? record.updated_at : "";
    if (!created_at || !updated_at) continue;
    const step: PlanStep = {
      id,
      order,
      title,
      status: status as PlanStepStatus,
      created_at,
      updated_at,
    };
    const body = trimStringOrUndefined(record.body);
    if (body) step.body = body;
    const owner = trimStringOrUndefined(record.owner);
    if (owner) step.owner = owner;
    const evidence = trimStringOrUndefined(record.evidence);
    if (evidence) step.evidence = evidence;
    const blockedReason = trimStringOrUndefined(record.blocked_reason);
    if (blockedReason) step.blocked_reason = blockedReason;
    const supersededBy = trimStringOrUndefined(record.superseded_by);
    if (supersededBy) step.superseded_by = supersededBy;
    const completedAt = typeof record.completed_at === "string" ? record.completed_at : undefined;
    if (completedAt && completedAt.length > 0) step.completed_at = completedAt;
    const links = normalizePlanStepLinks(record.linked_items);
    if (links) step.linked_items = links;
    const files = normalizePlanStepFiles(record.files);
    if (files) step.files = files;
    const tests = normalizePlanStepTests(record.tests);
    if (tests) step.tests = tests;
    const docs = normalizePlanStepDocs(record.docs);
    if (docs) step.docs = docs;
    out.push(step);
  }
  out.sort((left, right) => left.order - right.order);
  return out.length > 0 ? out : undefined;
}

function normalizePlanDecisions(value: unknown): PlanDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanDecision[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const ts = typeof record.ts === "string" ? record.ts : "";
    const author = typeof record.author === "string" ? record.author : "";
    const decision = trimStringOrUndefined(record.decision);
    if (!ts || !author || !decision) continue;
    const item: PlanDecision = { ts, author, decision };
    const rationale = trimStringOrUndefined(record.rationale);
    if (rationale) item.rationale = rationale;
    const evidence = trimStringOrUndefined(record.evidence);
    if (evidence) item.evidence = evidence;
    const stepId = trimStringOrUndefined(record.step_id);
    if (stepId) item.step_id = stepId;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanDiscoveries(value: unknown): PlanDiscovery[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanDiscovery[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const ts = typeof record.ts === "string" ? record.ts : "";
    const author = typeof record.author === "string" ? record.author : "";
    const text = trimStringOrUndefined(record.text);
    if (!ts || !author || !text) continue;
    const item: PlanDiscovery = { ts, author, text };
    const stepId = trimStringOrUndefined(record.step_id);
    if (stepId) item.step_id = stepId;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizePlanValidation(value: unknown): PlanValidationCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlanValidationCheck[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const text = trimStringOrUndefined(record.text);
    if (!text) continue;
    const item: PlanValidationCheck = { text };
    const command = trimStringOrUndefined(record.command);
    if (command) item.command = command;
    const expected = trimStringOrUndefined(record.expected);
    if (expected) item.expected = expected;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeTypeOptions(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) {
    return undefined;
  }
  const normalizedEntries = Object.entries(values)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));
  if (normalizedEntries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(normalizedEntries);
}

function normalizeBody(body: string): string {
  let start = 0;
  while (start < body.length && body[start] === "\n") {
    start += 1;
  }
  return body.slice(start).trimEnd();
}

function normalizeConfidenceValue(value: ItemMetadata["confidence"] | undefined): ItemMetadata["confidence"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "med") {
    return "medium";
  }
  if (CONFIDENCE_TEXT_VALUES.includes(normalized as (typeof CONFIDENCE_TEXT_VALUES)[number])) {
    return normalized as (typeof CONFIDENCE_TEXT_VALUES)[number];
  }
  return undefined;
}

function normalizeSeverityValue(value: ItemMetadata["severity"] | undefined): ItemMetadata["severity"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "med") {
    return "medium";
  }
  if (ISSUE_SEVERITY_VALUES.includes(normalized as (typeof ISSUE_SEVERITY_VALUES)[number])) {
    return normalized as (typeof ISSUE_SEVERITY_VALUES)[number];
  }
  return undefined;
}

/**
 * Implements normalize front matter for the public runtime surface of this module.
 */
export function normalizeFrontMatter(
  frontMatter: ItemMetadata,
  options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {},
): ItemMetadata {
  const runtimeContext = resolveRuntimeSchemaValidationContext(options);
  const normalizedStatus = normalizeStatusInput(frontMatter.status, runtimeContext?.statusRegistry) ?? frontMatter.status;
  const tags = Array.from(new Set(frontMatter.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
  const normalized: ItemMetadata = {
    id: frontMatter.id,
    title: frontMatter.title,
    description: frontMatter.description,
    type: frontMatter.type,
    pm_format_version: normalizeItemFormatVersion(frontMatter.pm_format_version),
    source_type: frontMatter.source_type?.trim() || undefined,
    type_options: normalizeTypeOptions(frontMatter.type_options),
    status: normalizedStatus,
    priority: frontMatter.priority,
    tags,
    created_at: frontMatter.created_at,
    updated_at: frontMatter.updated_at,
    dependencies: sortDependencies(frontMatter.dependencies),
    comments: sortLogValues(frontMatter.comments),
    notes: sortLogValues(frontMatter.notes),
    learnings: sortLogValues(frontMatter.learnings),
    files: normalizeFiles(frontMatter.files),
    tests: sortTests(frontMatter.tests),
    test_runs: normalizeTestRunSummaries(frontMatter.test_runs),
    docs: sortDocs(frontMatter.docs),
    deadline: frontMatter.deadline || undefined,
    reminders: sortReminders(frontMatter.reminders),
    events: sortEvents(frontMatter.events),
    closed_at: frontMatter.closed_at || undefined,
    assignee: frontMatter.assignee?.trim() || undefined,
    source_owner: frontMatter.source_owner?.trim() || undefined,
    author: frontMatter.author || undefined,
    estimated_minutes: frontMatter.estimated_minutes,
    acceptance_criteria: frontMatter.acceptance_criteria ?? undefined,
    design: frontMatter.design ?? undefined,
    external_ref: frontMatter.external_ref ?? undefined,
    definition_of_ready: frontMatter.definition_of_ready?.trim() || undefined,
    order: frontMatter.order,
    goal: frontMatter.goal?.trim() || undefined,
    objective: frontMatter.objective?.trim() || undefined,
    value: frontMatter.value?.trim() || undefined,
    impact: frontMatter.impact?.trim() || undefined,
    outcome: frontMatter.outcome?.trim() || undefined,
    why_now: frontMatter.why_now?.trim() || undefined,
    parent: frontMatter.parent?.trim() || undefined,
    reviewer: frontMatter.reviewer?.trim() || undefined,
    risk: frontMatter.risk ?? undefined,
    confidence: normalizeConfidenceValue(frontMatter.confidence),
    sprint: frontMatter.sprint?.trim() || undefined,
    release: frontMatter.release?.trim() || undefined,
    blocked_by: frontMatter.blocked_by?.trim() || undefined,
    blocked_reason: frontMatter.blocked_reason?.trim() || undefined,
    unblock_note: frontMatter.unblock_note?.trim() || undefined,
    reporter: frontMatter.reporter?.trim() || undefined,
    severity: normalizeSeverityValue(frontMatter.severity),
    environment: frontMatter.environment?.trim() || undefined,
    repro_steps: frontMatter.repro_steps?.trim() || undefined,
    resolution: frontMatter.resolution?.trim() || undefined,
    expected_result: frontMatter.expected_result?.trim() || undefined,
    actual_result: frontMatter.actual_result?.trim() || undefined,
    affected_version: frontMatter.affected_version?.trim() || undefined,
    fixed_version: frontMatter.fixed_version?.trim() || undefined,
    component: frontMatter.component?.trim() || undefined,
    regression: frontMatter.regression,
    customer_impact: frontMatter.customer_impact?.trim() || undefined,
    close_reason: frontMatter.close_reason || undefined,
    plan_mode: trimStringOrUndefined(frontMatter.plan_mode) as ItemMetadata["plan_mode"],
    plan_scope: trimStringOrUndefined(frontMatter.plan_scope),
    plan_harness: trimStringOrUndefined(frontMatter.plan_harness) as ItemMetadata["plan_harness"],
    plan_resume_context: trimStringOrUndefined(frontMatter.plan_resume_context),
    plan_steps: normalizePlanSteps(frontMatter.plan_steps),
    plan_decisions: normalizePlanDecisions(frontMatter.plan_decisions),
    plan_discoveries: normalizePlanDiscoveries(frontMatter.plan_discoveries),
    plan_validation: normalizePlanValidation(frontMatter.plan_validation),
  };
  const sourceRecord = frontMatter as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(sourceRecord)) {
    if (Object.prototype.hasOwnProperty.call(normalized, key) || value === undefined) {
      continue;
    }
    (normalized as unknown as Record<string, unknown>)[key] = value;
  }

  if (runtimeContext?.fieldRegistry) {
    for (const definition of runtimeContext.fieldRegistry.definitions) {
      const currentValue = (normalized as unknown as Record<string, unknown>)[definition.metadata_key];
      if (currentValue === undefined) {
        continue;
      }
      (normalized as unknown as Record<string, unknown>)[definition.metadata_key] = coerceRuntimeFieldValue(
        definition,
        currentValue,
        `metadata field "${definition.metadata_key}"`,
      );
    }
  }

  if (runtimeContext && runtimeContext.unknownFieldPolicy !== "allow") {
    const knownKeys = buildKnownFrontMatterKeys(runtimeContext);
    const unknownKeys = Object.keys(normalized as unknown as Record<string, unknown>)
      .filter((key) => !knownKeys.has(key))
      .sort((left, right) => left.localeCompare(right));
    if (unknownKeys.length > 0) {
      if (runtimeContext.unknownFieldPolicy === "reject") {
        validationError(`unknown schema fields are not allowed: ${unknownKeys.join(", ")}`);
      }
    }
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) {
      delete (normalized as unknown as Record<string, unknown>)[key];
    }
  }
  return normalized;
}

function orderFrontMatter(frontMatter: ItemMetadata): Record<string, unknown> {
  return orderObject(frontMatter as unknown as Record<string, unknown>, FRONT_MATTER_KEY_ORDER);
}

function findJsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Implements split front matter for the public runtime surface of this module.
 */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  if (!content.startsWith("{")) {
    return { frontMatter: "", body: content };
  }
  const end = findJsonObjectEnd(content);
  if (end < 0) {
    return { frontMatter: "", body: content };
  }
  const frontMatter = content.slice(0, end + 1);
  const body = content.slice(end + 1).replace(/^\r?\n+/, "");
  return { frontMatter, body };
}

function stripLeadingYamlDocument(content: string): { content: string; stripped: boolean } {
  const normalizedContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const opener = normalizedContent.match(/^[ \t]*---[ \t]*(?:\r?\n|$)/);
  if (!opener) {
    return { content: normalizedContent, stripped: false };
  }

  let cursor = opener[0].length;
  while (cursor < normalizedContent.length) {
    const nextNewline = normalizedContent.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? normalizedContent.length : nextNewline;
    const line = normalizedContent.slice(cursor, lineEnd).replace(/\r$/, "");
    const afterLine = nextNewline === -1 ? lineEnd : lineEnd + 1;
    if (line.trim() === "---") {
      return { content: normalizedContent.slice(afterLine).replace(/^\s+/, ""), stripped: true };
    }
    cursor = afterLine;
  }

  return { content: normalizedContent, stripped: false };
}

function parseJsonMarkdownItemDocument(
  content: string,
  runtimeContext?: RuntimeSchemaValidationContext,
  options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {},
): ItemDocument {
  const normalized = stripLeadingYamlDocument(content);
  if (normalized.stripped) {
    options.onWarning?.("json_markdown_leading_yaml_frontmatter_ignored");
  }
  const { frontMatter, body } = splitFrontMatter(normalized.content);
  if (!frontMatter) {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("{")) {
      validationError("JSON front matter is not valid JSON");
    }
    validationError("missing JSON front matter");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frontMatter);
  } catch {
    validationError("JSON front matter is not valid JSON");
  }
  assertValidFrontMatter(parsed, runtimeContext);

  return {
    metadata: normalizeFrontMatter(parsed, options),
    body: normalizeBody(body),
  };
}

function parseToonItemDocument(
  content: string,
  runtimeContext?: RuntimeSchemaValidationContext,
  options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {},
): ItemDocument {
  let parsed: unknown;
  try {
    // decodeToonItemContent transparently recovers documents that the upstream
    // strict decoder rejects (bracketed-token-then-colon inside a quoted value;
    // see toon-decode.ts). The recovery is lossless, so it stays silent rather
    // than emitting a per-read warning that would perpetually flip pm health
    // red for legacy files. The behavior is pinned by toon-decode.spec.ts.
    parsed = decodeToonItemContent(content).value;
  } catch {
    validationError("TOON item document is not valid TOON");
  }
  assertFrontMatterCondition(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "TOON item document must be an object",
  );
  const record = parsed as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(record, "front_matter")) {
    assertValidFrontMatter(record.front_matter, runtimeContext);
    assertFrontMatterCondition(
      record.body === undefined || typeof record.body === "string",
      "TOON item document body must be a string",
    );
    return {
      metadata: normalizeFrontMatter(record.front_matter, options),
      body: normalizeBody(typeof record.body === "string" ? record.body : ""),
    };
  }

  const { body, ...frontMatterRecord } = record;
  assertFrontMatterCondition(
    body === undefined || typeof body === "string",
    "TOON item document body must be a string",
  );
  assertValidFrontMatter(frontMatterRecord, runtimeContext);
  return {
    metadata: normalizeFrontMatter(frontMatterRecord, options),
    body: normalizeBody(typeof body === "string" ? body : ""),
  };
}

function serializeJsonMarkdownItemDocument(
  document: ItemDocument,
  options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {},
): string {
  const normalizedFrontMatter = normalizeFrontMatter(document.metadata, options);
  const orderedFrontMatter = orderFrontMatter(normalizedFrontMatter);
  const serializedFrontMatter = JSON.stringify(orderedFrontMatter, null, 2);
  const normalizedBody = normalizeBody(document.body ?? "");
  if (!normalizedBody) {
    return `${serializedFrontMatter}\n`;
  }
  return `${serializedFrontMatter}\n\n${normalizedBody}\n`;
}

function serializeToonItemDocument(
  document: ItemDocument,
  options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {},
): string {
  const normalizedFrontMatter = normalizeFrontMatter(document.metadata, options);
  const orderedFrontMatter = orderFrontMatter(normalizedFrontMatter);
  const normalizedBody = normalizeBody(document.body ?? "");
  return `${encodeToon({ ...orderedFrontMatter, body: normalizedBody })}\n`;
}

/**
 * Implements parse item document for the public runtime surface of this module.
 */
export function parseItemDocument(content: string, options: ItemDocumentFormatOptions = {}): ItemDocument {
  const conflictMarker = findFirstMergeConflictMarker(content);
  if (conflictMarker) {
    throw new PmCliError(
      `Merge conflict markers detected in item document at line ${conflictMarker.line} (${conflictMarker.marker}). Resolve <<<<<<< ======= >>>>>>> markers and retry.`,
      EXIT_CODE.GENERIC_FAILURE,
      {
        code: "merge_conflict_markers_detected",
        required: "Resolve merge-conflict markers in the item file before parsing or mutation commands.",
        why: "Partially merged documents can corrupt item metadata and history integrity.",
        examples: ["git status", "git add <resolved-file> && git commit"],
        nextSteps: ["Resolve conflicts, save the file, then rerun the pm command."],
      },
    );
  }
  const format = options.format ?? "toon";
  const runtimeContext = resolveRuntimeSchemaValidationContext(options);
  return format === "toon"
    ? parseToonItemDocument(content, runtimeContext, options)
    : parseJsonMarkdownItemDocument(content, runtimeContext, options);
}

/**
 * Implements serialize item document for the public runtime surface of this module.
 */
export function serializeItemDocument(document: ItemDocument, options: ItemDocumentFormatOptions = {}): string {
  const format = options.format ?? "toon";
  return format === "toon" ? serializeToonItemDocument(document, options) : serializeJsonMarkdownItemDocument(document, options);
}

/**
 * Implements canonical document for the public runtime surface of this module.
 */
export function canonicalDocument(document: ItemDocument, options: Pick<ItemDocumentFormatOptions, "schema" | "extensionFieldNames" | "onWarning"> = {}): ItemDocument {
  return {
    metadata: normalizeFrontMatter(document.metadata, options),
    body: normalizeBody(document.body ?? ""),
  };
}

export const _testOnlyItemFormat = {
  buildKnownFrontMatterKeys,
  firstNonZeroComparison,
  normalizeBody,
  normalizePlanDecisions,
  normalizePlanDiscoveries,
  normalizePlanStepDocs,
  normalizePlanStepFiles,
  normalizePlanStepLinks,
  normalizePlanSteps,
  normalizePlanStepTests,
  normalizePlanValidation,
  normalizeTestRunSummaries,
  normalizeTypeOptions,
  runtimeFieldRequiredForType,
  sortTests,
};
