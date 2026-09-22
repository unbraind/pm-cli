/**
 * @module sdk/cli-contracts/commander-types
 *
 * Maps Commander option aliases to SDK fields and preserves precedence when normalizing CLI input.
 */
/** Describes aliases accepted by Commander option registration contracts. */
export interface CommanderOptionAliasContract {
  /** Canonical SDK option key receiving the selected alias value. */
  target: string;
  /** Commander option keys in precedence order; the first matching value wins. */
  keys: readonly string[];
}

/** Declares Commander registration syntax and how its parsed values map to SDK options. */
export interface CommanderOptionRegistrationContract extends CommanderOptionAliasContract {
  /** Commander flag syntax, including short aliases and argument placeholders. */
  option: string;
  /** Human-readable flag help displayed by Commander. */
  description: string;
  /** Whether Commander requires this option to be supplied. */
  required?: boolean;
  /** Whether repeated occurrences accumulate values instead of replacing the previous value. */
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

/** Return the first string-valued alias in declared precedence order, including an explicitly empty string. */
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

/** Return the first own alias property, preserving explicitly undefined values and ignoring inherited properties. */
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

/** Concatenate string entries from all array-valued aliases in declaration order; return undefined when none remain. */
export function readStringArrayFromCommanderOptions(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string[] | undefined {
  const values: string[] = [];
  for (const key of contract.keys) {
    const candidate = options[key];
    if (Array.isArray(candidate)) {
      values.push(
        ...candidate.filter((value): value is string => typeof value === "string"),
      );
    }
  }
  return values.length > 0 ? values : undefined;
}
