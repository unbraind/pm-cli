/**
 * @module cli/commands/learnings
 *
 * Implements the pm learnings command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { createStdinTokenResolver } from "../../core/item/parse.js";
import type { LogNote } from "../../types/index.js";
import {
  parseAnnotationTextInput,
  runAnnotationCommand,
} from "./annotation-command.js";

/** Documents the learnings command options payload exchanged by command, SDK, and package integrations. */
export interface LearningsCommandOptions {
  /** Value that configures or reports add for this contract. */
  add?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports allow audit learning for this contract. */
  allowAuditLearning?: boolean;
  /** Value that configures or reports allow audit comment for this contract. */
  allowAuditComment?: boolean;
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
  const stdinResolver = createStdinTokenResolver();
  const addInput =
    options.add === undefined
      ? undefined
      : await stdinResolver.resolveValue(options.add, "--add");

  return runAnnotationCommand<"learnings", LogNote>(id, options, global, {
    // addInput is defined whenever options.add is defined (see resolveValue), so the cast is safe.
    input:
      options.add === undefined
        ? { mode: "list" }
        : {
            mode: "add",
            value: addInput as string,
            rawValue: options.add,
            emptyFlag: "--add",
          },
    collectionKey: "learnings",
    op: "learning_add",
    parseText: (raw) => parseAnnotationTextInput(raw),
    allowAuditBypass: Boolean(
      options.allowAuditLearning || options.allowAuditComment,
    ),
    conflictGuidance: {
      required:
        "For append-only learning audits on another owner's item, prefer --allow-audit-learning (legacy alias: --allow-audit-comment) before considering --force.",
      examples: [
        'pm learnings pm-a1b2 --add "audit learning" --author "reviewer" --allow-audit-learning',
      ],
      nextSteps: [
        "Retry with --allow-audit-learning (or legacy --allow-audit-comment) for append-only learning audits that do not mutate item metadata beyond learnings.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
