import type { ItemDocument, ItemMetadata, PmSettings } from "../../types/index.js";
import { coercePositiveInteger } from "../shared/primitives.js";

/**
 * Canonical ordered list of corpus field names emitted by {@link buildSearchCorpus}.
 *
 * When `search.corpus_fields` is unset/empty the full set is included (backward
 * compatible). When configured, only the named fields are emitted — letting
 * teams opt structured signals in/out for token efficiency. Unknown names in the
 * configured list are ignored (they simply never match a builder).
 *
 * NOTE: `plan` is conditional — it is only emitted when the item has plan
 * content (see {@link buildPlanCorpus}); it is still part of the default set so
 * plan-bearing items keep their plan corpus.
 */
export const DEFAULT_SEARCH_CORPUS_FIELDS: readonly string[] = [
  "title",
  "description",
  "tags",
  "status",
  "type",
  "priority",
  "assignee",
  "parent",
  "goal",
  "value",
  "why_now",
  "risk",
  "confidence",
  "estimated_minutes",
  "acceptance_criteria",
  "resolution",
  "expected_result",
  "actual_result",
  "body",
  "comments",
  "notes",
  "learnings",
  "reminders",
  "events",
  "dependencies",
  "plan",
] as const;

/**
 * Resolve the effective corpus field list from settings.
 *
 * - unset / not an array / empty array → the full default set (backward compatible).
 * - non-empty array → exactly those names (string entries only; trimmed; empties dropped).
 */
