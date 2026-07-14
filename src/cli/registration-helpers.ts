/**
 * @module cli/registration-helpers
 *
 * Provides CLI runtime support for Registration Helpers.
 */
import { Option, type Command } from "commander";
import { pathExists } from "../core/fs/fs-utils.js";
import { normalizeStatusInput } from "../core/item/status.js";
import { refreshSearchArtifactsForMutation } from "../core/search/cache.js";
import { shouldRunSearchRefreshInForeground } from "../core/search/background-refresh.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { printError, printResult, writeStdout } from "../core/output/output.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import {
  runActiveServiceOverride,
  setActiveCommandResult,
} from "../core/extensions/index.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { ItemStatus } from "../types/index.js";
import {
  ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  NEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
  readFirstValueFromCommanderOptions,
  readFirstStringFromCommanderOptions,
  readStringArrayFromCommanderOptions,
} from "../sdk/cli-contracts.js";
import type { CommanderOptionAliasContract } from "../sdk/cli-contracts.js";
import type {
  ContextOptions,
  CreateCommandOptions,
  AggregateOptions,
  ListOptions,
  NextOptions,
} from "./commands/index.js";
import type { runList, runActivity } from "./commands/index.js";

export { printError, printResult, writeStdout };

/** Let an active package asynchronously augment a completed command result. */
export async function applyActiveCommandResultService(
  command: string,
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
  result: unknown,
): Promise<unknown> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const override = await runActiveServiceOverride("command_result", {
    command,
    args,
    options,
    global,
    pm_root: pmRoot,
    result,
  });
  return override.handled ? override.result : result;
}

/** Synchronize parser-derived options with Commander and its action arguments. */
export function syncCommanderActionOptions(
  actionCommand: Command,
  commandOptions: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(commandOptions)) {
    actionCommand.setOptionValueWithSource(key, value, "cli");
  }
}

function readJoinedRepeatedOption(
  options: Record<string, unknown>,
  contract: CommanderOptionAliasContract,
): string | undefined {
  const values: string[] = [];
  const observedArrays = new Set<unknown[]>();
  for (const key of contract.keys) {
    if (!Object.hasOwn(options, key)) {
      continue;
    }
    const value = options[key];
    if (value == null) {
      continue;
    }
    if (typeof value === "string") {
      values.push(value);
      continue;
    }
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      return undefined;
    }
    if (observedArrays.has(value)) {
      continue;
    }
    observedArrays.add(value);
    values.push(...value);
  }
  return values.length > 0 ? values.join("; ") : undefined;
}

const RESOLVED_GLOBAL_OPTIONS = Symbol("pm.resolvedGlobalOptions");

type CommandWithResolvedGlobals = Command & {
  [RESOLVED_GLOBAL_OPTIONS]?: GlobalOptions;
};

interface CommandOptionsReader {
  optsWithGlobals?: () => Record<string, unknown>;
  opts?: () => Record<string, unknown>;
}

function commandOptionsReader(command: unknown): CommandOptionsReader {
  return typeof command === "object" && command !== null
    ? (command as CommandOptionsReader)
    : {};
}

// Resolves the alias contract for a normalize target, falling back to a
// single-key contract if the target is somehow absent from the contract table.
function resolveCommanderContract(
  contracts: CommanderOptionAliasContract[],
  target: string,
): CommanderOptionAliasContract {
  const contract = contracts.find((entry) => entry.target === target);
  /* c8 ignore start -- every normalize target is present in its contract table (verified by contract drift tests); the fallback is a defensive guard against future drift */
  return contract ?? { target, keys: [target] };
  /* c8 ignore stop */
}

/** Implements set resolved global options for the public runtime surface of this module. */
export function setResolvedGlobalOptions(
  command: Command,
  globalOptions: GlobalOptions,
): void {
  (command as CommandWithResolvedGlobals)[RESOLVED_GLOBAL_OPTIONS] = {
    ...globalOptions,
  };
}

/** Implements clear resolved global options for the public runtime surface of this module. */
export function clearResolvedGlobalOptions(command: Command): void {
  delete (command as CommandWithResolvedGlobals)[RESOLVED_GLOBAL_OPTIONS];
}

/** Implements get global options for the public runtime surface of this module. */
export function getGlobalOptions(command: Command): GlobalOptions {
  const resolved = (command as CommandWithResolvedGlobals)[
    RESOLVED_GLOBAL_OPTIONS
  ];
  if (resolved) {
    return { ...resolved };
  }
  const reader = commandOptionsReader(command);
  const opts =
    typeof reader.optsWithGlobals === "function"
      ? reader.optsWithGlobals()
      : typeof reader.opts === "function"
        ? reader.opts()
        : {};
  return {
    json: opts.json === true ? true : undefined,
    quiet: Boolean(opts.quiet),
    noChangedFields: opts.changedFields === false,
    idOnly: opts.idOnly === true,
    path:
      typeof opts.pmPath === "string"
        ? opts.pmPath
        : typeof opts.path === "string"
          ? opts.path
          : undefined,
    noExtensions: opts.extensions === false,
    noPager: Boolean(opts.noPager),
    profile: Boolean(opts.profile),
    author: typeof opts.author === "string" ? opts.author : undefined,
  };
}

