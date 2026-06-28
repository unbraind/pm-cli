/**
 * @module cli/commands/item-filter-options
 *
 * Shared item-filter option contracts used by command implementations and SDK-facing types.
 */

/**
 * Common scalar item filters accepted by list/search-style commands.
 */
export interface SharedItemScalarFilterOptions {
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  assignee?: string;
  parent?: string;
  sprint?: string;
  release?: string;
}

/**
 * Common governance-metadata presence filters accepted by item query commands.
 */
export interface SharedGovernanceMissingFilterOptions {
  filterReviewerMissing?: boolean;
  filterRiskMissing?: boolean;
  filterConfidenceMissing?: boolean;
  filterSprintMissing?: boolean;
  filterReleaseMissing?: boolean;
}

/**
 * Common content-field presence filters accepted by item query commands.
 */
export interface SharedContentFieldFilterOptions {
  hasNotes?: boolean;
  hasLearnings?: boolean;
  hasFiles?: boolean;
  hasDocs?: boolean;
  hasTests?: boolean;
  hasComments?: boolean;
  hasDeps?: boolean;
  hasBody?: boolean;
  hasLinkedCommand?: boolean;
  noNotes?: boolean;
  noLearnings?: boolean;
  noFiles?: boolean;
  noDocs?: boolean;
  noTests?: boolean;
  noComments?: boolean;
  noDeps?: boolean;
  emptyBody?: boolean;
  noLinkedCommand?: boolean;
}

/**
 * Base option shape for item query commands with schema/runtime extension flags.
 */
export interface SharedItemFilterOptions
  extends SharedItemScalarFilterOptions,
    SharedGovernanceMissingFilterOptions,
    SharedContentFieldFilterOptions {
  [key: string]: unknown;
}
