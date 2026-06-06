export interface CommanderOptionAliasContract {
  target: string;
  keys: readonly string[];
}

export interface CommanderOptionRegistrationContract extends CommanderOptionAliasContract {
  option: string;
  description: string;
  required?: boolean;
  repeatable?: boolean;
  aliasOptions?: Array<{
    option: string;
    description: string;
  }>;
}

export const LIST_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "status", keys: ["status"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "updatedAfter", keys: ["updatedAfter"] },
  { target: "updatedBefore", keys: ["updatedBefore"] },
  { target: "createdAfter", keys: ["createdAfter"] },
  { target: "createdBefore", keys: ["createdBefore"] },
  { target: "assignee", keys: ["assignee"] },
  { target: "assigneeFilter", keys: ["assigneeFilter", "assignee_filter"] },
  { target: "parent", keys: ["parent"] },
  { target: "sprint", keys: ["sprint"] },
  { target: "release", keys: ["release"] },
  { target: "limit", keys: ["limit"] },
  { target: "offset", keys: ["offset"] },
  { target: "fields", keys: ["fields"] },
  { target: "sort", keys: ["sort"] },
  { target: "order", keys: ["order"] },
];

export const SEARCH_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "mode", keys: ["mode"] },
  { target: "semanticWeight", keys: ["semanticWeight", "semantic_weight"] },
  { target: "status", keys: ["status"] },
  { target: "type", keys: ["type"] },
  { target: "tag", keys: ["tag"] },
  { target: "priority", keys: ["priority"] },
  { target: "deadlineBefore", keys: ["deadlineBefore"] },
  { target: "deadlineAfter", keys: ["deadlineAfter"] },
  { target: "fields", keys: ["fields"] },
  { target: "limit", keys: ["limit"] },
];

export const CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
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
  { target: "recurrenceLookaheadDays", keys: ["recurrenceLookaheadDays", "recurrence_lookahead_days"] },
  { target: "recurrenceLookbackDays", keys: ["recurrenceLookbackDays", "recurrence_lookback_days"] },
  { target: "occurrenceLimit", keys: ["occurrenceLimit", "occurrence_limit"] },
  { target: "format", keys: ["format"] },
];

export const CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
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
  { target: "limit", keys: ["limit"] },
  { target: "format", keys: ["format"] },
  { target: "depth", keys: ["depth"] },
  { target: "activityLimit", keys: ["activityLimit", "activity_limit"] },
  { target: "staleThreshold", keys: ["staleThreshold", "stale_threshold"] },
];

export const ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS: CommanderOptionAliasContract[] = [
  { target: "id", keys: ["id"] },
  { target: "op", keys: ["op"] },
  { target: "author", keys: ["author"] },
  { target: "from", keys: ["from"] },
  { target: "to", keys: ["to"] },
  { target: "limit", keys: ["limit"] },
];

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
