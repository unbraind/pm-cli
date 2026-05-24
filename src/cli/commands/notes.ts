import type { GlobalOptions } from "../../core/shared/command-types.js";
import { createStdinTokenResolver } from "../../core/item/parse.js";
import type { LogNote } from "../../types/index.js";
import { parseAnnotationTextInput, runAnnotationCommand } from "./annotation-command.js";

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

export async function runNotes(id: string, options: NotesCommandOptions, global: GlobalOptions): Promise<NotesResult> {
  const stdinResolver = createStdinTokenResolver();
  const addInput = options.add === undefined ? undefined : await stdinResolver.resolveValue(options.add, "--add");

  return runAnnotationCommand<"notes", LogNote>(id, options, global, {
    input: options.add === undefined ? { mode: "list" } : { mode: "add", value: addInput ?? "", emptyFlag: "--add" },
    collectionKey: "notes",
    op: "note_add",
    parseText: (raw) => parseAnnotationTextInput(raw),
    allowAuditBypass: Boolean(options.allowAuditNote || options.allowAuditComment),
    conflictGuidance: {
      required:
        "For append-only note audits on another owner's item, prefer --allow-audit-note (legacy alias: --allow-audit-comment) before considering --force.",
      examples: ['pm notes pm-a1b2 --add "audit note" --author "reviewer" --allow-audit-note'],
      nextSteps: [
        "Retry with --allow-audit-note (or legacy --allow-audit-comment) for append-only note audits that do not mutate item metadata beyond notes.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
