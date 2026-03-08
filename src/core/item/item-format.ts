import type { Comment, Dependency, ItemDocument, ItemFrontMatter, LinkedDoc, LinkedFile, LinkedTest, LogNote } from "../../types/index.js";
import { CONFIDENCE_TEXT_VALUES, ISSUE_SEVERITY_VALUES, ITEM_TYPE_VALUES, STATUS_VALUES } from "../../types/index.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { orderObject } from "../shared/serialization.js";

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
  assertFrontMatterCondition(Number.isFinite(Date.parse(timestamp)), `${fieldName} must be a valid ISO timestamp`);
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
  assertFrontMatterCondition(
    typeof itemType === "string" && ITEM_TYPE_VALUES.includes(itemType as (typeof ITEM_TYPE_VALUES)[number]),
    `type must be one of: ${ITEM_TYPE_VALUES.join(", ")}`,
  );

  const status = record.status;
  assertFrontMatterCondition(
    typeof status === "string" && STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number]),
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
}

function sortDependencies(values: Dependency[] | undefined): Dependency[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values]
    .map((value) => ({
      id: value.id.trim().toLowerCase(),
      kind: value.kind,
      created_at: value.created_at,
      author: value.author?.trim() || undefined,
    }))
    .sort((a, b) => {
      const byCreated = a.created_at.localeCompare(b.created_at);
      if (byCreated !== 0) return byCreated;
      const byId = a.id.localeCompare(b.id);
      if (byId !== 0) return byId;
      return a.kind.localeCompare(b.kind);
    });
}

function sortLogValues<T extends Comment | LogNote>(values: T[] | undefined): T[] | undefined {
  if (!values || values.length === 0) return undefined;
  return [...values].sort((a, b) => {
    const byCreated = a.created_at.localeCompare(b.created_at);
    if (byCreated !== 0) return byCreated;
    const byText = a.text.localeCompare(b.text);
    if (byText !== 0) return byText;
    return a.author.localeCompare(b.author);
  });
}

function sortFiles(values: LinkedFile[] | undefined): LinkedFile[] | undefined {
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
  const tags = Array.from(new Set(frontMatter.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
  const normalized: ItemFrontMatter = {
    id: frontMatter.id,
    title: frontMatter.title,
    description: frontMatter.description,
    type: frontMatter.type,
    status: frontMatter.status,
    priority: frontMatter.priority,
    tags,
    created_at: frontMatter.created_at,
    updated_at: frontMatter.updated_at,
    dependencies: sortDependencies(frontMatter.dependencies),
    comments: sortLogValues(frontMatter.comments),
    notes: sortLogValues(frontMatter.notes),
    learnings: sortLogValues(frontMatter.learnings),
    files: sortFiles(frontMatter.files),
    tests: sortTests(frontMatter.tests),
    docs: sortDocs(frontMatter.docs),
    deadline: frontMatter.deadline || undefined,
    assignee: frontMatter.assignee?.trim() || undefined,
    author: frontMatter.author || undefined,
    estimated_minutes: frontMatter.estimated_minutes,
    acceptance_criteria: frontMatter.acceptance_criteria ?? undefined,
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

export function parseItemDocument(content: string): ItemDocument {
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

export function serializeItemDocument(document: ItemDocument): string {
  const normalizedFrontMatter = normalizeFrontMatter(document.front_matter);
  const orderedFrontMatter = orderFrontMatter(normalizedFrontMatter);
  const serializedFrontMatter = JSON.stringify(orderedFrontMatter, null, 2);
  const normalizedBody = normalizeBody(document.body ?? "");
  if (!normalizedBody) {
    return `${serializedFrontMatter}\n`;
  }
  return `${serializedFrontMatter}\n\n${normalizedBody}\n`;
}

export function canonicalDocument(document: ItemDocument): ItemDocument {
  return {
    front_matter: normalizeFrontMatter(document.front_matter),
    body: normalizeBody(document.body ?? ""),
  };
}
