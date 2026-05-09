import type { ItemDocument, ItemFrontMatter } from "../../types/index.js";

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
