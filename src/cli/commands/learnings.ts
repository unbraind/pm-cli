/**
 * @module cli/commands/learnings
 *
 * Implements the pm learnings command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { LogNote } from "../../types/index.js";
import {
  parseAnnotationTextInput,
  resolveAnnotationInput,
  runAnnotationCommand,
} from "../../sdk/annotations.js";

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
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports allow audit learning for this contract. */
  allowOwnershipLearningBypass?: boolean;
  /** Value that configures or reports allow audit comment for this contract. */
  allowOwnershipAppendBypass?: boolean;
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
    bypassOwnershipConflict: Boolean(
      options.allowOwnershipLearningBypass || options.allowOwnershipAppendBypass,
    ),
    conflictGuidance: {
      required:
        "For append-only learning audits on another owner's item, prefer the learning ownership bypass (legacy alias: the annotation ownership bypass) before considering --force.",
      examples: [
        'pm learnings pm-a1b2 --add "audit learning" --author "reviewer" the learning ownership bypass',
      ],
      nextSteps: [
        "Retry with the learning ownership bypass (or legacy the annotation ownership bypass) for append-only learning audits that do not mutate item metadata beyond learnings.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
