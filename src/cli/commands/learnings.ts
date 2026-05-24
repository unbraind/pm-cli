import type { GlobalOptions } from "../../core/shared/command-types.js";
import { createStdinTokenResolver } from "../../core/item/parse.js";
import type { LogNote } from "../../types/index.js";
import { parseAnnotationTextInput, runAnnotationCommand } from "./annotation-command.js";

export interface LearningsCommandOptions {
  add?: string;
  limit?: string;
  author?: string;
  message?: string;
  allowAuditLearning?: boolean;
  allowAuditComment?: boolean;
  force?: boolean;
}

export interface LearningsResult {
  id: string;
  learnings: LogNote[];
  count: number;
}

export async function runLearnings(
  id: string,
  options: LearningsCommandOptions,
  global: GlobalOptions,
): Promise<LearningsResult> {
  const stdinResolver = createStdinTokenResolver();
  const addInput = options.add === undefined ? undefined : await stdinResolver.resolveValue(options.add, "--add");

  return runAnnotationCommand<"learnings", LogNote>(id, options, global, {
    input: options.add === undefined ? { mode: "list" } : { mode: "add", value: addInput ?? "", emptyFlag: "--add" },
    collectionKey: "learnings",
    op: "learning_add",
    parseText: (raw) => parseAnnotationTextInput(raw),
    allowAuditBypass: Boolean(options.allowAuditLearning || options.allowAuditComment),
    conflictGuidance: {
      required:
        "For append-only learning audits on another owner's item, prefer --allow-audit-learning (legacy alias: --allow-audit-comment) before considering --force.",
      examples: ['pm learnings pm-a1b2 --add "audit learning" --author "reviewer" --allow-audit-learning'],
      nextSteps: [
        "Retry with --allow-audit-learning (or legacy --allow-audit-comment) for append-only learning audits that do not mutate item metadata beyond learnings.",
        "Use --force only when an ownership override is explicitly approved.",
      ],
    },
  });
}
