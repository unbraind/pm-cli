import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
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
import type { ItemFormat } from "../../types/index.js";
import {
  CONFIDENCE_TEXT_VALUES,
  ISSUE_SEVERITY_VALUES,
  RECURRENCE_FREQUENCY_VALUES,
  RECURRENCE_WEEKDAY_VALUES,
  STATUS_VALUES,
} from "../../types/index.js";
import { normalizeStatusInput } from "./status.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { findFirstMergeConflictMarker } from "../shared/conflict-markers.js";
import { PmCliError } from "../shared/errors.js";
import { orderObject } from "../shared/serialization.js";
import { compareTimestampStrings, isTimestampLiteral } from "../shared/time.js";

function normalizePathValue(value: string): string {
  return value.replaceAll("\\", "/");
}

const REQUIRED_STRING_FIELDS = [
  "id",
  "title",
  "description",
  "created_at",
  "updated_at",
] as const;

function weekdayOrderIndex(value: (typeof RECURRENCE_WEEKDAY_VALUES)[number]): number {
  return RECURRENCE_WEEKDAY_VALUES.indexOf(value);
}

function validationError(message: string): never {
  throw new PmCliError(`Invalid item front matter: ${message}`, EXIT_CODE.GENERIC_FAILURE);
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

function assertValidFrontMatter(frontMatter: unknown): asserts frontMatter is ItemFrontMatter {
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

  const status = record.status;
  const normalizedStatus = typeof status === "string" ? normalizeStatusInput(status) : undefined;
  assertFrontMatterCondition(
    normalizedStatus !== undefined,
    `status must be one of: ${STATUS_VALUES.join(", ")}`,
  );

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

function sortTests(values: LinkedTest[] | undefined): LinkedTest[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values]
    .map((value) => ({
      command: value.command?.trim() || undefined,
      path: value.path ? normalizePathValue(value.path) : undefined,
      scope: value.scope,
      timeout_seconds: value.timeout_seconds,
      note: value.note?.trim() || undefined,
    }))
    .sort((a, b) => {
      const byScope = a.scope.localeCompare(b.scope);
      if (byScope !== 0) return byScope;
      const byPath = (a.path ?? "").localeCompare(b.path ?? "");
      if (byPath !== 0) return byPath;
      const byCommand = (a.command ?? "").localeCompare(b.command ?? "");
      if (byCommand !== 0) return byCommand;
      const byTimeout = (a.timeout_seconds ?? 0) - (b.timeout_seconds ?? 0);
      if (byTimeout !== 0) return byTimeout;
      return (a.note ?? "").localeCompare(b.note ?? "");
    });
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
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

function normalizeConfidenceValue(value: ItemFrontMatter["confidence"] | undefined): ItemFrontMatter["confidence"] | undefined {
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

function normalizeSeverityValue(value: ItemFrontMatter["severity"] | undefined): ItemFrontMatter["severity"] | undefined {
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

export function normalizeFrontMatter(frontMatter: ItemFrontMatter): ItemFrontMatter {
  const normalizedStatus = normalizeStatusInput(frontMatter.status) ?? frontMatter.status;
  const tags = Array.from(new Set(frontMatter.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
  const normalized: ItemFrontMatter = {
    id: frontMatter.id,
    title: frontMatter.title,
    description: frontMatter.description,
    type: frontMatter.type,
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
  };
  const sourceRecord = frontMatter as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(sourceRecord)) {
    if (Object.prototype.hasOwnProperty.call(normalized, key) || value === undefined) {
      continue;
    }
    (normalized as unknown as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) {
      delete (normalized as unknown as Record<string, unknown>)[key];
    }
  }
  return normalized;
}

function orderFrontMatter(frontMatter: ItemFrontMatter): Record<string, unknown> {
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

function parseJsonMarkdownItemDocument(content: string): ItemDocument {
  const { frontMatter, body } = splitFrontMatter(content);
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
  assertValidFrontMatter(parsed);

  return {
    front_matter: normalizeFrontMatter(parsed),
    body: normalizeBody(body),
  };
}

function parseToonItemDocument(content: string): ItemDocument {
  let parsed: unknown;
  try {
    parsed = decodeToon(content);
  } catch {
    validationError("TOON item document is not valid TOON");
  }
  assertFrontMatterCondition(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "TOON item document must be an object",
  );
  const record = parsed as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(record, "front_matter")) {
    assertValidFrontMatter(record.front_matter);
    assertFrontMatterCondition(
      record.body === undefined || typeof record.body === "string",
      "TOON item document body must be a string",
    );
    return {
      front_matter: normalizeFrontMatter(record.front_matter),
      body: normalizeBody(typeof record.body === "string" ? record.body : ""),
    };
  }

  const { body, ...frontMatterRecord } = record;
  assertFrontMatterCondition(
    body === undefined || typeof body === "string",
    "TOON item document body must be a string",
  );
  assertValidFrontMatter(frontMatterRecord);
  return {
    front_matter: normalizeFrontMatter(frontMatterRecord),
    body: normalizeBody(typeof body === "string" ? body : ""),
  };
}

function serializeJsonMarkdownItemDocument(document: ItemDocument): string {
  const normalizedFrontMatter = normalizeFrontMatter(document.front_matter);
  const orderedFrontMatter = orderFrontMatter(normalizedFrontMatter);
  const serializedFrontMatter = JSON.stringify(orderedFrontMatter, null, 2);
  const normalizedBody = normalizeBody(document.body ?? "");
  if (!normalizedBody) {
    return `${serializedFrontMatter}\n`;
  }
  return `${serializedFrontMatter}\n\n${normalizedBody}\n`;
}

function serializeToonItemDocument(document: ItemDocument): string {
  const normalizedFrontMatter = normalizeFrontMatter(document.front_matter);
  const orderedFrontMatter = orderFrontMatter(normalizedFrontMatter);
  const normalizedBody = normalizeBody(document.body ?? "");
  return `${encodeToon({ ...orderedFrontMatter, body: normalizedBody })}\n`;
}

export function parseItemDocument(content: string, options: { format?: ItemFormat } = {}): ItemDocument {
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
  const format = options.format ?? "json_markdown";
  return format === "toon" ? parseToonItemDocument(content) : parseJsonMarkdownItemDocument(content);
}

export function serializeItemDocument(document: ItemDocument, options: { format?: ItemFormat } = {}): string {
  const format = options.format ?? "json_markdown";
  return format === "toon" ? serializeToonItemDocument(document) : serializeJsonMarkdownItemDocument(document);
}

export function canonicalDocument(document: ItemDocument): ItemDocument {
  return {
    front_matter: normalizeFrontMatter(document.front_matter),
    body: normalizeBody(document.body ?? ""),
  };
}
