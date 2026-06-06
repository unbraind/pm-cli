import type { ItemDocument, ItemMetadata } from "../../types/index.js";
import { coercePositiveInteger } from "../shared/primitives.js";

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

export function buildSearchCorpus(document: ItemDocument): Record<string, unknown> {
  const item = document.metadata;
  const plan = buildPlanCorpus(item);
  const corpus: Record<string, unknown> = {
    title: item.title,
    description: item.description,
    tags: item.tags,
    status: item.status,
    body: document.body,
    comments: (item.comments ?? []).map((entry) => entry.text),
    notes: (item.notes ?? []).map((entry) => entry.text),
    learnings: (item.learnings ?? []).map((entry) => entry.text),
    reminders: buildReminderCorpus(item),
    events: buildEventCorpus(item),
    dependencies: (item.dependencies ?? []).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
    })),
  };
  if (plan) {
    corpus.plan = plan;
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
}

export function buildSemanticCorpusInput(document: ItemDocument, options: SemanticCorpusInputOptions = {}): string {
  const serialized = JSON.stringify(buildSearchCorpus(document));
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