export function resolveSearchCorpusFields(settings: Pick<PmSettings, "search"> | undefined): string[] {
  const configured = settings?.search?.corpus_fields;
  if (!Array.isArray(configured)) {
    return [...DEFAULT_SEARCH_CORPUS_FIELDS];
  }
  // The type guard is intentional: corpus_fields comes from user-editable
  // settings.json, so entries are not statically guaranteed to be strings.
  // De-duplicate so a repeated name cannot produce duplicate corpus keys.
  const selected = Array.from(
    new Set(
      configured
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
  return selected.length > 0 ? selected : [...DEFAULT_SEARCH_CORPUS_FIELDS];
}

export const DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS = 8_000;
export const OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS = 3_200;
export const SEMANTIC_CORPUS_TRUNCATION_SUFFIX = "...[semantic corpus truncated]";
export const SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING =
  "search_embedding_corpus_max_characters_invalid:using_provider_default";

function compactParts(parts: Array<string | boolean | number | null | undefined>): string {
  return parts
    .map((part) => (part === undefined || part === null ? "" : String(part).trim()))
    .filter((part) => part.length > 0)
    .join(" ");
}

export function buildReminderCorpus(item: ItemMetadata): string[] {
  return (item.reminders ?? []).map((reminder) => compactParts([reminder.at, reminder.text]));
}

export function buildEventCorpus(item: ItemMetadata): string[] {
  return (item.events ?? []).map((event) =>
    compactParts([
      event.start_at,
      event.end_at,
      event.title,
      event.description,
      event.location,
      event.all_day === true ? "all day" : undefined,
      event.timezone,
      event.recurrence?.freq,
      event.recurrence?.interval,
      event.recurrence?.count,
      event.recurrence?.until,
      event.recurrence?.by_weekday?.join(" "),
      event.recurrence?.by_month_day?.join(" "),
      event.recurrence?.exdates?.join(" "),
    ]),
  );
}

export function buildPlanFlatCorpus(item: ItemMetadata): string {
  const segments: Array<string | undefined> = [];
  segments.push(item.plan_mode, item.plan_scope, item.plan_harness, item.plan_resume_context);
  for (const step of item.plan_steps ?? []) {
    segments.push(step.title, step.body, step.status, step.owner, step.evidence, step.blocked_reason, step.superseded_by);
    for (const link of step.linked_items ?? []) {
      segments.push(`${link.kind} ${link.id}`, link.note);
    }
    for (const file of step.files ?? []) segments.push(file.path, file.note);
    for (const test of step.tests ?? []) segments.push(test.command, test.path, test.note);
    for (const doc of step.docs ?? []) segments.push(doc.path, doc.note);
  }
  for (const decision of item.plan_decisions ?? []) {
    segments.push(decision.decision, decision.rationale, decision.evidence);
  }
  for (const discovery of item.plan_discoveries ?? []) {
    segments.push(discovery.text);
  }
  for (const check of item.plan_validation ?? []) {
    segments.push(check.text, check.command, check.expected);
  }
  return segments.filter((segment): segment is string => typeof segment === "string" && segment.length > 0).join(" ");
}

export function buildPlanCorpus(item: ItemMetadata): Record<string, unknown> | undefined {
  const steps = (item.plan_steps ?? []).map((step) =>
    compactParts([
      step.order,
      step.id,
      step.title,
      step.body,
      step.status,
      step.owner,
      step.evidence,
      step.blocked_reason,
      step.superseded_by,
      (step.linked_items ?? []).map((link) => compactParts([link.kind, link.id, link.note])).join(" "),
      (step.files ?? []).map((file) => compactParts([file.path, file.note])).join(" "),
      (step.tests ?? []).map((test) => compactParts([test.command, test.path, test.note])).join(" "),
      (step.docs ?? []).map((doc) => compactParts([doc.path, doc.note])).join(" "),
    ]),
  );
  const decisions = (item.plan_decisions ?? []).map((entry) =>
    compactParts([entry.decision, entry.rationale, entry.evidence, entry.step_id]),
  );
  const discoveries = (item.plan_discoveries ?? []).map((entry) => compactParts([entry.text, entry.step_id]));
  const validation = (item.plan_validation ?? []).map((entry) =>
    compactParts([entry.text, entry.command, entry.expected]),
  );
  const hasPlanContent =
    item.plan_mode !== undefined ||
    item.plan_scope !== undefined ||
    item.plan_harness !== undefined ||
    item.plan_resume_context !== undefined ||
    steps.length > 0 ||
    decisions.length > 0 ||
    discoveries.length > 0 ||
    validation.length > 0;
  if (!hasPlanContent) {
    return undefined;
  }
  return {
    mode: item.plan_mode,
    scope: item.plan_scope,
    harness: item.plan_harness,
    resume_context: item.plan_resume_context,
    steps,
    decisions,
    discoveries,
    validation,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface SearchCorpusOptions {
  /**
   * Field names to include. When omitted, the full default set is used.
   * See {@link DEFAULT_SEARCH_CORPUS_FIELDS} and {@link resolveSearchCorpusFields}.
   */
  fields?: string[];
}

/**
 * Builders for each corpus field. Each returns the value to emit, or `undefined`
 * to omit the field entirely (keeps the corpus compact / token-efficient — we do
 * not emit empty strings, empty arrays, or nulls for the optional structured
 * fields). Always-present fields (title/status/etc.) emit their raw value.
 */
const CORPUS_FIELD_BUILDERS: Record<string, (document: ItemDocument) => unknown> = {
  title: (document) => document.metadata.title,
  description: (document) => document.metadata.description,
  tags: (document) => document.metadata.tags,
  status: (document) => document.metadata.status,
  type: (document) => document.metadata.type,
  priority: (document) =>
    typeof document.metadata.priority === "number" ? document.metadata.priority : undefined,
  assignee: (document) => (isNonEmptyString(document.metadata.assignee) ? document.metadata.assignee : undefined),
  parent: (document) => (isNonEmptyString(document.metadata.parent) ? document.metadata.parent : undefined),
  goal: (document) => (isNonEmptyString(document.metadata.goal) ? document.metadata.goal : undefined),
  value: (document) => (isNonEmptyString(document.metadata.value) ? document.metadata.value : undefined),
  why_now: (document) => (isNonEmptyString(document.metadata.why_now) ? document.metadata.why_now : undefined),
  risk: (document) => (isNonEmptyString(document.metadata.risk) ? document.metadata.risk : undefined),
  confidence: (document) =>
    document.metadata.confidence !== undefined && document.metadata.confidence !== null
      ? document.metadata.confidence
      : undefined,
  estimated_minutes: (document) =>
    typeof document.metadata.estimated_minutes === "number" ? document.metadata.estimated_minutes : undefined,
  acceptance_criteria: (document) =>
    isNonEmptyString(document.metadata.acceptance_criteria) ? document.metadata.acceptance_criteria : undefined,
  resolution: (document) =>
    isNonEmptyString(document.metadata.resolution) ? document.metadata.resolution : undefined,
  expected_result: (document) =>
    isNonEmptyString(document.metadata.expected_result) ? document.metadata.expected_result : undefined,
  actual_result: (document) =>
    isNonEmptyString(document.metadata.actual_result) ? document.metadata.actual_result : undefined,
  body: (document) => document.body,
  comments: (document) => (document.metadata.comments ?? []).map((entry) => entry.text),
  notes: (document) => (document.metadata.notes ?? []).map((entry) => entry.text),
  learnings: (document) => (document.metadata.learnings ?? []).map((entry) => entry.text),
  reminders: (document) => buildReminderCorpus(document.metadata),
  events: (document) => buildEventCorpus(document.metadata),
  dependencies: (document) =>
    (document.metadata.dependencies ?? []).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
    })),
  plan: (document) => buildPlanCorpus(document.metadata),
};

export function buildSearchCorpus(document: ItemDocument, options: SearchCorpusOptions = {}): Record<string, unknown> {
  const fields = options.fields ?? DEFAULT_SEARCH_CORPUS_FIELDS;
  const corpus: Record<string, unknown> = {};
  for (const field of fields) {
    const builder = CORPUS_FIELD_BUILDERS[field];
    if (!builder) {
      continue;
    }
    const value = builder(document);
    if (value === undefined) {
      continue;
    }
    corpus[field] = value;
  }
  return corpus;
}

export function resolveSemanticCorpusInputCharacterLimit(providerName: string | undefined): number {
  if (providerName?.trim().toLowerCase() === "ollama") {
    return OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS;
  }
  return DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS;
}

export interface SemanticCorpusCharacterLimitResolution {
  maxCharacters: number;
  warning: string | null;
}

export function resolveSemanticCorpusCharacterLimit(
  providerName: string | undefined,
  configuredMaxCharacters: unknown,
): SemanticCorpusCharacterLimitResolution {
  const providerDefaultLimit = resolveSemanticCorpusInputCharacterLimit(providerName);
  const parsed = coercePositiveInteger(configuredMaxCharacters);
  if (parsed !== null) {
    return {
      maxCharacters: parsed,
      warning: null,
    };
  }
  return {
    maxCharacters: providerDefaultLimit,
    warning:
      configuredMaxCharacters === undefined || configuredMaxCharacters === null
        ? null
        : SEARCH_EMBEDDING_CORPUS_MAX_CHARACTERS_INVALID_WARNING,
  };
}

export interface SemanticCorpusInputOptions {
  providerName?: string;
  maxCharacters?: number;
  /**
   * Corpus field names to include. When omitted, the full default set is used
   * (see {@link DEFAULT_SEARCH_CORPUS_FIELDS}). Thread the resolved list from
   * {@link resolveSearchCorpusFields} so the embedded input honours
   * `search.corpus_fields`.
   */
  fields?: string[];
}

export function buildSemanticCorpusInput(document: ItemDocument, options: SemanticCorpusInputOptions = {}): string {
  const serialized = JSON.stringify(buildSearchCorpus(document, { fields: options.fields }));
  const maxCharacters = resolveSemanticCorpusCharacterLimit(options.providerName, options.maxCharacters)
    .maxCharacters;
  if (serialized.length <= maxCharacters) {
    return serialized;
  }
  if (maxCharacters <= SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length) {
    return SEMANTIC_CORPUS_TRUNCATION_SUFFIX.slice(0, maxCharacters);
  }
  const keepLength = Math.max(0, maxCharacters - SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length);
  return `${serialized.slice(0, keepLength)}${SEMANTIC_CORPUS_TRUNCATION_SUFFIX}`;
}
