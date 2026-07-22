/**
 * @module sdk/cli-contracts/commander-types
 *
 * Defines SDK command-contract metadata for Commander Types.
 */
/** Describes aliases accepted by Commander option registration contracts. */
export interface CommanderOptionAliasContract {
  /** Value that configures or reports target for this contract. */
  target: string;
  /** Value that configures or reports keys for this contract. */
  keys: readonly string[];
}

/** Documents the commander option registration contract payload exchanged by command, SDK, and package integrations. */
export interface CommanderOptionRegistrationContract extends CommanderOptionAliasContract {
  /** Value that configures or reports option for this contract. */
  option: string;
  /** Value that configures or reports description for this contract. */
  description: string;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports repeatable for this contract. */
  repeatable?: boolean;
  /** Inputs that customize the alias operation. */
  aliasOptions?: Array<{
    option: string;
    description: string;
  }>;
}

/** Public contract for list commander string option contracts, shared by SDK and presentation-layer consumers. */
export const LIST_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "status", keys: ["status"] },
    { target: "type", keys: ["type"] },
    { target: "tag", keys: ["tag", "tags"] },
    { target: "priority", keys: ["priority"] },
    { target: "deadlineBefore", keys: ["deadlineBefore"] },
    { target: "deadlineAfter", keys: ["deadlineAfter"] },
    { target: "updatedAfter", keys: ["updatedAfter"] },
    { target: "updatedBefore", keys: ["updatedBefore"] },
    { target: "createdAfter", keys: ["createdAfter"] },
    { target: "createdBefore", keys: ["createdBefore"] },
    { target: "ids", keys: ["ids"] },
    { target: "assignee", keys: ["assignee"] },
    { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
    { target: "parent", keys: ["parent"] },
    { target: "sprint", keys: ["sprint"] },
    { target: "release", keys: ["release"] },
    { target: "limit", keys: ["limit"] },
    { target: "offset", keys: ["offset"] },
    { target: "after", keys: ["after"] },
    { target: "fields", keys: ["fields"] },
    { target: "sort", keys: ["sort"] },
    { target: "order", keys: ["order"] },
    { target: "treeDepth", keys: ["treeDepth", "tree_depth"] },
  ];

/** Public contract for search commander string option contracts, shared by SDK and presentation-layer consumers. */
export const SEARCH_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "mode", keys: ["mode"] },
    { target: "matchMode", keys: ["matchMode", "match_mode"] },
    { target: "minScore", keys: ["minScore", "min_score"] },
    { target: "semanticWeight", keys: ["semanticWeight", "semantic_weight"] },
    { target: "status", keys: ["status"] },
    { target: "type", keys: ["type"] },
    { target: "tag", keys: ["tag", "tags"] },
    { target: "priority", keys: ["priority"] },
    { target: "deadlineBefore", keys: ["deadlineBefore"] },
    { target: "deadlineAfter", keys: ["deadlineAfter"] },
    { target: "updatedAfter", keys: ["updatedAfter"] },
    { target: "updatedBefore", keys: ["updatedBefore"] },
    { target: "createdAfter", keys: ["createdAfter"] },
    { target: "createdBefore", keys: ["createdBefore"] },
    { target: "assignee", keys: ["assignee"] },
    { target: "sprint", keys: ["sprint"] },
    { target: "release", keys: ["release"] },
    { target: "parent", keys: ["parent"] },
    { target: "fields", keys: ["fields"] },
    { target: "limit", keys: ["limit"] },
    { target: "after", keys: ["after"] },
  ];

/** Public contract for calendar commander string option contracts, shared by SDK and presentation-layer consumers. */
export const CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "view", keys: ["view"] },
    { target: "date", keys: ["date"] },
    { target: "from", keys: ["from"] },
    { target: "to", keys: ["to"] },
    { target: "limit", keys: ["limit"] },
    { target: "type", keys: ["type"] },
    { target: "tag", keys: ["tag"] },
    { target: "priority", keys: ["priority"] },
    { target: "status", keys: ["status"] },
    { target: "assignee", keys: ["assignee"] },
    { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
    { target: "sprint", keys: ["sprint"] },
    { target: "release", keys: ["release"] },
    { target: "include", keys: ["include"] },
    {
      target: "recurrenceLookaheadDays",
      keys: ["recurrenceLookaheadDays", "recurrence_lookahead_days"],
    },
    {
      target: "recurrenceLookbackDays",
      keys: ["recurrenceLookbackDays", "recurrence_lookback_days"],
    },
    {
      target: "occurrenceLimit",
      keys: ["occurrenceLimit", "occurrence_limit"],
    },
    { target: "format", keys: ["format"] },
  ];

/** Public contract for context commander string option contracts, shared by SDK and presentation-layer consumers. */
export const CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "date", keys: ["date"] },
    { target: "from", keys: ["from"] },
    { target: "to", keys: ["to"] },
    { target: "type", keys: ["type"] },
    { target: "tag", keys: ["tag"] },
    { target: "priority", keys: ["priority"] },
    { target: "assignee", keys: ["assignee"] },
    { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
    { target: "sprint", keys: ["sprint"] },
    { target: "release", keys: ["release"] },
    { target: "parent", keys: ["parent"] },
    { target: "limit", keys: ["limit", "maxItems", "max_items"] },
    { target: "after", keys: ["after"] },
    { target: "format", keys: ["format"] },
    { target: "depth", keys: ["depth"] },
    { target: "fields", keys: ["fields"] },
    { target: "activityLimit", keys: ["activityLimit", "activity_limit"] },
    { target: "staleThreshold", keys: ["staleThreshold", "stale_threshold"] },
    { target: "tokenBudget", keys: ["tokenBudget", "token_budget"] },
  ];

/** Public contract for next commander string option contracts, shared by SDK and presentation-layer consumers. */
export const NEXT_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "type", keys: ["type"] },
    { target: "tag", keys: ["tag"] },
    { target: "priority", keys: ["priority"] },
    { target: "assignee", keys: ["assignee"] },
    { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
    { target: "sprint", keys: ["sprint"] },
    { target: "release", keys: ["release"] },
    { target: "parent", keys: ["parent"] },
    { target: "limit", keys: ["limit"] },
    { target: "blockedLimit", keys: ["blockedLimit", "blocked_limit"] },
    { target: "format", keys: ["format"] },
    { target: "tokenBudget", keys: ["tokenBudget", "token_budget"] },
  ];

/** Public contract for activity commander string option contracts, shared by SDK and presentation-layer consumers. */
export const ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] =
  [
    { target: "id", keys: ["id"] },
    { target: "op", keys: ["op"] },
    { target: "author", keys: ["author"] },
    { target: "from", keys: ["from"] },
    { target: "to", keys: ["to"] },
    { target: "limit", keys: ["limit"] },
  ];

/** Implements read first string from commander options for the public runtime surface of this module. */
export function readFirstStringFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string | undefined {
  for (const key of contract.keys) {
    const candidate = options[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

/** Implements read first value from commander options for the public runtime surface of this module. */
export function readFirstValueFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): unknown {
  for (const key of contract.keys) {
    if (Object.hasOwn(options, key)) {
      return options[key];
    }
  }
  return undefined;
}

/** Implements read string array from commander options for the public runtime surface of this module. */
export function readStringArrayFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string[] | undefined {
  for (const key of contract.keys) {
    const candidate = options[key];
    if (Array.isArray(candidate)) {
      return candidate as string[];
    }
  }
  return undefined;
}