/** Implements get command path for the public runtime surface of this module. */
export function getCommandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(" ");
}

/** Implements apply default output format for the public runtime surface of this module. */
export async function applyDefaultOutputFormat(
  globalOptions: GlobalOptions,
): Promise<GlobalOptions> {
  if (globalOptions.json === true) {
    return globalOptions;
  }
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return globalOptions;
  }
  const settings = await readSettings(pmRoot);
  return {
    ...globalOptions,
    defaultOutputFormat: settings.output.default_format,
  };
}

/** Implements collect for the public runtime surface of this module. */
export function collect(
  value: string,
  previous: string[] | undefined,
): string[] {
  const next = previous ?? [];
  next.push(value);
  return next;
}

function pushOptionalValueFlag(
  args: string[],
  flag: string,
  value: unknown,
): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  args.push(flag, trimmed);
}

function pushOptionalBooleanFlag(
  args: string[],
  flag: string,
  value: unknown,
): void {
  if (value === true) {
    args.push(flag);
  }
}

function pushRepeatableValueFlag(
  args: string[],
  flag: string,
  values: unknown,
): void {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    args.push(flag, trimmed);
  }
}

function optionTrue(
  options: Record<string, unknown>,
  key: string,
): true | undefined {
  return options[key] === true ? true : undefined;
}

function optionFalse(
  options: Record<string, unknown>,
  key: string,
): true | undefined {
  return options[key] === false ? true : undefined;
}

/** Reads an option value when Commander supplied it as a string. */
export function readOptionString(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof options[key] === "string" ? options[key] : undefined;
}

/** Adds a Commander option that remains parseable but hidden from human help. */
export function addHiddenOption(
  command: Command,
  flags: string,
  description: string,
): void {
  command.addOption(new Option(flags, description).hideHelp());
}

function anyOptionTrue(
  options: Record<string, unknown>,
  keys: readonly string[],
): true | undefined {
  return keys.some((key) => options[key] === true) ? true : undefined;
}

function copyUnknownOptions(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (Object.hasOwn(target, key)) {
      continue;
    }
    target[key] = value;
  }
}

/** Implements build background test command args for the public runtime surface of this module. */
export function buildBackgroundTestCommandArgs(
  id: string,
  options: Record<string, unknown>,
): string[] {
  const args: string[] = ["test", id, "--run", "--json", "--progress"];
  pushRepeatableValueFlag(args, "--add", options.add);
  pushRepeatableValueFlag(args, "--add-json", options.addJson);
  pushRepeatableValueFlag(args, "--remove", options.remove);
  pushOptionalValueFlag(args, "--match", options.match);
  pushOptionalValueFlag(args, "--only-index", options.onlyIndex);
  pushOptionalBooleanFlag(args, "--only-last", options.onlyLast);
  pushSharedBackgroundTestCommandArgs(args, options);
  pushOptionalValueFlag(args, "--author", options.author);
  pushOptionalValueFlag(args, "--message", options.message);
  pushOptionalBooleanFlag(args, "--force", options.force);
  return args;
}

function pushSharedBackgroundTestCommandArgs(
  args: string[],
  options: Record<string, unknown>,
): void {
  pushOptionalValueFlag(args, "--timeout", options.timeout);
  pushRepeatableValueFlag(args, "--env-set", options.envSet);
  pushRepeatableValueFlag(args, "--env-clear", options.envClear);
  pushOptionalBooleanFlag(args, "--shared-host-safe", options.sharedHostSafe);
  pushOptionalValueFlag(args, "--pm-context", options.pmContext);
  pushOptionalBooleanFlag(
    args,
    "--override-linked-pm-context",
    options.overrideLinkedPmContext,
  );
  pushOptionalBooleanFlag(
    args,
    "--fail-on-context-mismatch",
    options.failOnContextMismatch,
  );
  pushOptionalBooleanFlag(args, "--fail-on-skipped", options.failOnSkipped);
  pushOptionalBooleanFlag(
    args,
    "--fail-on-empty-test-run",
    options.failOnEmptyTestRun,
  );
  pushOptionalBooleanFlag(
    args,
    "--require-assertions-for-pm",
    options.requireAssertionsForPm,
  );
  pushOptionalBooleanFlag(args, "--check-context", options.checkContext);
  pushOptionalBooleanFlag(args, "--auto-pm-context", options.autoPmContext);
}

