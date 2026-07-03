/**
 * @module cli/commands/mutation-command-options
 *
 * Defines shared create/update option fields used by mutation command surfaces.
 */

/**
 * Documents metadata mutation options shared by create and update command payloads.
 */
export interface MutationMetadataCommandOptions {
  deadline?: string;
  estimatedMinutes?: string;
  acceptanceCriteria?: string;
  definitionOfReady?: string;
  order?: string;
  rank?: string;
  goal?: string;
  objective?: string;
  value?: string;
  impact?: string;
  outcome?: string;
  whyNow?: string;
  author?: string;
  message?: string;
  assignee?: string;
  parent?: string;
  reviewer?: string;
  risk?: string;
  confidence?: string;
  sprint?: string;
  release?: string;
  blockedBy?: string;
  blockedReason?: string;
  unblockNote?: string;
  reporter?: string;
  severity?: string;
  environment?: string;
  reproSteps?: string;
  resolution?: string;
  expectedResult?: string;
  actualResult?: string;
  affectedVersion?: string;
  fixedVersion?: string;
  component?: string;
  regression?: string;
  customerImpact?: string;
}

/**
 * Documents repeatable linked-resource option payloads accepted by create/update commands.
 */
export interface SharedLinkedResourceOptions {
  comment?: string[];
  note?: string[];
  learning?: string[];
  file?: string[];
  test?: string[];
  doc?: string[];
  reminder?: string[];
  event?: string[];
  typeOption?: string[];
  field?: string[];
}

/**
 * Documents shared linked-resource clear flags accepted by create/update commands.
 */
export interface SharedLinkedResourceClearOptions {
  unset?: string[];
  clearDeps?: boolean;
  clearComments?: boolean;
  clearNotes?: boolean;
  clearLearnings?: boolean;
  clearFiles?: boolean;
  clearTests?: boolean;
  clearDocs?: boolean;
  clearReminders?: boolean;
  clearEvents?: boolean;
  clearTypeOptions?: boolean;
}
