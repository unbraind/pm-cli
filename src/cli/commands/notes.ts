import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { createStdinTokenResolver, parseCsvKv } from "../../core/item/parse.js";
import { locateItem, mutateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { LogNote } from "../../types/index.js";

export interface NotesCommandOptions {
  add?: string;
  limit?: string;
  author?: string;
  message?: string;
  allowAuditNote?: boolean;
  allowAuditComment?: boolean;
  force?: boolean;
}

export interface NotesResult {
  id: string;
  notes: LogNote[];
  count: number;
}

function resolveAuthor(candidate: string | undefined, fallback: string): string {
  const resolved = candidate ?? process.env.PM_AUTHOR ?? fallback;
  const trimmed = resolved.trim();
  return trimmed || "unknown";
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Invalid --limit value", EXIT_CODE.USAGE);
  }
  return Math.floor(parsed);
}

function limitNotes(values: LogNote[], limit: number | undefined): LogNote[] {
  if (limit === undefined) return values;
  if (limit === 0) return [];
  return values.slice(Math.max(0, values.length - limit));
}

function parseNoteTextInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const looksStructured = /^(?:[-*+]\s*)?text\s*[:=]/im.test(trimmed) || trimmed.startsWith("```");
  if (!looksStructured) {
    return trimmed;
  }
  try {
    const kv = parseCsvKv(trimmed, "--add");
    const text = kv.text?.trim();
    return text || trimmed;
  } catch {
    return trimmed;
  }
}

export async function runNotes(id: string, options: NotesCommandOptions, global: GlobalOptions): Promise<NotesResult> {
  const stdinResolver = createStdinTokenResolver();
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const limit = parseLimit(options.limit);

  if (options.add === undefined) {
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
    if (!located) {
      throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
    }
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    const notes = limitNotes(loaded.document.front_matter.notes ?? [], limit);
    return {
      id: located.id,
      notes,
      count: notes.length,
    };
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const addInput = await stdinResolver.resolveValue(options.add, "--add");
  const text = parseNoteTextInput(addInput ?? "");
  if (!text) {
    throw new PmCliError("--add text cannot be empty", EXIT_CODE.USAGE);
  }

  let result: Awaited<ReturnType<typeof mutateItem>>;
  try {
    result = await mutateItem({
      pmRoot,
      settings,
      id,
      op: "note_add",
      author,
      message: options.message,
      force: options.force,
      bypassAssigneeConflict: Boolean(options.allowAuditNote || options.allowAuditComment),
      mutate(document) {
        const notes = document.front_matter.notes ?? [];
        notes.push({
          created_at: nowIso(),
          author,
          text,
        });
        document.front_matter.notes = notes;
        return { changedFields: ["notes"] };
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof PmCliError &&
      error.exitCode === EXIT_CODE.CONFLICT &&
      error.message.includes("is assigned to") &&
      error.message.includes("Use --force to override")
    ) {
      throw new PmCliError(error.message, error.exitCode, {
        code: "ownership_conflict",
        required:
          "For append-only note audits on another owner's item, prefer --allow-audit-note (legacy alias: --allow-audit-comment) before considering --force.",
        examples: ['pm notes pm-a1b2 --add "audit note" --author "reviewer" --allow-audit-note'],
        nextSteps: [
          "Retry with --allow-audit-note (or legacy --allow-audit-comment) for append-only note audits that do not mutate item metadata beyond notes.",
          "Use --force only when an ownership override is explicitly approved.",
        ],
      });
    }
    throw error;
  }

  const notes = limitNotes(result.item.notes as LogNote[], limit);
  return {
    id: result.item.id,
    notes,
    count: notes.length,
  };
}