/** Implements build background test all command args for the public runtime surface of this module. */
export function buildBackgroundTestAllCommandArgs(
  options: Record<string, unknown>,
): string[] {
  const args: string[] = ["test-all", "--json", "--progress"];
  pushOptionalValueFlag(args, "--status", options.status);
  pushOptionalValueFlag(args, "--limit", options.limit);
  pushOptionalValueFlag(args, "--offset", options.offset);
  pushSharedBackgroundTestCommandArgs(args, options);
  return args;
}

/** Implements format hook warnings for the public runtime surface of this module. */
export function formatHookWarnings(warnings: string[]): string {
  return warnings.join(",");
}

/** Implements normalize create options for the public runtime surface of this module. */
export function normalizeCreateOptions(
  commandOptions: Record<string, unknown>,
  options: { requireType?: boolean } = {},
): CreateCommandOptions {
  const readCreateString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      commandOptions,
      resolveCommanderContract(
        CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
  const readCreateList = (target: string): string[] | undefined =>
    readStringArrayFromCommanderOptions(
      commandOptions,
      resolveCommanderContract(
        CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
        target,
      ),
    );

  const type = readCreateString("type");
  if (options.requireType !== false && type === undefined) {
    throw new PmCliError(
      "Missing required option --type <value>. Why required: create resolves runtime schema fields/workflow from item type. Retry: add --type <built-in or configured custom type> (example: --type Task).",
      EXIT_CODE.USAGE,
    );
  }

  const normalized: Record<string, unknown> = {
    title: readCreateString("title"),
    description: readCreateString("description"),
    type,
    template: readCreateString("template"),
    createMode: readCreateString("createMode"),
    schedulePreset: readCreateString("schedulePreset"),
    status: readCreateString("status"),
    priority: readCreateString("priority"),
    tags: readCreateString("tags"),
    addTags: readCreateList("addTags"),
    body: readCreateString("body"),
    deadline: readCreateString("deadline"),
    estimatedMinutes: readCreateString("estimatedMinutes"),
    acceptanceCriteria: readJoinedRepeatedOption(
      commandOptions,
      resolveCommanderContract(
        CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
        "acceptanceCriteria",
      ),
    ),
    definitionOfReady: readCreateString("definitionOfReady"),
    order: readCreateString("order"),
    rank: readCreateString("rank"),
    goal: readCreateString("goal"),
    objective: readCreateString("objective"),
    value: readCreateString("value"),
    impact: readCreateString("impact"),
    outcome: readCreateString("outcome"),
    whyNow: readCreateString("whyNow"),
    author: readCreateString("author"),
    message: readCreateString("message"),
    assignee: readCreateString("assignee"),
    parent: readCreateString("parent"),
    allowMissingParent:
      optionTrue(commandOptions, "allowMissingParent") === true,
    reviewer: readCreateString("reviewer"),
    risk: readCreateString("risk"),
    confidence: readCreateString("confidence"),
    sprint: readCreateString("sprint"),
    release: readCreateString("release"),
    blockedBy: readCreateString("blockedBy"),
    blockedReason: readCreateString("blockedReason"),
    unblockNote: readCreateString("unblockNote"),
    reporter: readCreateString("reporter"),
    severity: readCreateString("severity"),
    environment: readCreateString("environment"),
    reproSteps: readCreateString("reproSteps"),
    resolution: readCreateString("resolution"),
    expectedResult: readCreateString("expectedResult"),
    actualResult: readCreateString("actualResult"),
    affectedVersion: readCreateString("affectedVersion"),
    fixedVersion: readCreateString("fixedVersion"),
    component: readCreateString("component"),
    regression: readCreateString("regression"),
    customerImpact: readCreateString("customerImpact"),
    dep: readCreateList("dep"),
    comment: readCreateList("comment"),
    note: readCreateList("note"),
    learning: readCreateList("learning"),
    file: readCreateList("file"),
    test: readCreateList("test"),
    doc: readCreateList("doc"),
    reminder: readCreateList("reminder"),
    event: readCreateList("event"),
    typeOption: readCreateList("typeOption"),
    field: readCreateList("field"),
    unset: readCreateList("unset"),
    clearDeps: optionTrue(commandOptions, "clearDeps"),
    clearComments: optionTrue(commandOptions, "clearComments"),
    clearNotes: optionTrue(commandOptions, "clearNotes"),
    clearLearnings: optionTrue(commandOptions, "clearLearnings"),
    clearFiles: optionTrue(commandOptions, "clearFiles"),
    clearTests: optionTrue(commandOptions, "clearTests"),
    clearDocs: optionTrue(commandOptions, "clearDocs"),
    clearReminders: optionTrue(commandOptions, "clearReminders"),
    clearEvents: optionTrue(commandOptions, "clearEvents"),
    clearTypeOptions: optionTrue(commandOptions, "clearTypeOptions"),
  };
  copyUnknownOptions(normalized, commandOptions);
  return normalized as CreateCommandOptions;
}

/** Implements normalize update options for the public runtime surface of this module. */
export function normalizeUpdateOptions(
  commandOptions: Record<string, unknown>,
): Record<string, unknown> {
  const readUpdateString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      commandOptions,
      resolveCommanderContract(
        UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
  const readUpdateList = (target: string): string[] | undefined =>
    readStringArrayFromCommanderOptions(
      commandOptions,
      resolveCommanderContract(
        UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
        target,
      ),
    );

  const normalized: Record<string, unknown> = {
    title: readUpdateString("title"),
    description: readUpdateString("description"),
    body: readUpdateString("body"),
    status: readUpdateString("status"),
    closeReason: readUpdateString("closeReason"),
    priority: readUpdateString("priority"),
    type: readUpdateString("type"),
    tags: readUpdateString("tags"),
    addTags: readUpdateList("addTags"),
    removeTags: readUpdateList("removeTags"),
    deadline: readUpdateString("deadline"),
    estimatedMinutes: readUpdateString("estimatedMinutes"),
    acceptanceCriteria: readJoinedRepeatedOption(
      commandOptions,
      resolveCommanderContract(
        UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
        "acceptanceCriteria",
      ),
    ),
    definitionOfReady: readUpdateString("definitionOfReady"),
    order: readUpdateString("order"),
    rank: readUpdateString("rank"),
    goal: readUpdateString("goal"),
    objective: readUpdateString("objective"),
    value: readUpdateString("value"),
    impact: readUpdateString("impact"),
    outcome: readUpdateString("outcome"),
    whyNow: readUpdateString("whyNow"),
    author: readUpdateString("author"),
    message: readUpdateString("message"),
    force: Boolean(commandOptions.force),
    ownershipMetadataBypass:
      commandOptions.ownershipMetadataBypass === true ? true : undefined,
    ownershipDependencyBypass:
      commandOptions.ownershipDependencyBypass === true ? true : undefined,
    assignee: readUpdateString("assignee"),
    parent: readUpdateString("parent"),
    reviewer: readUpdateString("reviewer"),
    risk: readUpdateString("risk"),
    confidence: readUpdateString("confidence"),
    sprint: readUpdateString("sprint"),
    release: readUpdateString("release"),
    blockedBy: readUpdateString("blockedBy"),
    blockedReason: readUpdateString("blockedReason"),
    unblockNote: readUpdateString("unblockNote"),
    reporter: readUpdateString("reporter"),
    severity: readUpdateString("severity"),
    environment: readUpdateString("environment"),
    reproSteps: readUpdateString("reproSteps"),
    resolution: readUpdateString("resolution"),
    expectedResult: readUpdateString("expectedResult"),
    actualResult: readUpdateString("actualResult"),
    affectedVersion: readUpdateString("affectedVersion"),
    fixedVersion: readUpdateString("fixedVersion"),
    component: readUpdateString("component"),
    regression: readUpdateString("regression"),
    customerImpact: readUpdateString("customerImpact"),
    dep: readUpdateList("dep"),
    depRemove: readUpdateList("depRemove"),
    replaceDeps: optionTrue(commandOptions, "replaceDeps"),
    replaceTests: optionTrue(commandOptions, "replaceTests"),
    comment: readUpdateList("comment"),
    note: readUpdateList("note"),
    learning: readUpdateList("learning"),
    file: readUpdateList("file"),
    test: readUpdateList("test"),
    doc: readUpdateList("doc"),
    reminder: readUpdateList("reminder"),
    event: readUpdateList("event"),
    typeOption: readUpdateList("typeOption"),
    field: readUpdateList("field"),
    unset: readUpdateList("unset"),
    clearDeps: optionTrue(commandOptions, "clearDeps"),
    clearComments: optionTrue(commandOptions, "clearComments"),
    clearNotes: optionTrue(commandOptions, "clearNotes"),
    clearLearnings: optionTrue(commandOptions, "clearLearnings"),
    clearFiles: optionTrue(commandOptions, "clearFiles"),
    clearTests: optionTrue(commandOptions, "clearTests"),
    clearDocs: optionTrue(commandOptions, "clearDocs"),
    clearReminders: optionTrue(commandOptions, "clearReminders"),
    clearEvents: optionTrue(commandOptions, "clearEvents"),
    clearTypeOptions: optionTrue(commandOptions, "clearTypeOptions"),
  };
  copyUnknownOptions(normalized, commandOptions);
  return normalized;
}

const UPDATE_MANY_CONTROL_OPTION_KEYS = new Set<string>([
  "filterStatus",
  "filterType",
  "filterTag",
  "filterPriority",
  "filterDeadlineBefore",
  "filterDeadlineAfter",
  "filterUpdatedAfter",
  "filterUpdatedBefore",
  "filterCreatedAfter",
  "filterCreatedBefore",
  "filterAssignee",
  "filterAssigneeFilter",
  "filterAssignee_filter",
  "filterParent",
  "filterSprint",
  "filterRelease",
  "filterAcMissing",
  "filterEstimatesMissing",
  "filterEstimateMissing",
  "filterResolutionMissing",
  "filterMetadataMissing",
  "filterReviewerMissing",
  "filterRiskMissing",
  "filterConfidenceMissing",
  "filterSprintMissing",
  "filterReleaseMissing",
  "filterHasNotes",
  "filterNoNotes",
  "filterHasLearnings",
  "filterNoLearnings",
  "filterHasFiles",
  "filterNoFiles",
  "filterHasDocs",
  "filterNoDocs",
  "filterHasTests",
  "filterNoTests",
  "filterHasComments",
  "filterNoComments",
  "filterHasDeps",
  "filterNoDeps",
  "filterHasBody",
  "filterEmptyBody",
  "filterHasLinkedCommand",
  "filterNoLinkedCommand",
  "ids",
  "limit",
  "offset",
  "dryRun",
  "rollback",
  "checkpoint",
]);

/** Implements extract update many mutation option source for the public runtime surface of this module. */
export function extractUpdateManyMutationOptionSource(
  commandOptions: Record<string, unknown>,
): Record<string, unknown> {
  const mutationOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(commandOptions)) {
    if (UPDATE_MANY_CONTROL_OPTION_KEYS.has(key)) {
      continue;
    }
    mutationOptions[key] = value;
  }
  return mutationOptions;
}

function readListOptionString(
  options: Record<string, unknown>,
  target: string,
): string | undefined {
  const contract = resolveCommanderContract(
    LIST_COMMANDER_STRING_OPTION_CONTRACTS,
    target,
  );
  const stringValue = readFirstStringFromCommanderOptions(options, contract);
  if (stringValue !== undefined) {
    return stringValue;
  }
  for (const key of contract.keys) {
    const value = options[key];
    /* c8 ignore start -- unreachable: readFirstStringFromCommanderOptions already returns above for any string value under contract.keys, so a string here cannot occur */
    if (target === "ids" && typeof value === "string") {
      return value;
    }
    /* c8 ignore stop */
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

// Shared governance-missing (GH-236) + content-field presence/absence (GH-242)
// selection-filter fields. Presence flags are plain booleans; absence uses
// commander negation (`--no-notes` stores notes=false) except --empty-body
// which is its own dest. The docs/files `--filter-*-missing` aliases mirror
// `--no-*` while keeping the raw alias keys accounted for before passthrough.
// Spread into normalizeListOptions and normalizeSearchOptions at the same
// position so key order is preserved.
function readSelectionFilterOptionFields(
  options: Record<string, unknown>,
): Record<string, true | undefined> {
  const filterFilesMissing = optionTrue(options, "filterFilesMissing");
  const filterDocsMissing = optionTrue(options, "filterDocsMissing");
  return {
    filterReviewerMissing: optionTrue(options, "filterReviewerMissing"),
    filterRiskMissing: optionTrue(options, "filterRiskMissing"),
    filterConfidenceMissing: optionTrue(options, "filterConfidenceMissing"),
    filterSprintMissing: optionTrue(options, "filterSprintMissing"),
    filterReleaseMissing: optionTrue(options, "filterReleaseMissing"),
    hasNotes: optionTrue(options, "hasNotes"),
    hasLearnings: optionTrue(options, "hasLearnings"),
    hasFiles: optionTrue(options, "hasFiles"),
    hasDocs: optionTrue(options, "hasDocs"),
    hasTests: optionTrue(options, "hasTests"),
    hasComments: optionTrue(options, "hasComments"),
    hasDeps: optionTrue(options, "hasDeps"),
    hasBody: optionTrue(options, "hasBody"),
    hasLinkedCommand: optionTrue(options, "hasLinkedCommand"),
    noNotes: optionFalse(options, "notes"),
    noLearnings: optionFalse(options, "learnings"),
    noFiles: optionFalse(options, "files") ?? filterFilesMissing,
    filterFilesMissing,
    noDocs: optionFalse(options, "docs") ?? filterDocsMissing,
    filterDocsMissing,
    noTests: optionFalse(options, "tests"),
    noComments: optionFalse(options, "comments"),
    noDeps: optionFalse(options, "deps"),
    emptyBody: optionTrue(options, "emptyBody"),
    noLinkedCommand: optionFalse(options, "linkedCommand"),
  };
}

/** Implements normalize list options for the public runtime surface of this module. */
export function normalizeListOptions(
  options: Record<string, unknown>,
): ListOptions {
  const normalized: Record<string, unknown> = {
    status: readListOptionString(options, "status"),
    type: readListOptionString(options, "type"),
    tag: readListOptionString(options, "tag"),
    priority: readListOptionString(options, "priority"),
    deadlineBefore: readListOptionString(options, "deadlineBefore"),
    deadlineAfter: readListOptionString(options, "deadlineAfter"),
    updatedAfter: readListOptionString(options, "updatedAfter"),
    updatedBefore: readListOptionString(options, "updatedBefore"),
    createdAfter: readListOptionString(options, "createdAfter"),
    createdBefore: readListOptionString(options, "createdBefore"),
    today: optionTrue(options, "today"),
    recent: optionTrue(options, "recent"),
    ids: readListOptionString(options, "ids"),
    assignee: readListOptionString(options, "assignee"),
    assigneeFilter: readListOptionString(options, "assigneeFilter"),
    parent: readListOptionString(options, "parent"),
    sprint: readListOptionString(options, "sprint"),
    release: readListOptionString(options, "release"),
    limit: readListOptionString(options, "limit"),
    offset: readListOptionString(options, "offset"),
    // Commander stores --no-truncate as truncate=false; --all is the positive alias.
    noTruncate: optionFalse(options, "truncate") ?? optionTrue(options, "all"),
    includeBody: optionTrue(options, "includeBody"),
    compact: optionTrue(options, "compact"),
    brief: optionTrue(options, "brief"),
    full: optionTrue(options, "full"),
    fields: readListOptionString(options, "fields"),
    sort: readListOptionString(options, "sort"),
    order: readListOptionString(options, "order"),
    tree: optionTrue(options, "tree"),
    treeDepth: readListOptionString(options, "treeDepth"),
    filterAcMissing: optionTrue(options, "filterAcMissing"),
    filterEstimatesMissing: anyOptionTrue(options, [
      "filterEstimatesMissing",
      "filterEstimateMissing",
    ]),
    filterResolutionMissing: optionTrue(options, "filterResolutionMissing"),
    filterMetadataMissing: optionTrue(options, "filterMetadataMissing"),
    // Governance-missing (GH-236) + content presence/absence (GH-242) filters.
    ...readSelectionFilterOptionFields(options),
  };
  copyUnknownOptions(normalized, options);
  return normalized as ListOptions;
}

/** Implements normalize aggregate options for the public runtime surface of this module. */
export function normalizeAggregateOptions(
  options: Record<string, unknown>,
): AggregateOptions {
  return {
    groupBy: typeof options.groupBy === "string" ? options.groupBy : undefined,
    count: options.count === true ? true : undefined,
    completion: options.completion === true ? true : undefined,
    sum: typeof options.sum === "string" ? options.sum : undefined,
    avg: typeof options.avg === "string" ? options.avg : undefined,
    includeUnparented:
      options.includeUnparented === true || options.include_unparented === true,
    status: typeof options.status === "string" ? options.status : undefined,
    type: readListOptionString(options, "type"),
    tag: readListOptionString(options, "tag"),
    priority: readListOptionString(options, "priority"),
    deadlineBefore: readListOptionString(options, "deadlineBefore"),
    deadlineAfter: readListOptionString(options, "deadlineAfter"),
    assignee: readListOptionString(options, "assignee"),
    assigneeFilter: readListOptionString(options, "assigneeFilter"),
    parent: readListOptionString(options, "parent"),
    sprint: readListOptionString(options, "sprint"),
    release: readListOptionString(options, "release"),
  };
}

type ListCommandResult = Awaited<ReturnType<typeof runList>>;

/** Implements print list json stream for the public runtime surface of this module. */
export function printListJsonStream(
  commandName: string,
  result: ListCommandResult,
  globalOptions: GlobalOptions,
): void {
  setActiveCommandResult(result);
  if (globalOptions.quiet) {
    return;
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const metaPayload: Record<string, unknown> = {
    type: "meta",
    command: commandName,
    count: result.count,
    now: result.now,
    filters: result.filters,
  };
  if (warnings.length > 0) {
    metaPayload.warnings = warnings;
  }
  if (!writeStdout(`${JSON.stringify(metaPayload)}\n`)) {
    return;
  }
  for (const item of result.items) {
    if (
      !writeStdout(
        `${JSON.stringify({ type: "item", command: commandName, item })}\n`,
      )
    ) {
      return;
    }
  }
  writeStdout(
    `${JSON.stringify({ type: "end", command: commandName, count: result.count })}\n`,
  );
}

type ActivityCommandResult = Awaited<ReturnType<typeof runActivity>>;

/** Implements print activity json stream for the public runtime surface of this module. */
export function printActivityJsonStream(
  result: ActivityCommandResult,
  options: {
    id?: string;
    op?: string;
    author?: string;
    from?: string;
    to?: string;
    limit?: string;
  },
  globalOptions: GlobalOptions,
): void {
  setActiveCommandResult(result);
  if (globalOptions.quiet) {
    return;
  }
  const metaPayload = {
    type: "meta",
    command: "activity",
    count: result.count,
    filters: {
      id: options.id ?? null,
      op: options.op ?? null,
      author: options.author ?? null,
      from: options.from ?? null,
      to: options.to ?? null,
      limit: options.limit ?? null,
    },
  };
  if (!writeStdout(`${JSON.stringify(metaPayload)}\n`)) {
    return;
  }
  const entries =
    result.compact && result.compact_activity
      ? result.compact_activity
      : result.activity;
  for (const entry of entries) {
    if (
      !writeStdout(
        `${JSON.stringify({ type: "entry", command: "activity", entry })}\n`,
      )
    ) {
      return;
    }
  }
  writeStdout(
    `${JSON.stringify({ type: "end", command: "activity", count: result.count })}\n`,
  );
}

/** Implements normalize search options for the public runtime surface of this module. */
export function normalizeSearchOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const readSearchString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      resolveCommanderContract(
        SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
  const readSearchStringOrNumber = (
    target: string,
  ): string | number | undefined => {
    const candidate = readFirstValueFromCommanderOptions(
      options,
      resolveCommanderContract(
        SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
    if (typeof candidate === "string") {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    return undefined;
  };
  const fields = readSearchString("fields");
  const compactRequested = options.compact === true;
  const fullRequested = options.full === true;
  const defaultCompact =
    !compactRequested && !fullRequested && fields === undefined;
  const mode =
    options.semantic === true
      ? "semantic"
      : options.hybrid === true
        ? "hybrid"
        : readSearchString("mode");
  const normalized: Record<string, unknown> = {
    mode,
    matchMode: readSearchString("matchMode"),
    minScore: readSearchStringOrNumber("minScore"),
    count: optionTrue(options, "count"),
    semanticWeight: readSearchStringOrNumber("semanticWeight"),
    includeLinked: optionTrue(options, "includeLinked"),
    titleExact: optionTrue(options, "titleExact"),
    phraseExact: optionTrue(options, "phraseExact"),
    highlight: optionTrue(options, "highlight"),
    status: readSearchString("status"),
    type: readSearchString("type"),
    tag: readSearchString("tag"),
    priority: readSearchString("priority"),
    deadlineBefore: readSearchString("deadlineBefore"),
    deadlineAfter: readSearchString("deadlineAfter"),
    updatedAfter: readSearchString("updatedAfter"),
    updatedBefore: readSearchString("updatedBefore"),
    createdAfter: readSearchString("createdAfter"),
    createdBefore: readSearchString("createdBefore"),
    assignee: readSearchString("assignee"),
    sprint: readSearchString("sprint"),
    release: readSearchString("release"),
    parent: readSearchString("parent"),
    limit: readSearchString("limit"),
    fields,
    compact: compactRequested || defaultCompact ? true : undefined,
    full: optionTrue(options, "full"),
    // Governance-missing (GH-236) + content presence/absence (GH-242) filters,
    // mirroring normalizeListOptions via the shared field slice.
    ...readSelectionFilterOptionFields(options),
  };
  copyUnknownOptions(normalized, options);
  return normalized;
}

/** Implements normalize search keywords input for the public runtime surface of this module. */
export function normalizeSearchKeywordsInput(keywords: string[]): string {
  const query = keywords
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(" ");
  if (query.length === 0) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return query;
}

/** Implements normalize activity options for the public runtime surface of this module. */
export function normalizeActivityOptions(options: Record<string, unknown>): {
  id?: string;
  op?: string;
  author?: string;
  from?: string;
  to?: string;
  limit?: string;
  compact?: boolean;
} {
  const readActivityString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      resolveCommanderContract(
        ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
  return {
    id: readActivityString("id"),
    op: readActivityString("op"),
    author: readActivityString("author"),
    from: readActivityString("from"),
    to: readActivityString("to"),
    limit: readActivityString("limit"),
    compact:
      options.full === true ? false : options.compact === false ? false : true,
  };
}

const ACTIVITY_STREAM_ENABLED_VALUES = new Set([
  "",
  "rows",
  "ndjson",
  "jsonl",
  "true",
  "1",
  "yes",
  "on",
]);
const ACTIVITY_STREAM_DISABLED_VALUES = new Set(["false", "off", "none", "0"]);

/** Implements resolve activity stream mode for the public runtime surface of this module. */
export function resolveActivityStreamMode(raw: unknown): boolean {
  if (raw === true) {
    return true;
  }
  if (raw === false || raw === undefined || raw === null) {
    return false;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (ACTIVITY_STREAM_ENABLED_VALUES.has(normalized)) {
      return true;
    }
    if (ACTIVITY_STREAM_DISABLED_VALUES.has(normalized)) {
      return false;
    }
  }
  throw new PmCliError(
    "Activity --stream accepts rows|ndjson|jsonl (or no value)",
    EXIT_CODE.USAGE,
  );
}

/** Implements normalize context options for the public runtime surface of this module. */
export function normalizeContextOptions(
  options: Record<string, unknown>,
): ContextOptions {
  const readContextString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      resolveCommanderContract(
        CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
        target,
      ),
    );
  const sectionRaw = options.section;
  const section: string[] | undefined = Array.isArray(sectionRaw)
    ? (sectionRaw as string[]).filter(
        (v) => typeof v === "string" && v.trim().length > 0,
      )
    : typeof sectionRaw === "string" && sectionRaw.trim().length > 0
      ? [sectionRaw]
      : undefined;
  const normalized: Record<string, unknown> = {
    date: readContextString("date"),
    from: readContextString("from"),
    to: readContextString("to"),
    past: options.past === true ? true : undefined,
    type: readContextString("type"),
    tag: readContextString("tag"),
    priority: readContextString("priority"),
    assignee: readContextString("assignee"),
    assigneeFilter: readContextString("assigneeFilter"),
    sprint: readContextString("sprint"),
    release: readContextString("release"),
    parent: readContextString("parent"),
    limit: readContextString("limit"),
    format: readContextString("format"),
    depth: readContextString("depth"),
    fields: readContextString("fields"),
    section: section && section.length > 0 ? section : undefined,
    activityLimit: readContextString("activityLimit"),
    staleThreshold: readContextString("staleThreshold"),
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as ContextOptions;
}

/**
 * Normalizes raw commander options for `pm next` into a typed {@link NextOptions}
 * payload, resolving snake_case flag aliases (e.g. `--assignee_filter`,
 * `--blocked_limit`, `--ready_only`) to their canonical camelCase keys and folding
 * the boolean `--ready-only` switch. Unknown keys are passed through untouched so
 * downstream filtering still sees them.
 */
export function normalizeNextOptions(
  options: Record<string, unknown>,
): NextOptions {
  const readNextString = (target: string): string | undefined =>
    readFirstStringFromCommanderOptions(
      options,
      resolveCommanderContract(NEXT_COMMANDER_STRING_OPTION_CONTRACTS, target),
    );
  const normalized: Record<string, unknown> = {
    type: readNextString("type"),
    tag: readNextString("tag"),
    priority: readNextString("priority"),
    assignee: readNextString("assignee"),
    assigneeFilter: readNextString("assigneeFilter"),
    sprint: readNextString("sprint"),
    release: readNextString("release"),
    parent: readNextString("parent"),
    limit: readNextString("limit"),
    blockedLimit: readNextString("blockedLimit"),
    readyOnly:
      options.readyOnly === true || options.ready_only === true
        ? true
        : undefined,
    format: readNextString("format"),
  };
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(normalized, key)) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized as NextOptions;
}

function collectMutationItemIds(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const ids = new Set<string>();
  const pushId = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
      return;
    }
    ids.add(normalized);
  };

  pushId(record.id);

  const item = record.item;
  if (item && typeof item === "object") {
    pushId((item as { id?: unknown }).id);
  }

  const explicitIds = record.ids;
  if (Array.isArray(explicitIds)) {
    for (const candidate of explicitIds) {
      pushId(candidate);
    }
  }

  const items = record.items;
  if (Array.isArray(items)) {
    for (const candidate of items) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      pushId((candidate as { id?: unknown }).id);
    }
  }

  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Implements invalidate search caches for mutation for the public runtime surface of this module. */
export async function invalidateSearchCachesForMutation(
  globalOptions: GlobalOptions,
  result?: unknown,
): Promise<void> {
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const refreshResult = await refreshSearchArtifactsForMutation(
    pmRoot,
    collectMutationItemIds(result),
    {
      background: !shouldRunSearchRefreshInForeground(),
    },
  );
  if (globalOptions.profile && refreshResult.warnings.length > 0) {
    printError(
      `profile:search_refresh_warnings=${formatHookWarnings(refreshResult.warnings)}`,
    );
  }
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  collectMutationItemIds,
};
