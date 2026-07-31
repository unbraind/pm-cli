/**
 * @module cli/commands/notes
 *
 * Implements the pm notes command surface and its agent-facing runtime behavior.
 */
import {
  EXIT_CODE,
  PmCliError,
  parseLimit,
  stableStringify,
  type GlobalOptions,
} from "../../sdk/runtime-primitives.js";
import type {
  LogNote,
  StructuredJsonValue,
  StructuredLogEvent,
} from "../../types/index.js";
import {
  limitAnnotationEntries,
  parseAnnotationTextInput,
  resolveAnnotationInput,
  runAnnotationCommand,
} from "../../sdk/annotations.js";

/** Documents the notes command options payload exchanged by command, SDK, and package integrations. */
export interface NotesCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string;
  /** Append a validated JSON context event to the merge-safe notes collection. */
  addJson?: string;
  /** Read note text from stdin. */
  stdin?: boolean;
  /** Read note text from a UTF-8 file. */
  file?: string;
  /** Replace the note at this one-based index. */
  edit?: number;
  /** Delete the note at this one-based index. */
  delete?: number;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Return structured events created at or after this ISO timestamp. */
  since?: string;
  /** Return structured events whose top-level `type` property matches this value. */
  eventType?: string;
  /** Include total, returned, and truncation metadata. */
  includeMeta?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the notes result payload exchanged by command, SDK, and package integrations. */
export interface NotesResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports notes for this contract. */
  notes: LogNote[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Total entries before limit and structured-event filters. */
  total_count?: number;
  /** Number of entries returned after filtering and limiting. */
  returned_count?: number;
  /** Whether additional matching entries were omitted by the limit. */
  has_more?: boolean;
  /** Applied result limit. */
  limit?: number;
  /** Number of structured context events in the returned projection. */
  structured_event_count?: number;
}

function parseStructuredEventPayload(
  raw: string | undefined,
): StructuredJsonValue | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim().length === 0) {
    throw new PmCliError(
      "--add-json must contain a JSON value",
      EXIT_CODE.USAGE,
      { code: "structured_event_json_empty" },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PmCliError("--add-json must be valid JSON", EXIT_CODE.USAGE, {
      code: "structured_event_json_invalid",
    });
  }
  return parsed as StructuredJsonValue;
}

function structuredEventType(value: StructuredJsonValue): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value.type;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function parseSinceTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new PmCliError(
      "--since must be a valid ISO timestamp",
      EXIT_CODE.USAGE,
      { code: "structured_event_since_invalid" },
    );
  }
  return timestamp;
}

/** Implements run notes for the public runtime surface of this module. */
export async function runNotes(
  id: string,
  options: NotesCommandOptions,
  global: GlobalOptions,
): Promise<NotesResult> {
  const structuredPayload = parseStructuredEventPayload(options.addJson);
  const conflictingStructuredInputs = [
    options.add !== undefined,
    options.stdin === true,
    options.file !== undefined,
    options.edit !== undefined,
    options.delete !== undefined,
  ].includes(true);
  if (structuredPayload !== undefined && conflictingStructuredInputs) {
    throw new PmCliError(
      "--add-json cannot be combined with text, edit, delete, stdin, or file inputs",
      EXIT_CODE.USAGE,
      { code: "structured_event_input_conflict" },
    );
  }
  const canonicalJson =
    structuredPayload === undefined
      ? undefined
      : stableStringify(structuredPayload);
  const filteringEvents = [options.since, options.eventType].some(
    (value) => value !== undefined,
  );
  const sinceTimestamp = parseSinceTimestamp(options.since);
  const result = await runAnnotationCommand<"notes", LogNote>(
    id,
    {
      ...options,
      ...(filteringEvents ? { limit: undefined } : {}),
      includeMeta: [options.includeMeta === true, filteringEvents].includes(
        true,
      ),
    },
    global,
    {
      input: await resolveAnnotationInput(
        canonicalJson === undefined ? options : { add: canonicalJson },
        "note",
      ),
      collectionKey: "notes",
      op: "note_add",
      editOp: "note_edit",
      deleteOp: "note_delete",
      parseText: (raw) => parseAnnotationTextInput(raw),
      createEntry: (entry: LogNote): LogNote | StructuredLogEvent =>
        structuredPayload === undefined
          ? entry
          : {
              ...entry,
              format: "json",
              data: structuredPayload,
              event_type: structuredEventType(structuredPayload),
            },
      bypassOwnershipConflict: Boolean(
        [
          options.edit === undefined,
          options.delete === undefined,
          (
            options as NotesCommandOptions & {
              ownershipAppendBypass?: boolean;
            }
          ).ownershipAppendBypass === true,
        ].every(Boolean),
      ),
      conflictGuidance: {
        required:
          "For an approved append-only handoff on another owner's item, use the package-provided ownership bypass before considering --force.",
        examples: [
          'pm notes pm-a1b2 --add "review note" --author "reviewer" --force',
        ],
        nextSteps: [
          "Use an installed package's narrow append-only ownership bypass when available.",
          "Use --force only when an ownership override is explicitly approved.",
        ],
      },
    },
  );
  const eventType = options.eventType?.trim();
  const matching = result.notes.filter((note) => {
    const isStructured = [
      note.format === "json",
      note.data !== undefined,
    ].every(Boolean);
    const matchesSince = [
      sinceTimestamp === undefined,
      Date.parse(note.created_at) >=
        (sinceTimestamp ?? Number.POSITIVE_INFINITY),
    ].includes(true);
    const matchesType = [!eventType, note.event_type === eventType].includes(
      true,
    );
    return [
      !filteringEvents,
      [isStructured, matchesSince, matchesType].every(Boolean),
    ].includes(true);
  });
  const limit = parseLimit(options.limit);
  const filtered = filteringEvents
    ? limitAnnotationEntries(matching, limit)
    : matching;
  const structuredEventCount = filtered.filter(
    (note) => note.format === "json",
  ).length;
  return {
    ...result,
    notes: filtered,
    count: filtered.length,
    ...(filteringEvents
      ? {
          total_count: matching.length,
          returned_count: filtered.length,
          has_more: filtered.length < matching.length,
          ...(limit === undefined ? {} : { limit }),
          structured_event_count: structuredEventCount,
        }
      : options.includeMeta === true
        ? {
            structured_event_count: structuredEventCount,
          }
        : {}),
  };
}
