/**
 * @module cli/commands/learnings
 *
 * Implements the pm learnings command surface and its agent-facing runtime behavior.
 */
import { type GlobalOptions } from "./runtime-primitives.js";
import type { LogNote } from "../types/index.js";
import {
  type AnnotationMutationReceipt,
  type AnnotationOmissionReceipt,
  parseAnnotationTextInput,
  resolveAnnotationInput,
  runAnnotationCommand,
} from "./annotations.js";

/** Documents the learnings command options payload exchanged by command, SDK, and package integrations. */
export interface LearningsCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string;
  /** Read learning text from stdin. */
  stdin?: boolean;
  /** Read learning text from a UTF-8 file. */
  file?: string;
  /** Replace the learning at this one-based index. */
  edit?: number;
  /** Delete the learning at this one-based index. */
  delete?: number;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Return complete learning history after a mutation instead of a bounded receipt. */
  fullHistory?: boolean;
  /** Append only when no learning has the same resolved author and text. */
  ifAbsent?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
}

/** Documents the learnings result payload exchanged by command, SDK, and package integrations. */
export interface LearningsResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports learnings for this contract. */
  learnings: LogNote[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Total learning count after the mutation. */
  total_count?: number;
  /** Number of learning entries returned in this projection. */
  returned_count?: number;
  /** Whether additional stored learning entries were withheld. */
  has_more?: boolean;
  /** Applied read limit when one was requested. */
  limit?: number;
  /** Mutation identity when this result changed the collection. */
  mutation_receipt?: AnnotationMutationReceipt;
  /** Declares whether older learnings were withheld from a mutation response. */
  omission_receipt?: AnnotationOmissionReceipt;
  /** Whether a requested mutation changed persisted state. */
  changed?: boolean;
}

/** Implements run learnings for the public runtime surface of this module. */
export async function runLearnings(
  id: string,
  options: LearningsCommandOptions,
  global: GlobalOptions,
): Promise<LearningsResult> {
  return runAnnotationCommand<"learnings", LogNote>(id, options, global, {
    input: await resolveAnnotationInput(options, "learning"),
    collectionKey: "learnings",
    op: "learning_add",
    editOp: "learning_edit",
    deleteOp: "learning_delete",
    parseText: (raw) => parseAnnotationTextInput(raw),
    createEntry: (entry) => entry,
    bypassOwnershipConflict: Boolean(
      options.edit === undefined &&
      options.delete === undefined &&
      (
        options as LearningsCommandOptions & {
          ownershipAppendBypass?: boolean;
        }
      ).ownershipAppendBypass,
    ),
    conflictGuidance: {
      required:
        "For an approved append-only handoff on another owner's item, use the package-provided ownership bypass before considering --force.",
      examples: [
        'pm learnings pm-a1b2 --add "review learning" --author "reviewer" --force',
      ],
      nextSteps: [
        "Use an installed package's narrow append-only ownership bypass when available.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
