/**
 * @module cli/commands/notes
 *
 * Implements the pm notes command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { LogNote } from "../../types/index.js";
import {
  parseAnnotationTextInput,
  resolveAnnotationInput,
  runAnnotationCommand,
} from "../../sdk/annotations.js";

/** Documents the notes command options payload exchanged by command, SDK, and package integrations. */
export interface NotesCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string;
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
}

/** Implements run notes for the public runtime surface of this module. */
export async function runNotes(
  id: string,
  options: NotesCommandOptions,
  global: GlobalOptions,
): Promise<NotesResult> {
  return runAnnotationCommand<"notes", LogNote>(id, options, global, {
    input: await resolveAnnotationInput(options, "note"),
    collectionKey: "notes",
    op: "note_add",
    editOp: "note_edit",
    deleteOp: "note_delete",
    parseText: (raw) => parseAnnotationTextInput(raw),
    bypassOwnershipConflict: Boolean(
      options.edit === undefined && options.delete === undefined &&
        (options as NotesCommandOptions & {
          ownershipAppendBypass?: boolean;
        }).ownershipAppendBypass,
    ),
    conflictGuidance: {
      required:
        "For an approved append-only handoff on another owner's item, use the package-provided ownership bypass before considering --force.",
      examples: ['pm notes pm-a1b2 --add "review note" --author "reviewer" --force'],
      nextSteps: [
        "Use an installed package's narrow append-only ownership bypass when available.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
