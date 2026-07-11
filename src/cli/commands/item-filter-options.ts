/**
 * @module cli/commands/item-filter-options
 *
 * Shared item-filter option contracts used by command implementations and SDK-facing types.
 */

/** Common scalar item filters accepted by list/search-style commands. */
export interface SharedItemScalarFilterOptions {
  /** Lifecycle state reported for status. */
  status?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Value that configures or reports deadline before for this contract. */
  deadlineBefore?: string;
  /** Value that configures or reports deadline after for this contract. */
  deadlineAfter?: string;
  /** Value that configures or reports updated after for this contract. */
  updatedAfter?: string;
  /** Value that configures or reports updated before for this contract. */
  updatedBefore?: string;
  /** Value that configures or reports created after for this contract. */
  createdAfter?: string;
  /** Value that configures or reports created before for this contract. */
  createdBefore?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
}

/** Common governance-metadata presence filters accepted by item query commands. */
export interface SharedGovernanceMissingFilterOptions {
  /** Value that configures or reports filter reviewer missing for this contract. */
  filterReviewerMissing?: boolean;
  /** Value that configures or reports filter risk missing for this contract. */
  filterRiskMissing?: boolean;
  /** Value that configures or reports filter confidence missing for this contract. */
  filterConfidenceMissing?: boolean;
  /** Value that configures or reports filter sprint missing for this contract. */
  filterSprintMissing?: boolean;
  /** Value that configures or reports filter release missing for this contract. */
  filterReleaseMissing?: boolean;
}

/** Common content-field presence filters accepted by item query commands. */
export interface SharedContentFieldFilterOptions {
  /** Whether notes applies to this operation. */
  hasNotes?: boolean;
  /** Whether learnings applies to this operation. */
  hasLearnings?: boolean;
  /** Whether files applies to this operation. */
  hasFiles?: boolean;
  /** Whether docs applies to this operation. */
  hasDocs?: boolean;
  /** Whether tests applies to this operation. */
  hasTests?: boolean;
  /** Whether comments applies to this operation. */
  hasComments?: boolean;
  /** Whether deps applies to this operation. */
  hasDeps?: boolean;
  /** Whether body applies to this operation. */
  hasBody?: boolean;
  /** Whether linked command applies to this operation. */
  hasLinkedCommand?: boolean;
  /** Value that configures or reports no notes for this contract. */
  noNotes?: boolean;
  /** Value that configures or reports no learnings for this contract. */
  noLearnings?: boolean;
  /** Value that configures or reports no files for this contract. */
  noFiles?: boolean;
  /** Value that configures or reports filter files missing for this contract. */
  filterFilesMissing?: boolean;
  /** Value that configures or reports no docs for this contract. */
  noDocs?: boolean;
  /** Value that configures or reports filter docs missing for this contract. */
  filterDocsMissing?: boolean;
  /** Value that configures or reports no tests for this contract. */
  noTests?: boolean;
  /** Value that configures or reports no comments for this contract. */
  noComments?: boolean;
  /** Value that configures or reports no deps for this contract. */
  noDeps?: boolean;
  /** Value that configures or reports empty body for this contract. */
  emptyBody?: boolean;
  /** Value that configures or reports no linked command for this contract. */
  noLinkedCommand?: boolean;
}

/** Base option shape for item query commands with schema/runtime extension flags. */
export interface SharedItemFilterOptions
  extends
    SharedItemScalarFilterOptions,
    SharedGovernanceMissingFilterOptions,
    SharedContentFieldFilterOptions {
  [key: string]: unknown;
}
