import type { ItemDocument, ItemFrontMatter } from "../../types/index.js";

export const DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS = 8_000;
export const OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS = 3_200;
export const SEMANTIC_CORPUS_TRUNCATION_SUFFIX = "...[semantic corpus truncated]";

function compactParts(parts: Array<string | boolean | number | null | undefined>): string {
  return parts
    .map((part) => (part === undefined || part === null ? "" : String(part).trim()))
    .filter((part) => part.length > 0)
    .join(" ");
}

export function buildReminderCorpus(item: ItemFrontMatter): string[] {
  return (item.reminders ?? []).map((reminder) => compactParts([reminder.at, reminder.text]));
}

export function buildEventCorpus(item: ItemFrontMatter): string[] {
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

export function buildSearchCorpus(document: ItemDocument): Record<string, unknown> {
  const item = document.front_matter;
  return {
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
}

function resolveSemanticCorpusInputMaxCharacters(candidate: number | undefined): number {
  if (Number.isFinite(candidate) && Number(candidate) > 0) {
    return Math.floor(Number(candidate));
  }
  return DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS;
}

export function resolveSemanticCorpusInputCharacterLimit(providerName: string | undefined): number {
  if (providerName?.trim().toLowerCase() === "ollama") {
    return OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS;
  }
  return DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS;
}

export interface SemanticCorpusInputOptions {
  providerName?: string;
  maxCharacters?: number;
}

export function buildSemanticCorpusInput(document: ItemDocument, options: SemanticCorpusInputOptions = {}): string {
  const serialized = JSON.stringify(buildSearchCorpus(document));
  const maxCharacters = resolveSemanticCorpusInputMaxCharacters(
    options.maxCharacters ?? resolveSemanticCorpusInputCharacterLimit(options.providerName),
  );
  if (serialized.length <= maxCharacters) {
    return serialized;
  }
  if (maxCharacters <= SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length) {
    return SEMANTIC_CORPUS_TRUNCATION_SUFFIX.slice(0, maxCharacters);
  }
  const keepLength = Math.max(0, maxCharacters - SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length);
  return `${serialized.slice(0, keepLength)}${SEMANTIC_CORPUS_TRUNCATION_SUFFIX}`;
}
