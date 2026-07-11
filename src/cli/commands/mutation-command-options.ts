/**
 * @module cli/commands/mutation-command-options
 *
 * Defines shared create/update option fields used by mutation command surfaces.
 */

/** Documents metadata mutation options shared by create and update command payloads. */
export interface MutationMetadataCommandOptions {
  /** Value that configures or reports deadline for this contract. */
  deadline?: string;
  /** Value that configures or reports estimated minutes for this contract. */
  estimatedMinutes?: string;
  /** Value that configures or reports acceptance criteria for this contract. */
  acceptanceCriteria?: string;
  /** Value that configures or reports definition of ready for this contract. */
  definitionOfReady?: string;
  /** Value that configures or reports order for this contract. */
  order?: string;
  /** Value that configures or reports rank for this contract. */
  rank?: string;
  /** Value that configures or reports goal for this contract. */
  goal?: string;
  /** Value that configures or reports objective for this contract. */
  objective?: string;
  /** Value that configures or reports value for this contract. */
  value?: string;
  /** Value that configures or reports impact for this contract. */
  impact?: string;
  /** Value that configures or reports outcome for this contract. */
  outcome?: string;
  /** Value that configures or reports why now for this contract. */
  whyNow?: string;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Human-readable explanation suitable for logs and agent-facing output. */
  message?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports reviewer for this contract. */
  reviewer?: string;
  /** Value that configures or reports risk for this contract. */
  risk?: string;
  /** Value that configures or reports confidence for this contract. */
  confidence?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports blocked by for this contract. */
  blockedBy?: string;
  /** Value that configures or reports blocked reason for this contract. */
  blockedReason?: string;
  /** Value that configures or reports unblock note for this contract. */
  unblockNote?: string;
  /** Value that configures or reports reporter for this contract. */
  reporter?: string;
  /** Value that configures or reports severity for this contract. */
  severity?: string;
  /** Value that configures or reports environment for this contract. */
  environment?: string;
  /** Value that configures or reports repro steps for this contract. */
  reproSteps?: string;
  /** Value that configures or reports resolution for this contract. */
  resolution?: string;
  /** Structured result returned by the expected operation. */
  expectedResult?: string;
  /** Structured result returned by the actual operation. */
  actualResult?: string;
  /** Value that configures or reports affected version for this contract. */
  affectedVersion?: string;
  /** Value that configures or reports fixed version for this contract. */
  fixedVersion?: string;
  /** Value that configures or reports component for this contract. */
  component?: string;
  /** Value that configures or reports regression for this contract. */
  regression?: string;
  /** Value that configures or reports customer impact for this contract. */
  customerImpact?: string;
}

/** Documents repeatable linked-resource option payloads accepted by create/update commands. */
export interface SharedLinkedResourceOptions {
  /** Value that configures or reports comment for this contract. */
  comment?: string[];
  /** Value that configures or reports note for this contract. */
  note?: string[];
  /** Value that configures or reports learning for this contract. */
  learning?: string[];
  /** Value that configures or reports file for this contract. */
  file?: string[];
  /** Value that configures or reports test for this contract. */
  test?: string[];
  /** Value that configures or reports doc for this contract. */
  doc?: string[];
  /** Value that configures or reports dep for this contract. */
  dep?: string[];
  /** Value that configures or reports reminder for this contract. */
  reminder?: string[];
  /** Value that configures or reports event for this contract. */
  event?: string[];
  /** Value that configures or reports type option for this contract. */
  typeOption?: string[];
  /** Value that configures or reports field for this contract. */
  field?: string[];
}

/** Documents shared linked-resource clear flags accepted by create/update commands. */
export interface SharedLinkedResourceClearOptions {
  /** Value that configures or reports unset for this contract. */
  unset?: string[];
  /** Value that configures or reports clear deps for this contract. */
  clearDeps?: boolean;
  /** Value that configures or reports clear comments for this contract. */
  clearComments?: boolean;
  /** Value that configures or reports clear notes for this contract. */
  clearNotes?: boolean;
  /** Value that configures or reports clear learnings for this contract. */
  clearLearnings?: boolean;
  /** Value that configures or reports clear files for this contract. */
  clearFiles?: boolean;
  /** Value that configures or reports clear tests for this contract. */
  clearTests?: boolean;
  /** Value that configures or reports clear docs for this contract. */
  clearDocs?: boolean;
  /** Value that configures or reports clear reminders for this contract. */
  clearReminders?: boolean;
  /** Value that configures or reports clear events for this contract. */
  clearEvents?: boolean;
  /** Inputs that customize the clear type operation. */
  clearTypeOptions?: boolean;
}
