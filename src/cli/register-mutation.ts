/**
 * @module cli/register-mutation
 *
 * Provides CLI runtime support for Register Mutation.
 */
import { Option, type Command } from "commander";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { resolveBodyFileContent } from "../core/io/body-file.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { splitCommaList } from "../core/shared/split-comma-list.js";
import { PmCliError } from "../core/shared/errors.js";
import { isPureSnakeCaseAlias } from "../core/shared/option-alias-visibility.js";
import {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  type CommanderOptionRegistrationContract,
} from "../sdk/cli-contracts.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../types/index.js";

// Lowercase set of built-in type names ("epic", "feature", ...) used by the
// `pm create` positional guard (pm-edge #1, 2026-05-28): if the single
// positional exactly matches a known type AND no --title was given, we throw
// instead of silently creating a Task titled with the type name.
const BUILTIN_TYPE_NAME_LOOKUP = new Set<string>(
  BUILTIN_ITEM_TYPE_VALUES.map((value) => value.toLowerCase()),
);
import {
  collect,
  extractUpdateManyMutationOptionSource,
  formatHookWarnings,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  normalizeCreateOptions,
  normalizeUpdateOptions,
  printError,
  printResult,
  readOptionString,
  writeStdout,
} from "./registration-helpers.js";

/** Register a flag and hide it from `--help` text while keeping it fully functional as a parse-time alias. The option still appears in `command.options`, so the JSON help payload and shell completion (which read from the contracts/commander option list, not the rendered text) are unchanged — only commander's text `--help` omits it. */
function addHiddenOption(
  command: Command,
  flags: string,
  description: string,
  repeatable: boolean,
  repeatableParser: ((value: string) => string[]) | undefined = undefined,
): void {
  const option = new Option(flags, description).hideHelp();
  if (repeatable) {
    option.argParser(repeatableParser ?? collect);
  }
  command.addOption(option);
}

function addHiddenOptions(
  command: Command,
  aliases: ReadonlyArray<readonly [flags: string, description: string]>,
  repeatable: boolean,
): void {
  for (const [flags, description] of aliases) {
    addHiddenOption(command, flags, description, repeatable);
  }
}

const SCHEMA_SHORTHAND_RESERVED_PREFIXES = [
  "add-",
  "apply-",
  "list-",
  "remove-",
  "show-",
] as const;
const SCHEMA_SHORTHAND_RESERVED_TOKENS = new Set([
  "field",
  "fields",
  "help",
  "status",
  "statuses",
  "type",
  "types",
]);

/** Implements looks like schema subcommand typo for the public runtime surface of this module. */
export function looksLikeSchemaSubcommandTypo(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    SCHEMA_SHORTHAND_RESERVED_TOKENS.has(normalized) ||
    SCHEMA_SHORTHAND_RESERVED_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

/** Parse the `--order` value for `pm schema add-status`. Accepts a value that is already a number or a numeric string; throws a usage error when the flag was supplied but does not parse to a finite integer (rather than silently dropping it). Returns `undefined` only when the flag was genuinely not provided. */
export function parseSchemaOrderOption(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new PmCliError(
        "--order must be a finite integer.",
        EXIT_CODE.USAGE,
      );
    }
    return raw;
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(
        "--order must be a finite integer.",
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  }
  throw new PmCliError("--order must be a finite integer.", EXIT_CODE.USAGE);
}

type SchemaCommandModule = typeof import("./commands/schema.js");
type SchemaCommandResult =
  | Awaited<ReturnType<SchemaCommandModule["runSchemaList"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaAddType"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaShow"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaShowStatus"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaRemoveType"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaAddStatus"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaRemoveStatus"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaAddField"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaRemoveField"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaListFields"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaShowField"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaApplyPreset"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaInferTypes"]>>;

interface SchemaDispatchInputs {
  normalizedSubcommand: string;
  typeName: string | undefined;
  options: Record<string, unknown>;
  aliases: string[] | undefined;
  roles: string[] | undefined;
  commands: string[] | undefined;
  requiredTypes: string[] | undefined;
  defaultStatus: string | undefined;
  order: number | undefined;
  minCount: number | undefined;
  author: string | undefined;
  force: boolean;
  description: string | undefined;
  globalOptions: GlobalOptions;
}

/** Routes a normalized `pm schema` subcommand to its run function. Extracted from the schema `.action()` body so the per-subcommand dispatch lives in one single-purpose function and registerMutationCommands stays under the cyclomatic-complexity gate. */
async function dispatchSchemaSubcommand(
  schema: SchemaCommandModule,
  inputs: SchemaDispatchInputs,
): Promise<SchemaCommandResult> {
  const { normalizedSubcommand, typeName, options, globalOptions } = inputs;
  const { author, force, description } = inputs;
  switch (normalizedSubcommand) {
    case "list":
      return schema.runSchemaList(globalOptions);
    case "show":
      return schema.runSchemaShow(typeName, globalOptions);
    case "show-status":
      return schema.runSchemaShowStatus(typeName, globalOptions);
    case "list-fields":
      return schema.runSchemaListFields(globalOptions);
    case "show-field":
      return schema.runSchemaShowField(typeName, globalOptions);
    case "remove-type":
      return schema.runSchemaRemoveType(
        typeName,
        { author, force },
        globalOptions,
      );
    case "remove-field":
      return schema.runSchemaRemoveField(
        typeName,
        { author, force },
        globalOptions,
      );
    case "apply-preset":
      return schema.runSchemaApplyPreset(
        typeName,
        { author, force },
        globalOptions,
      );
    case "add-field":
      return schema.runSchemaAddField(
        typeName,
        {
          type: typeof options.type === "string" ? options.type : undefined,
          commands: inputs.commands,
          description,
          cliFlag:
            typeof options.cliFlag === "string" ? options.cliFlag : undefined,
          alias: inputs.aliases,
          required: Boolean(options.required),
          requiredOnCreate: Boolean(options.requiredOnCreate),
          // commander stores --no-allow-unset as allowUnset:false; the default
          // (flag omitted) is true. Forward the tri-state faithfully.
          allowUnset: options.allowUnset !== false,
          requiredTypes: inputs.requiredTypes,
          author,
          force,
        },
        globalOptions,
      );
    case "add-status":
      return schema.runSchemaAddStatus(
        typeName,
        {
          role: inputs.roles,
          alias: inputs.aliases,
          description,
          order: inputs.order,
          author,
          force,
        },
        globalOptions,
      );
    case "remove-status":
      return schema.runSchemaRemoveStatus(
        typeName,
        { author, force },
        globalOptions,
      );
    default:
      // add-type, optionally in --infer mode.
      if (options.infer === true) {
        return schema.runSchemaInferTypes(
          {
            minCount: inputs.minCount,
            apply: Boolean(options.apply),
            author,
            force,
          },
          globalOptions,
        );
      }
      return schema.runSchemaAddType(
        typeName,
        {
          description,
          defaultStatus: inputs.defaultStatus,
          folder:
            typeof options.folder === "string" ? options.folder : undefined,
          alias: inputs.aliases,
          author,
          force,
        },
        globalOptions,
      );
  }
}

/** Renders a schema command result for non-JSON, non-quiet output and surfaces any on-write hook warnings. Extracted from the schema `.action()` body to keep registerMutationCommands under the cyclomatic-complexity gate. */
function renderSchemaResultHuman(
  schema: SchemaCommandModule,
  result: SchemaCommandResult,
): void {
  switch (result.action) {
    case "list":
      writeStdout(`${schema.formatSchemaListHuman(result)}\n`);
      return;
    case "show":
      writeStdout(`${schema.formatSchemaShowHuman(result)}\n`);
      return;
    case "show-status":
      writeStdout(`${schema.formatSchemaShowStatusHuman(result)}\n`);
      return;
    case "list-fields":
      writeStdout(`${schema.formatSchemaListFieldsHuman(result)}\n`);
      return;
    case "show-field":
      writeStdout(`${schema.formatSchemaShowFieldHuman(result)}\n`);
      return;
    case "remove-type":
      writeStdout(`${schema.formatSchemaRemoveTypeHuman(result)}\n`);
      break;
    case "remove-field":
      writeStdout(`${schema.formatSchemaRemoveFieldHuman(result)}\n`);
      break;
    case "apply-preset":
      writeStdout(`${schema.formatSchemaApplyPresetHuman(result)}\n`);
      break;
    case "infer-types":
      writeStdout(`${schema.formatSchemaInferTypesHuman(result)}\n`);
      break;
    case "add-field":
      writeStdout(`${schema.formatSchemaAddFieldHuman(result)}\n`);
      break;
    case "add-status":
      writeStdout(`${schema.formatSchemaAddStatusHuman(result)}\n`);
      break;
    case "remove-status":
      writeStdout(`${schema.formatSchemaRemoveStatusHuman(result)}\n`);
      break;
    default:
      writeStdout(`${schema.formatSchemaAddTypeHuman(result)}\n`);
      break;
  }
  // Surface extension on-write hook diagnostics (mutation subcommands only;
  // inspection results carry no warnings array).
  if (result.warnings.length > 0) {
    printError(
      `schema ${result.action} warnings: ${formatHookWarnings(result.warnings)}`,
    );
  }
}

type ProfileCommandModule = typeof import("./commands/profile.js");
type ProfileCommandResult =
  | ReturnType<ProfileCommandModule["runProfileList"]>
  | ReturnType<ProfileCommandModule["runProfileShow"]>
  | ReturnType<ProfileCommandModule["runProfileLint"]>
  | Awaited<ReturnType<ProfileCommandModule["runProfileApply"]>>;

/** Routes a normalized `pm profile` subcommand to its run function. Extracted from the profile `.action()` body so the per-subcommand dispatch lives in one place. */
async function dispatchProfileSubcommand(
  profile: ProfileCommandModule,
  subcommand: string,
  name: string | undefined,
  options: Record<string, unknown>,
  globalOptions: GlobalOptions,
): Promise<ProfileCommandResult> {
  switch (subcommand) {
    case "list":
      return profile.runProfileList();
    case "show":
      return profile.runProfileShow(name);
    case "lint":
      return profile.runProfileLint(name);
    default:
      return profile.runProfileApply(
        name,
        {
          dryRun: options.dryRun === true,
          author:
            typeof options.author === "string" ? options.author : undefined,
          force: options.force === true,
        },
        globalOptions,
      );
  }
}

/** Renders a profile command result for non-JSON, non-quiet output and surfaces any on-write hook warnings from an apply. */
function renderProfileResultHuman(
  profile: ProfileCommandModule,
  result: ProfileCommandResult,
): void {
  switch (result.action) {
    case "list":
      writeStdout(`${profile.formatProfileListHuman(result)}\n`);
      return;
    case "show":
      writeStdout(`${profile.formatProfileShowHuman(result)}\n`);
      return;
    case "lint":
      writeStdout(`${profile.formatProfileLintHuman(result)}\n`);
      return;
    default:
      writeStdout(`${profile.formatProfileApplyHuman(result)}\n`);
      if (result.warnings.length > 0) {
        printError(
          `profile apply warnings: ${formatHookWarnings(result.warnings)}`,
        );
      }
      break;
  }
}

/** Build a commander argParser that coerces a flag value into a positive (1-based) integer, throwing a usage error when the supplied value is not a whole number >= 1. Used by `pm comments --edit/--delete <index>` so an invalid index fails fast with a clear message instead of silently coercing. */
export function parsePositiveIntOption(
  flag: string,
): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new PmCliError(
        `${flag} must be a positive integer (1-based index).`,
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  };
}

// Bulk content-field selection filters (GH-242) shared by update-many and
// close-many. Each pair mirrors the list-family presence/absence flags but uses
// the `--filter-` prefix so they live in the bulk-selection namespace. The
// governance-missing filters (GH-236) reuse the same `--filter-<gov>-missing`
// spelling as the list family.
function registerBulkContentAndGovernanceFilters(
  command: Command,
  action: string,
): void {
  command
    .option(
      "--filter-has-notes",
      `Select only items that have notes before ${action}`,
    )
    .option(
      "--filter-no-notes",
      `Select only items that have no notes before ${action}`,
    )
    .option(
      "--filter-has-learnings",
      `Select only items that have learnings before ${action}`,
    )
    .option(
      "--filter-no-learnings",
      `Select only items that have no learnings before ${action}`,
    )
    .option(
      "--filter-has-files",
      `Select only items that have linked files before ${action}`,
    )
    .option(
      "--filter-no-files",
      `Select only items that have no linked files before ${action}`,
    )
    .option(
      "--filter-has-docs",
      `Select only items that have linked docs before ${action}`,
    )
    .option(
      "--filter-no-docs",
      `Select only items that have no linked docs before ${action}`,
    )
    .option(
      "--filter-has-tests",
      `Select only items that have linked tests before ${action}`,
    )
    .option(
      "--filter-no-tests",
      `Select only items that have no linked tests before ${action}`,
    )
    .option(
      "--filter-has-comments",
      `Select only items that have comments before ${action}`,
    )
    .option(
      "--filter-no-comments",
      `Select only items that have no comments before ${action}`,
    )
    .option(
      "--filter-has-deps",
      `Select only items that have dependencies before ${action}`,
    )
    .option(
      "--filter-no-deps",
      `Select only items that have no dependencies before ${action}`,
    )
    .option(
      "--filter-has-body",
      `Select only items that have a non-empty body before ${action}`,
    )
    .option(
      "--filter-empty-body",
      `Select only items with an empty body before ${action}`,
    )
    .option(
      "--filter-has-linked-command",
      `Select only items whose linked tests carry a runnable command before ${action}`,
    )
    .option(
      "--filter-no-linked-command",
      `Select only items whose linked tests carry no runnable command before ${action}`,
    )
    .option(
      "--filter-reviewer-missing",
      `Select only items missing reviewer before ${action}`,
    )
    .option(
      "--filter-risk-missing",
      `Select only items missing risk before ${action}`,
    )
    .option(
      "--filter-confidence-missing",
      `Select only items missing confidence before ${action}`,
    )
    .option(
      "--filter-sprint-missing",
      `Select only items missing sprint before ${action}`,
    )
    .option(
      "--filter-release-missing",
      `Select only items missing release before ${action}`,
    );
}

// Map the bulk content/governance `--filter-*` commander options into the
// ListOptions content/governance fields runList consumes. Shared by update-many
// and close-many.
// [hasCommanderKey, noCommanderKey, --filter-has flag, --filter-no flag]
const BULK_CONTENT_FILTER_CONFLICTS: ReadonlyArray<
  readonly [string, string, string, string]
> = [
  [
    "filterHasNotes",
    "filterNoNotes",
    "--filter-has-notes",
    "--filter-no-notes",
  ],
  [
    "filterHasLearnings",
    "filterNoLearnings",
    "--filter-has-learnings",
    "--filter-no-learnings",
  ],
  [
    "filterHasFiles",
    "filterNoFiles",
    "--filter-has-files",
    "--filter-no-files",
  ],
  ["filterHasDocs", "filterNoDocs", "--filter-has-docs", "--filter-no-docs"],
  [
    "filterHasTests",
    "filterNoTests",
    "--filter-has-tests",
    "--filter-no-tests",
  ],
  [
    "filterHasComments",
    "filterNoComments",
    "--filter-has-comments",
    "--filter-no-comments",
  ],
  ["filterHasDeps", "filterNoDeps", "--filter-has-deps", "--filter-no-deps"],
  [
    "filterHasBody",
    "filterEmptyBody",
    "--filter-has-body",
    "--filter-empty-body",
  ],
  [
    "filterHasLinkedCommand",
    "filterNoLinkedCommand",
    "--filter-has-linked-command",
    "--filter-no-linked-command",
  ],
];

function mapBulkContentAndGovernanceFilters(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const presence = (key: string): true | undefined =>
    options[key] === true ? true : undefined;
  // Catch a both-present-and-absent bulk request here so the error names the
  // bulk --filter-* flags the user actually typed, rather than the downstream
  // list-level --has-/--no- flags resolveContentFieldFilters would report.
  for (const [
    hasKey,
    noKey,
    hasFlag,
    noFlag,
  ] of BULK_CONTENT_FILTER_CONFLICTS) {
    if (options[hasKey] === true && options[noKey] === true) {
      throw new PmCliError(
        `Cannot combine ${hasFlag} with ${noFlag} for the same field.`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return {
    filterReviewerMissing: presence("filterReviewerMissing"),
    filterRiskMissing: presence("filterRiskMissing"),
    filterConfidenceMissing: presence("filterConfidenceMissing"),
    filterSprintMissing: presence("filterSprintMissing"),
    filterReleaseMissing: presence("filterReleaseMissing"),
    hasNotes: presence("filterHasNotes"),
    hasLearnings: presence("filterHasLearnings"),
    hasFiles: presence("filterHasFiles"),
    hasDocs: presence("filterHasDocs"),
    hasTests: presence("filterHasTests"),
    hasComments: presence("filterHasComments"),
    hasDeps: presence("filterHasDeps"),
    hasBody: presence("filterHasBody"),
    hasLinkedCommand: presence("filterHasLinkedCommand"),
    noNotes: presence("filterNoNotes"),
    noLearnings: presence("filterNoLearnings"),
    noFiles: presence("filterNoFiles"),
    noDocs: presence("filterNoDocs"),
    noTests: presence("filterNoTests"),
    noComments: presence("filterNoComments"),
    noDeps: presence("filterNoDeps"),
    emptyBody: presence("filterEmptyBody"),
    noLinkedCommand: presence("filterNoLinkedCommand"),
  };
}

/** Implements register commander option contracts for the public runtime surface of this module. */
export function registerCommanderOptionContracts(
  command: Command,
  contracts: CommanderOptionRegistrationContract[],
): void {
  for (const contract of contracts) {
    const sharedValues: string[] = [];
    let activeParseArgs = command.args;
    const repeatableParser = (value: string): string[] => {
      if (command.args !== activeParseArgs) {
        sharedValues.length = 0;
        activeParseArgs = command.args;
      }
      sharedValues.push(value);
      return sharedValues;
    };
    if (contract.required) {
      command.requiredOption(contract.option, contract.description);
    } else if (contract.repeatable) {
      command.option(contract.option, contract.description, repeatableParser);
    } else {
      command.option(contract.option, contract.description);
    }
    for (const aliasContract of contract.aliasOptions ?? []) {
      // Hide pure snake_case underscore-duplicate aliases (e.g. --create_mode
      // for --create-mode) from --help, but keep semantically-distinct aliases
      // (e.g. --ac for --acceptance-criteria) visible.
      if (isPureSnakeCaseAlias(contract.option, aliasContract.option)) {
        addHiddenOption(
          command,
          aliasContract.option,
          aliasContract.description,
          contract.repeatable === true,
          contract.repeatable ? repeatableParser : undefined,
        );
      } else if (contract.repeatable) {
        command.option(
          aliasContract.option,
          aliasContract.description,
          repeatableParser,
        );
      } else {
        command.option(aliasContract.option, aliasContract.description);
      }
    }
  }
}

/** Map raw `update-many --filter-*` commander options into the ListOptions shape runList consumes. Extracted from registerMutationCommands so its many string/boolean coercions do not inflate that function's cyclomatic complexity. */
function buildUpdateManyListOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const readString = (key: string): string | undefined =>
    typeof options[key] === "string" ? (options[key] as string) : undefined;
  return {
    type: readString("filterType"),
    tag: readString("filterTag"),
    priority: readString("filterPriority"),
    deadlineBefore: readString("filterDeadlineBefore"),
    deadlineAfter: readString("filterDeadlineAfter"),
    updatedAfter: readString("filterUpdatedAfter"),
    updatedBefore: readString("filterUpdatedBefore"),
    createdAfter: readString("filterCreatedAfter"),
    createdBefore: readString("filterCreatedBefore"),
    ids: readString("ids"),
    assignee: readString("filterAssignee"),
    assigneeFilter:
      readString("filterAssigneeFilter") ?? readString("filterAssignee_filter"),
    parent: readString("filterParent"),
    sprint: readString("filterSprint"),
    release: readString("filterRelease"),
    filterAcMissing: options.filterAcMissing === true ? true : undefined,
    filterEstimatesMissing:
      options.filterEstimatesMissing === true ||
      options.filterEstimateMissing === true
        ? true
        : undefined,
    filterResolutionMissing:
      options.filterResolutionMissing === true ? true : undefined,
    filterMetadataMissing:
      options.filterMetadataMissing === true ? true : undefined,
    ...mapBulkContentAndGovernanceFilters(options),
    limit: readString("limit"),
    offset: readString("offset"),
    includeBody: true,
  };
}

function pickStringOption(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function stringArrayOption(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value as string[];
  }
  if (typeof value === "string") {
    return [value];
  }
  return undefined;
}

function resolveCreatePositionals(
  typeOrTitle: string | undefined,
  secondTitle: string | undefined,
  options: Record<string, unknown>,
): { positionalType: string | undefined; positionalTitle: string | undefined } {
  if (typeof secondTitle === "string" && secondTitle.length > 0) {
    return { positionalType: typeOrTitle, positionalTitle: secondTitle };
  }
  if (typeof typeOrTitle !== "string" || typeOrTitle.length === 0) {
    return { positionalType: undefined, positionalTitle: undefined };
  }
  const explicitTitleProvided =
    typeof options.title === "string" && options.title.trim().length > 0;
  return explicitTitleProvided && options.type === undefined
    ? { positionalType: typeOrTitle, positionalTitle: undefined }
    : { positionalType: undefined, positionalTitle: typeOrTitle };
}

function assertCreatePositionalTypeHasTitle(
  positionalType: string | undefined,
  positionalTitle: string | undefined,
  options: Record<string, unknown>,
): void {
  if (
    positionalType !== undefined ||
    typeof positionalTitle !== "string" ||
    positionalTitle.length === 0 ||
    options.title !== undefined ||
    options.type !== undefined ||
    !BUILTIN_TYPE_NAME_LOOKUP.has(positionalTitle.trim().toLowerCase())
  ) {
    return;
  }
  const matchedType = positionalTitle.trim();
  throw new PmCliError(
    `pm create needs a title — "${matchedType}" looks like an item type, not a title. Use either: pm create ${matchedType} "<title>" or pm create "<title>" --type ${matchedType}.`,
    EXIT_CODE.USAGE,
    {
      code: "create_positional_type_without_title",
      why:
        'Without this guard the single positional is used as the title and the type defaults to Task — so the command would silently create a Task literally titled "' +
        matchedType +
        '".',
      examples: [
        `pm create ${matchedType} "Wire up SSO for the agent harness"`,
        `pm create "Wire up SSO for the agent harness" --type ${matchedType}`,
      ],
      nextSteps: [
        `Re-run with both type and title: pm create ${matchedType} "<title>"`,
      ],
    },
  );
}

async function runCreateAction(
  typeOrTitle: string | undefined,
  secondTitle: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const positionals = resolveCreatePositionals(
    typeOrTitle,
    secondTitle,
    options,
  );
  assertCreatePositionalTypeHasTitle(
    positionals.positionalType,
    positionals.positionalTitle,
    options,
  );
  if (
    typeof positionals.positionalType === "string" &&
    positionals.positionalType.length > 0 &&
    options.type === undefined
  ) {
    options.type = positionals.positionalType;
  }
  if (
    typeof positionals.positionalTitle === "string" &&
    positionals.positionalTitle.length > 0 &&
    options.title === undefined
  ) {
    options.title = positionals.positionalTitle;
  }
  if (typeof options.bodyFile === "string") {
    options.body = await resolveBodyFileContent(
      options.bodyFile,
      options.body !== undefined ? String(options.body) : undefined,
    );
    delete options.bodyFile;
  }
  const normalized = normalizeCreateOptions(options, { requireType: false });
  const { runCreate } = await import("./commands/create.js");
  const result = await runCreate(normalized, globalOptions);
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=create took_ms=${Date.now() - startedAt}`);
  }
}

function buildCloseManyListOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: readOptionString(options, "filterType"),
    tag: readOptionString(options, "filterTag"),
    priority: readOptionString(options, "filterPriority"),
    deadlineBefore: readOptionString(options, "filterDeadlineBefore"),
    deadlineAfter: readOptionString(options, "filterDeadlineAfter"),
    updatedAfter: readOptionString(options, "filterUpdatedAfter"),
    updatedBefore: readOptionString(options, "filterUpdatedBefore"),
    createdAfter: readOptionString(options, "filterCreatedAfter"),
    createdBefore: readOptionString(options, "filterCreatedBefore"),
    ids: readOptionString(options, "ids"),
    assignee: readOptionString(options, "filterAssignee"),
    assigneeFilter: pickStringOption(
      options.filterAssigneeFilter,
      options.filterAssignee_filter,
    ),
    parent: readOptionString(options, "filterParent"),
    sprint: readOptionString(options, "filterSprint"),
    release: readOptionString(options, "filterRelease"),
    ...mapBulkContentAndGovernanceFilters(options),
    limit: readOptionString(options, "limit"),
    offset: readOptionString(options, "offset"),
  };
}

async function runCloseManyAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runCloseMany } = await import("./commands/close-many.js");
  const result = await runCloseMany(
    {
      status: readOptionString(options, "filterStatus"),
      list: buildCloseManyListOptions(options),
      reason: readOptionString(options, "reason"),
      resolution: readOptionString(options, "resolution"),
      expectedResult: pickStringOption(
        options.expectedResult,
        options.expected_result,
        options.expected,
      ),
      actualResult: pickStringOption(
        options.actualResult,
        options.actual_result,
        options.actual,
      ),
      validateClose:
        options.validateClose === true
          ? "warn"
          : readOptionString(options, "validateClose"),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
      dryRun: options.dryRun === true ? true : undefined,
      rollback: readOptionString(options, "rollback"),
      checkpoint: options.checkpoint === false ? false : undefined,
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=close-many took_ms=${Date.now() - startedAt}`);
  }
}

async function runUpdateManyAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runUpdateMany } = await import("./commands/update-many.js");
  const result = await runUpdateMany(
    {
      status: readOptionString(options, "filterStatus"),
      list: buildUpdateManyListOptions(options),
      update: normalizeUpdateOptions(
        extractUpdateManyMutationOptionSource(options),
      ),
      dryRun: options.dryRun === true ? true : undefined,
      rollback: readOptionString(options, "rollback"),
      checkpoint: options.checkpoint === false ? false : undefined,
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=update-many took_ms=${Date.now() - startedAt}`);
  }
}

async function runCloseAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runClose } = await import("./commands/close.js");
  const reasonFromOption =
    (typeof options.reason === "string" &&
      options.reason.trim().length > 0 &&
      options.reason) ||
    (typeof options.closeReason === "string" &&
      options.closeReason.trim().length > 0 &&
      options.closeReason) ||
    undefined;
  const resolvedText =
    typeof text === "string" && text.length > 0 ? text : reasonFromOption;
  const result = await runClose(
    id,
    resolvedText,
    {
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      validateClose:
        options.validateClose === true
          ? "warn"
          : readOptionString(options, "validateClose"),
      force: Boolean(options.force),
      duplicateOf: readOptionString(options, "duplicateOf"),
      resolution: readOptionString(options, "resolution"),
      expectedResult: pickStringOption(
        options.expectedResult,
        options.expected_result,
        options.expected,
      ),
      actualResult: pickStringOption(
        options.actualResult,
        options.actual_result,
        options.actual,
      ),
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=close took_ms=${Date.now() - startedAt}`);
  }
}

function normalizePlanAliases(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const planOptions: Record<string, unknown> = { ...options };
  const aliasPairs: Array<[string, string]> = [
    ["blocked_by", "blockedBy"],
    ["resume_context", "resumeContext"],
    ["from_search", "fromSearch"],
    ["step_title", "stepTitle"],
    ["step_body", "stepBody"],
    ["step_owner", "stepOwner"],
    ["step_status", "stepStatus"],
    ["step_evidence", "stepEvidence"],
    ["step_blocked_reason", "stepBlockedReason"],
    ["step_replacement", "stepReplacement"],
    ["depends_on", "dependsOn"],
    ["link_kind", "linkKind"],
    ["link_note", "linkNote"],
    ["promote_to_item_dep", "promoteToItemDep"],
    ["allow_multiple_active", "allowMultipleActive"],
    ["decision_text", "decisionText"],
    ["decision_rationale", "decisionRationale"],
    ["decision_evidence", "decisionEvidence"],
    ["discovery_text", "discoveryText"],
    ["validation_text", "validationText"],
    ["validation_command", "validationCommand"],
    ["validation_expected", "validationExpected"],
    ["materialize_type", "materializeType"],
    ["materialize_parent", "materializeParent"],
    ["materialize_tags", "materializeTags"],
  ];
  for (const [snake, camel] of aliasPairs) {
    if (planOptions[snake] !== undefined && planOptions[camel] === undefined) {
      planOptions[camel] = planOptions[snake];
    }
  }
  return planOptions;
}

function assertKnownPlanSubcommand(
  subcommand: string | undefined,
  normalized: string,
  allowed: readonly string[],
): void {
  if (!normalized) {
    throw new PmCliError(
      `pm plan requires a subcommand. Allowed: ${allowed.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        code: "missing_required_argument",
        examples: [
          'pm plan create --title "Refactor lock retry"',
          "pm plan show pm-a1b2 --depth standard",
          'pm plan add-step pm-a1b2 --step-title "Read lock.ts"',
        ],
      },
    );
  }
  if (allowed.includes(normalized)) {
    return;
  }
  const examples =
    normalized === "list" || normalized === "ls"
      ? ["pm list --type Plan", "pm list-all --type Plan"]
      : undefined;
  throw new PmCliError(
    `Unknown pm plan subcommand "${subcommand}". Allowed: ${allowed.join(", ")}`,
    EXIT_CODE.USAGE,
    examples ? { code: "unknown_subcommand", examples } : undefined,
  );
}

function parsePlanReorderTo(
  normalizedSubcommand: string,
  reorderToken: string | undefined,
): number | undefined {
  if (
    normalizedSubcommand !== "reorder-step" ||
    typeof reorderToken !== "string"
  ) {
    return undefined;
  }
  const parsed = Number.parseInt(reorderToken, 10);
  if (!Number.isFinite(parsed)) {
    throw new PmCliError(
      `reorder-step requires an integer new order, got "${reorderToken}"`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

async function runPlanAction(
  subcommand: string | undefined,
  id: string | undefined,
  stepRef: string | undefined,
  reorderToken: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runPlan, PLAN_SUBCOMMANDS } = await import("./commands/plan.js");
  const normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
  assertKnownPlanSubcommand(subcommand, normalizedSubcommand, PLAN_SUBCOMMANDS);
  const planOptions = normalizePlanAliases(options);
  const reorderTo = parsePlanReorderTo(normalizedSubcommand, reorderToken);
  const planId =
    normalizedSubcommand === "create" &&
    typeof id === "string" &&
    id.length > 0 &&
    planOptions.title === undefined
      ? undefined
      : id;
  if (planId === undefined && typeof id === "string" && id.length > 0) {
    planOptions.title = id;
  }
  const result = await runPlan({
    subcommand: normalizedSubcommand as (typeof PLAN_SUBCOMMANDS)[number],
    id: planId,
    stepRef,
    reorderTo,
    options: planOptions as Record<string, never>,
    global: globalOptions,
  });
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=plan took_ms=${Date.now() - startedAt}`);
  }
}

function parseNonNegativeIntFlag(
  raw: unknown,
  flag: string,
): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new PmCliError(
      `history-compact ${flag} must be a non-negative integer.`,
      EXIT_CODE.USAGE,
    );
  }
  return Number.parseInt(raw, 10);
}

async function runHistoryCompactAction(
  id: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const {
    runHistoryCompact,
    runHistoryCompactBulk,
    assertHistoryCompactTarget,
  } = await import("./commands/history-compact.js");
  const ids =
    typeof options.ids === "string" ? splitCommaList(options.ids) : undefined;
  const allOver = parseNonNegativeIntFlag(options.allOver, "--all-over");
  const minEntries = parseNonNegativeIntFlag(
    options.minEntries,
    "--min-entries",
  );
  if (options.closed === true && options.allStreams === true) {
    throw new PmCliError(
      "history-compact: --closed and --all-streams are mutually exclusive; pick one lifecycle scope.",
      EXIT_CODE.USAGE,
    );
  }
  const scope =
    options.closed === true
      ? "closed"
      : options.allStreams === true
        ? "all-streams"
        : undefined;
  const isBulk =
    ids !== undefined || allOver !== undefined || scope !== undefined;
  if (isBulk && typeof options.before === "string") {
    throw new PmCliError(
      "history-compact: --before applies only in single-id mode (bulk mode always compacts full streams).",
      EXIT_CODE.USAGE,
    );
  }
  assertHistoryCompactTarget(id, { ids, allOver, scope });
  if (id === undefined) {
    const result = await runHistoryCompactBulk(
      {
        ids,
        scope,
        allOver,
        minEntries,
        dryRun: options.dryRun === true,
        author: readOptionString(options, "author"),
        message: readOptionString(options, "message"),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (result.totals.items_errored > 0) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
  } else {
    const result = await runHistoryCompact(
      id,
      {
        before: readOptionString(options, "before"),
        dryRun: options.dryRun === true,
        author: readOptionString(options, "author"),
        message: readOptionString(options, "message"),
        force: Boolean(options.force),
      },
      globalOptions,
    );
    printResult(result, globalOptions);
  }
  if (globalOptions.profile) {
    printError(
      `profile:command=history-compact took_ms=${Date.now() - startedAt}`,
    );
  }
}

function splitCollectedCommaList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return (raw as string[])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function runSchemaAction(
  subcommand: string | undefined,
  name: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const schemaModule = await import("./commands/schema.js");
  const { SCHEMA_SUBCOMMANDS } = schemaModule;
  let normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
  let typeName = name;
  assertSchemaSubcommandPresent(normalizedSubcommand, SCHEMA_SUBCOMMANDS);
  if (
    !SCHEMA_SUBCOMMANDS.includes(
      normalizedSubcommand as (typeof SCHEMA_SUBCOMMANDS)[number],
    ) &&
    typeName === undefined &&
    !looksLikeSchemaSubcommandTypo(normalizedSubcommand)
  ) {
    typeName = subcommand;
    normalizedSubcommand = "add-type";
  }
  if (
    !SCHEMA_SUBCOMMANDS.includes(
      normalizedSubcommand as (typeof SCHEMA_SUBCOMMANDS)[number],
    )
  ) {
    throw new PmCliError(
      `Unknown pm schema subcommand "${subcommand}". Allowed: ${SCHEMA_SUBCOMMANDS.join(", ")}`,
      EXIT_CODE.USAGE,
      { code: "unknown_subcommand" },
    );
  }
  const result = await dispatchSchemaSubcommand(schemaModule, {
    normalizedSubcommand,
    typeName,
    options,
    aliases: stringArrayOption(options.alias),
    roles: stringArrayOption(options.role),
    commands: splitCollectedCommaList(options.commands),
    requiredTypes: splitCollectedCommaList(options.requiredTypes),
    defaultStatus: pickStringOption(
      options.defaultStatus,
      options.default_status,
    ),
    order: parseSchemaOrderOption(options.order),
    minCount: parseSchemaOrderOption(options.minCount),
    author: readOptionString(options, "author"),
    force: Boolean(options.force),
    description: readOptionString(options, "description"),
    globalOptions,
  });
  if (
    globalOptions.json === true ||
    globalOptions.defaultOutputFormat === "json"
  ) {
    printResult(result, globalOptions);
  } else if (!globalOptions.quiet) {
    renderSchemaResultHuman(schemaModule, result);
  }
  if (globalOptions.profile) {
    printError(`profile:command=schema took_ms=${Date.now() - startedAt}`);
  }
}

function assertSchemaSubcommandPresent(
  normalizedSubcommand: string,
  allowed: readonly string[],
): void {
  if (normalizedSubcommand) {
    return;
  }
  throw new PmCliError(
    `pm schema requires a subcommand. Allowed: ${allowed.join(", ")}`,
    EXIT_CODE.USAGE,
    {
      code: "missing_required_argument",
      examples: [
        "pm schema list",
        "pm schema show Task",
        "pm schema show-status open",
        'pm schema add-type Spike --description "Time-boxed investigation" --default-status open',
        "pm schema remove-type Spike",
        "pm schema add-status review --role active --alias in_review",
        "pm schema remove-status review",
        "pm schema add-field severity_level --type string --commands create,update",
        "pm schema list-fields",
        "pm schema apply-preset agile",
        "pm schema add-type --infer --min-count 10",
      ],
    },
  );
}

function resolveCommentSources(
  text: string | undefined,
  options: Record<string, unknown>,
): {
  add: string | undefined;
  readFromStdin: boolean;
  readFromFile: string | undefined;
  editIndex: number | undefined;
  deleteIndex: number | undefined;
  isMutation: boolean;
} {
  const editIndex = typeof options.edit === "number" ? options.edit : undefined;
  const deleteIndex =
    typeof options.delete === "number" ? options.delete : undefined;
  const addFromOption =
    readOptionString(options, "add") ??
    readOptionString(options, "body") ??
    readOptionString(options, "comment");
  const addFromPositional = typeof text === "string" ? text : undefined;
  const readFromStdin = options.stdin === true;
  const readFromFile = readOptionString(options, "file");
  const sourceCount =
    Number(addFromOption !== undefined) +
    Number(addFromPositional !== undefined) +
    Number(readFromStdin) +
    Number(readFromFile !== undefined);
  if (sourceCount > 1) {
    if (
      addFromOption !== undefined &&
      addFromPositional !== undefined &&
      !readFromStdin &&
      readFromFile === undefined
    ) {
      throw new PmCliError(
        "Specify comment text either as positional [text] or with --add, not both",
        EXIT_CODE.USAGE,
      );
    }
    throw new PmCliError(
      "Specify comment text with exactly one source: positional [text], --add, --stdin, or --file",
      EXIT_CODE.USAGE,
    );
  }
  const add = addFromOption ?? addFromPositional;
  const isMutation =
    typeof add === "string" ||
    readFromStdin ||
    readFromFile !== undefined ||
    editIndex !== undefined ||
    deleteIndex !== undefined;
  return {
    add,
    readFromStdin,
    readFromFile,
    editIndex,
    deleteIndex,
    isMutation,
  };
}

async function runCommentsAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const sources = resolveCommentSources(text, options);
  const { runComments } = await import("./commands/comments.js");
  const result = await runComments(
    id,
    {
      add: sources.add,
      stdin: sources.readFromStdin,
      file: sources.readFromFile,
      edit: sources.editIndex,
      delete: sources.deleteIndex,
      limit: readOptionString(options, "limit"),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      allowAuditComment: Boolean(options.allowAuditComment),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  if (sources.isMutation) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=comments took_ms=${Date.now() - startedAt}`);
  }
}

async function runCopyAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runCopy } = await import("./commands/copy.js");
  const result = await runCopy(
    id,
    {
      title: readOptionString(options, "title"),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=copy took_ms=${Date.now() - startedAt}`);
  }
}

async function runFocusAction(
  id: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runFocus } = await import("./commands/focus.js");
  const result = await runFocus(
    id,
    { clear: options.clear === true },
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=focus took_ms=${Date.now() - startedAt}`);
  }
}

async function runUpdateAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  // GH-214: resolve --body-file into the existing body field before
  // normalization so the rest of update is unchanged. CLI-only input alias.
  if (typeof options.bodyFile === "string") {
    options.body = await resolveBodyFileContent(
      options.bodyFile,
      options.body !== undefined ? String(options.body) : undefined,
    );
    delete options.bodyFile;
  }
  const { runUpdate } = await import("./commands/update.js");
  const result = await runUpdate(
    id,
    normalizeUpdateOptions(options),
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=update took_ms=${Date.now() - startedAt}`);
  }
}

async function runDeleteAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runDelete } = await import("./commands/delete.js");
  const result = await runDelete(
    id,
    {
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
      dryRun: options.dryRun === true,
    },
    globalOptions,
  );
  if (result.dry_run !== true) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=delete took_ms=${Date.now() - startedAt}`);
  }
}

function resolveSingleTextSource(
  label: string,
  positional: string | undefined,
  options: Record<string, unknown>,
): string | undefined {
  const addFromOption = readOptionString(options, "add");
  const addFromPositional =
    typeof positional === "string" ? positional : undefined;
  if (addFromOption !== undefined && addFromPositional !== undefined) {
    throw new PmCliError(
      `Specify ${label} text either as positional [text] or with --add, not both`,
      EXIT_CODE.USAGE,
    );
  }
  return addFromOption ?? addFromPositional;
}

function resolveAppendBody(
  text: string | undefined,
  options: Record<string, unknown>,
): string {
  const bodyFromOption = readOptionString(options, "body");
  const bodyFromAlias = readOptionString(options, "text");
  const bodyFromPositional = typeof text === "string" ? text : undefined;
  const bodySourceCount = [
    bodyFromOption,
    bodyFromAlias,
    bodyFromPositional,
  ].filter((value) => value !== undefined).length;
  if (bodySourceCount > 1) {
    throw new PmCliError(
      "Specify append text with exactly one source: positional [text], --body, or --text",
      EXIT_CODE.USAGE,
    );
  }
  const resolvedBody = bodyFromOption ?? bodyFromAlias ?? bodyFromPositional;
  if (resolvedBody === undefined) {
    throw new PmCliError(
      "Missing append text. Provide it as positional [text], --body <value>, or --text <value> (use - for stdin).",
      EXIT_CODE.USAGE,
    );
  }
  return resolvedBody;
}

async function runAppendAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runAppend } = await import("./commands/append.js");
  const result = await runAppend(
    id,
    {
      body: resolveAppendBody(text, options),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=append took_ms=${Date.now() - startedAt}`);
  }
}

async function runRestoreAction(
  id: string,
  target: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runRestore } = await import("./commands/restore.js");
  const result = await runRestore(
    id,
    target,
    {
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=restore took_ms=${Date.now() - startedAt}`);
  }
}

async function runProfileAction(
  subcommand: string | undefined,
  name: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const profileModule = await import("./commands/profile.js");
  const { PROFILE_SUBCOMMANDS } = profileModule;
  const normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
  if (!normalizedSubcommand) {
    throw new PmCliError(
      `pm profile requires a subcommand. Allowed: ${PROFILE_SUBCOMMANDS.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        code: "missing_required_argument",
        examples: [
          "pm profile list",
          "pm profile show agile",
          "pm profile apply agile --dry-run",
          "pm profile lint agile",
        ],
      },
    );
  }
  if (
    !PROFILE_SUBCOMMANDS.includes(
      normalizedSubcommand as (typeof PROFILE_SUBCOMMANDS)[number],
    )
  ) {
    throw new PmCliError(
      `Unknown pm profile subcommand "${subcommand}". Allowed: ${PROFILE_SUBCOMMANDS.join(", ")}`,
      EXIT_CODE.USAGE,
      { code: "unknown_subcommand" },
    );
  }
  const result = await dispatchProfileSubcommand(
    profileModule,
    normalizedSubcommand,
    name,
    options,
    globalOptions,
  );
  // Profile inspection and schema staging do not mutate item content, so search caches stay valid (mirrors pm schema).
  if (
    globalOptions.json === true ||
    globalOptions.defaultOutputFormat === "json"
  ) {
    printResult(result, globalOptions);
  } else if (!globalOptions.quiet) {
    renderProfileResultHuman(profileModule, result);
  }
  // `pm profile lint` is a validation gate: exit non-zero when the profile has
  // error-severity findings so shell/CI callers can fail on them. Warnings keep
  // `ok` true and never fail the command.
  if (result.action === "lint" && !result.ok) {
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
  if (globalOptions.profile) {
    printError(`profile:command=profile took_ms=${Date.now() - startedAt}`);
  }
}

async function runNotesAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const add = resolveSingleTextSource("note", text, options);
  const { runNotes } = await import("./commands/notes.js");
  const result = await runNotes(
    id,
    {
      add,
      limit: readOptionString(options, "limit"),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      allowAuditComment: Boolean(
        options.allowAuditNote || options.allowAuditComment,
      ),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  if (typeof add === "string") {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=notes took_ms=${Date.now() - startedAt}`);
  }
}

async function runLearningsAction(
  id: string,
  text: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const add = resolveSingleTextSource("learning", text, options);
  const { runLearnings } = await import("./commands/learnings.js");
  const result = await runLearnings(
    id,
    {
      add,
      limit: readOptionString(options, "limit"),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      allowAuditComment: Boolean(
        options.allowAuditLearning || options.allowAuditComment,
      ),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  if (typeof add === "string") {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=learnings took_ms=${Date.now() - startedAt}`);
  }
}

function readStringArrayOption(
  options: Record<string, unknown>,
  key: string,
): string[] {
  return stringArrayOption(options[key]) ?? [];
}

async function runFilesAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const addValues = readStringArrayOption(options, "add");
  const addGlobValues = readStringArrayOption(options, "addGlob");
  const removeValues = readStringArrayOption(options, "remove");
  const migrateValues = readStringArrayOption(options, "migrate");
  const { runFiles } = await import("./commands/files.js");
  const result = await runFiles(
    id,
    {
      add: addValues,
      addGlob: addGlobValues,
      remove: removeValues,
      migrate: migrateValues,
      note: readOptionString(options, "note"),
      list: Boolean(options.list),
      appendStable: Boolean(options.appendStable),
      validatePaths: Boolean(options.validatePaths),
      audit: Boolean(options.audit),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  if (
    addValues.length > 0 ||
    addGlobValues.length > 0 ||
    removeValues.length > 0 ||
    migrateValues.length > 0
  ) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=files took_ms=${Date.now() - startedAt}`);
  }
}

async function runFilesDiscoverAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  // Flags also declared on the parent files command (--note/--append-stable/
  // --author/--message/--force) are consumed by the parent during parse, so
  // merge ancestor opts back in (own options win) instead of reading opts() alone.
  const mergedOptions: Record<string, unknown> = {
    ...command.optsWithGlobals(),
    ...options,
  };
  const { runFilesDiscover } = await import("./commands/files.js");
  const result = await runFilesDiscover(
    id,
    {
      apply: Boolean(mergedOptions.apply),
      note: readOptionString(mergedOptions, "note"),
      appendStable: Boolean(mergedOptions.appendStable),
      author: readOptionString(mergedOptions, "author"),
      message: readOptionString(mergedOptions, "message"),
      force: Boolean(mergedOptions.force),
    },
    globalOptions,
  );
  if (result.changed) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(
      `profile:command=files.discover took_ms=${Date.now() - startedAt}`,
    );
  }
}

async function runDocsAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const addValues = readStringArrayOption(options, "add");
  const addGlobValues = readStringArrayOption(options, "addGlob");
  const removeValues = readStringArrayOption(options, "remove");
  const migrateValues = readStringArrayOption(options, "migrate");
  const { runDocs } = await import("./commands/docs.js");
  const result = await runDocs(
    id,
    {
      add: addValues,
      addGlob: addGlobValues,
      remove: removeValues,
      migrate: migrateValues,
      note: readOptionString(options, "note"),
      list: Boolean(options.list),
      validatePaths: Boolean(options.validatePaths),
      audit: Boolean(options.audit),
      author: readOptionString(options, "author"),
      message: readOptionString(options, "message"),
      force: Boolean(options.force),
    },
    globalOptions,
  );
  if (
    addValues.length > 0 ||
    addGlobValues.length > 0 ||
    removeValues.length > 0 ||
    migrateValues.length > 0
  ) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=docs took_ms=${Date.now() - startedAt}`);
  }
}

async function runDepsAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runDeps } = await import("./commands/deps.js");
  // --format and --collapse carry commander defaults ("tree"/"none"), so
  // they are always strings by the time the action runs; --maxDepth has no
  // default and may be unset. Use `as string` rather than String(...) so an
  // omitted option stays undefined instead of becoming the literal "undefined".
  const result = await runDeps(
    id,
    {
      format: options.format as string,
      maxDepth: readOptionString(options, "maxDepth"),
      collapse: options.collapse as string,
      summary: options.summary === true,
    },
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=deps took_ms=${Date.now() - startedAt}`);
  }
}

/** Implements register mutation commands for the public runtime surface of this module. */
export function registerMutationCommands(program: Command): void {
  const createCommand = program
    .command("create")
    .argument(
      "[typeOrTitle]",
      'Item title, or item type when a title follows (e.g. `pm create task "Fix bug"`)',
    )
    .argument("[title]", "Item title when the first argument is an item type")
    .description("Create a new project management item.");
  registerCommanderOptionContracts(
    createCommand,
    CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  );
  createCommand
    .option(
      "--body-file <path>",
      "Load the item markdown body from a file (mutually exclusive with --body)",
    )
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .action(runCreateAction);

  program
    .command("copy")
    .argument("<id>", "Source item id")
    .option("--title <value>", "Optional title override for the copied item")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .description(
      "Copy an item into a new item id while resetting lifecycle fields.",
    )
    .action(runCopyAction);

  program
    .command("focus")
    .argument("[id]", "Item id to focus (omit to show current focus)")
    .option("--clear", "Clear the focused item")
    .description(
      "Set/clear/show the session focused item that new items default --parent to.",
    )
    .action(runFocusAction);

  const updateCommand = program
    .command("update")
    .argument("<id>", "Item id")
    .description("Update item fields and metadata.");
  registerCommanderOptionContracts(
    updateCommand,
    UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  );
  updateCommand
    .option(
      "--body-file <path>",
      "Load the item markdown body from a file (mutually exclusive with --body)",
    )
    .option(
      "--replace-deps",
      "Atomically replace dependency entries with the provided --dep values",
    )
    .option(
      "--replace-tests",
      "Atomically replace linked test entries with the provided --test values",
    )
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .option(
      "--allow-audit-update",
      "Allow non-owner metadata-only audit updates without requiring --force",
    )
    .option(
      "--allow-audit-dep-update",
      "Allow non-owner append-only dependency updates without requiring --force",
    )
    .option("--force", "Force ownership override");
  addHiddenOption(
    updateCommand,
    "--allow_audit_update",
    "Alias for --allow-audit-update",
    false,
  );
  addHiddenOption(
    updateCommand,
    "--allow_audit_dep_update",
    "Alias for --allow-audit-dep-update",
    false,
  );
  updateCommand.action(runUpdateAction);

  const updateManyCommand = program
    .command("update-many")
    .description(
      "Bulk-update matched items with dry-run plans and rollback checkpoints.",
    )
    .option(
      "--filter-status <value>",
      "Filter by status before applying updates",
    )
    .option(
      "--filter-type <value>",
      "Filter by item type before applying updates",
    )
    .option("--filter-tag <value>", "Filter by tag before applying updates")
    .option(
      "--filter-priority <value>",
      "Filter by priority before applying updates",
    )
    .option(
      "--filter-deadline-before <value>",
      "Filter by deadline upper bound before applying updates",
    )
    .option(
      "--filter-deadline-after <value>",
      "Filter by deadline lower bound before applying updates",
    )
    .option(
      "--filter-updated-after <value>",
      "Filter by updated_at lower bound before applying updates (ISO/relative)",
    )
    .option(
      "--filter-updated-before <value>",
      "Filter by updated_at upper bound before applying updates (ISO/relative)",
    )
    .option(
      "--filter-created-after <value>",
      "Filter by created_at lower bound before applying updates (ISO/relative)",
    )
    .option(
      "--filter-created-before <value>",
      "Filter by created_at upper bound before applying updates (ISO/relative)",
    )
    .option(
      "--filter-assignee <value>",
      "Filter by assignee before applying updates",
    )
    .option(
      "--filter-assignee-filter <value>",
      "Filter assignee presence: assigned|unassigned before applying updates",
    )
    .option(
      "--filter-parent <value>",
      "Filter by parent item ID before applying updates",
    )
    .option(
      "--filter-sprint <value>",
      "Filter by sprint before applying updates",
    )
    .option(
      "--filter-release <value>",
      "Filter by release before applying updates",
    )
    .option(
      "--filter-ac-missing",
      "Select only items missing acceptance_criteria (bulk backfill)",
    )
    .option(
      "--filter-estimates-missing",
      "Select only items missing estimated_minutes (bulk backfill)",
    )
    .option(
      "--filter-resolution-missing",
      "Select only terminal items missing resolution (bulk backfill)",
    )
    .option(
      "--filter-metadata-missing",
      "Select only items missing any tracked metadata (AC, estimate, or resolution)",
    );
  registerBulkContentAndGovernanceFilters(
    updateManyCommand,
    "applying updates",
  );
  updateManyCommand
    .option(
      "--ids <value>",
      "Restrict to an explicit comma-separated ID allowlist (intersected with other filters)",
    )
    .option("--limit <n>", "Limit matched item count before apply/preview")
    .option("--offset <n>", "Skip first n matched rows before apply/preview")
    .option(
      "--dry-run",
      "Preview per-item diffs and checkpoint intent without mutating",
    )
    .option("--rollback <value>", "Rollback a prior update-many checkpoint ID")
    .option("--no-checkpoint", "Disable checkpoint creation during apply mode")
    .option("--title, -t <value>", "Set title")
    .option("--description, -d <value>", "Set description")
    .option("--body, -b <value>", "Set body (allow empty string)")
    .option("--status, -s <value>", "Set status (use close command for closed)")
    .option("--priority, -p <value>", "Set priority")
    .option("--type <value>", "Set type")
    .option(
      "--tags <value>",
      "Set comma-separated tags (replaces existing). Use --add-tags / --remove-tags to mutate additively.",
    )
    .option(
      "--add-tags <value>",
      "Add tags additively without replacing existing (repeatable; CSV accepted)",
      collect,
    )
    .option(
      "--remove-tags <value>",
      "Remove tags from the existing list (repeatable; CSV accepted)",
      collect,
    )
    .option("--deadline <value>", "Set deadline (ISO/date string or relative)")
    .option("--estimate, --estimated-minutes <value>", "Set estimated minutes")
    .option("--acceptance-criteria <value>", "Set acceptance criteria")
    .option("--ac <value>", "Alias for --acceptance-criteria")
    .option("--definition-of-ready <value>", "Set definition of ready")
    .option("--order <value>", "Set planning order/rank integer")
    .option("--rank <value>", "Alias for --order")
    .option("--goal <value>", "Set goal identifier")
    .option("--objective <value>", "Set objective identifier")
    .option("--value <value>", "Set business value summary")
    .option("--impact <value>", "Set business impact summary")
    .option("--outcome <value>", "Set expected outcome summary")
    .option("--why-now <value>", "Set why-now rationale")
    .option("--assignee <value>", "Set assignee")
    .option("--parent <value>", "Set parent item ID")
    .option("--reviewer <value>", "Set reviewer")
    .option("--risk <value>", "Set risk level")
    .option("--confidence <value>", "Set confidence level")
    .option("--sprint <value>", "Set sprint identifier")
    .option("--release <value>", "Set release identifier")
    .option("--blocked-by <value>", "Set blocked-by item ID or reason")
    .option("--blocked-reason <value>", "Set blocked reason")
    .option("--unblock-note <value>", "Set unblock rationale note")
    .option("--reporter <value>", "Set issue reporter")
    .option("--severity <value>", "Set issue severity")
    .option("--environment <value>", "Set issue environment context")
    .option("--repro-steps <value>", "Set issue reproduction steps")
    .option("--resolution <value>", "Set issue resolution summary")
    .option("--expected-result <value>", "Set issue expected behavior")
    .option("--expected <value>", "Short alias for --expected-result")
    .option("--actual-result <value>", "Set issue observed behavior")
    .option("--actual <value>", "Short alias for --actual-result")
    .option("--affected-version <value>", "Set affected version identifier")
    .option("--fixed-version <value>", "Set fixed version identifier")
    .option("--component <value>", "Set issue component ownership")
    .option("--regression <value>", "Set regression marker: true|false|1|0")
    .option("--customer-impact <value>", "Set customer impact summary")
    .option(
      "--dep <value>",
      "Add dependency entry id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>",
      collect,
    )
    .option(
      "--dep-remove <value>",
      "Remove dependency entries by id/kind/author/timestamp signature",
      collect,
    )
    .option(
      "--replace-deps",
      "Atomically replace dependency entries with provided --dep values",
    )
    .option(
      "--replace-tests",
      "Atomically replace linked tests with provided --test values",
    )
    .option(
      "--comment <value>",
      "Add comment seed author=<value>,created_at=<iso|now>,text=<value>",
      collect,
    )
    .option(
      "--note <value>",
      "Add note seed author=<value>,created_at=<iso|now>,text=<value>",
      collect,
    )
    .option(
      "--learning <value>",
      "Add learning seed author=<value>,created_at=<iso|now>,text=<value>",
      collect,
    )
    .option(
      "--file <value>",
      "Add linked file path=<value>,scope=<project|global>,note=<text>",
      collect,
    )
    .option(
      "--test <value>",
      "Add linked test command=<value>,path=<value>,scope=<project|global>",
      collect,
    )
    .option(
      "--doc <value>",
      "Add linked doc path=<value>,scope=<project|global>,note=<text>",
      collect,
    )
    .option(
      "--reminder <value>",
      "Add reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>",
      collect,
    )
    .option(
      "--event <value>",
      "Add event entry start=<iso|relative>,end=<iso|relative>,recur_*",
      collect,
    )
    .option(
      "--type-option <value>",
      "Set type options key=value (repeatable)",
      collect,
    )
    .option(
      "--unset <field>",
      "Clear scalar metadata field by name (repeatable)",
      collect,
    )
    .option("--clear-deps", "Clear dependency entries")
    .option("--clear-comments", "Clear comments")
    .option("--clear-notes", "Clear notes")
    .option("--clear-learnings", "Clear learnings")
    .option("--clear-files", "Clear linked files")
    .option("--clear-tests", "Clear linked tests")
    .option("--clear-docs", "Clear linked docs")
    .option("--clear-reminders", "Clear reminders")
    .option("--clear-events", "Clear events")
    .option("--clear-type-options", "Clear type options")
    .option(
      "--allow-audit-update",
      "Allow non-owner metadata-only audit updates without requiring --force",
    )
    .option(
      "--allow-audit-dep-update",
      "Allow non-owner append-only dependency updates without requiring --force",
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override");
  // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional,
  // omitted from --help to save agent context).
  addHiddenOptions(
    updateManyCommand,
    [
      [
        "--filter-assignee_filter <value>",
        "Alias for --filter-assignee-filter",
      ],
      ["--estimated_minutes <value>", "Alias for --estimated-minutes"],
      ["--acceptance_criteria <value>", "Alias for --acceptance-criteria"],
      ["--definition_of_ready <value>", "Alias for --definition-of-ready"],
      ["--why_now <value>", "Alias for --why-now"],
      ["--blocked_by <value>", "Alias for --blocked-by"],
      ["--blocked_reason <value>", "Alias for --blocked-reason"],
      ["--unblock_note <value>", "Alias for --unblock-note"],
      ["--repro_steps <value>", "Alias for --repro-steps"],
      ["--expected_result <value>", "Alias for --expected-result"],
      ["--actual_result <value>", "Alias for --actual-result"],
      ["--affected_version <value>", "Alias for --affected-version"],
      ["--fixed_version <value>", "Alias for --fixed-version"],
      ["--customer_impact <value>", "Alias for --customer-impact"],
      ["--allow_audit_update", "Alias for --allow-audit-update"],
      ["--allow_audit_dep_update", "Alias for --allow-audit-dep-update"],
      ["--filter-estimate-missing", "Alias for --filter-estimates-missing"],
    ],
    false,
  );
  addHiddenOptions(
    updateManyCommand,
    [
      ["--dep_remove <value>", "Alias for --dep-remove"],
      ["--type_option <value>", "Alias for --type-option"],
      ["--add_tags <value>", "Alias for --add-tags"],
      ["--remove_tags <value>", "Alias for --remove-tags"],
    ],
    true,
  );
  updateManyCommand.action(runUpdateManyAction);

  const closeCommand = program
    .command("close")
    .argument("<id>", "Item id")
    .argument("[text]", "Close reason text (alias: --reason)")
    .option(
      "-r, --reason <value>",
      "Close reason text (alias for positional <text>)",
    )
    .option(
      "--close-reason <value>",
      "Close reason text (alias for positional <text>)",
    )
    .option(
      "-d, --duplicate-of <id>",
      "Close as a duplicate of the canonical item id and auto-fill duplicate closure metadata",
    )
    .option("--author <value>", "Mutation author")
    .option("-m, --message <value>", "History message")
    .option(
      "--validate-close [mode]",
      'Validate closure metadata before close: "off", "warn", or "strict" (default: settings governance preset)',
    )
    .option(
      "--resolution <value>",
      "Set the closure resolution summary inline (same field --validate-close strict checks; previously required a prior pm update)",
    )
    .option(
      "--expected-result <value>",
      "Set the expected-result note inline (closure validation field)",
    )
    .option("--expected <value>", "Short alias for --expected-result")
    .option(
      "--actual-result <value>",
      "Set the actual-result note inline (closure validation field)",
    )
    .option("--actual <value>", "Short alias for --actual-result")
    .option("--force", "Force ownership override")
    .description(
      "Close an item. Close reason requirement follows governance.require_close_reason.",
    );
  // pm-fl0c #11 (2026-05-28): expose snake_case aliases alongside the canonical
  // kebab-case so agents using --expected_result/--actual_result do not get an
  // Unknown option error; the rendered help stays clean (aliases hidden).
  addHiddenOption(
    closeCommand,
    "--expected_result <value>",
    "Alias for --expected-result",
    false,
  );
  addHiddenOption(
    closeCommand,
    "--actual_result <value>",
    "Alias for --actual-result",
    false,
  );
  closeCommand.action(runCloseAction);

  const closeManyCommand = program
    .command("close-many")
    .description(
      "Bulk-close matched items with a shared reason and full runClose semantics (dry-run + rollback checkpoint).",
    )
    .option("--filter-status <value>", "Filter by status before closing")
    .option("--filter-type <value>", "Filter by item type before closing")
    .option("--filter-tag <value>", "Filter by tag before closing")
    .option("--filter-priority <value>", "Filter by priority before closing")
    .option(
      "--filter-deadline-before <value>",
      "Filter by deadline upper bound before closing",
    )
    .option(
      "--filter-deadline-after <value>",
      "Filter by deadline lower bound before closing",
    )
    .option(
      "--filter-updated-after <value>",
      "Filter by updated_at lower bound before closing (ISO/relative)",
    )
    .option(
      "--filter-updated-before <value>",
      "Filter by updated_at upper bound before closing (ISO/relative)",
    )
    .option(
      "--filter-created-after <value>",
      "Filter by created_at lower bound before closing (ISO/relative)",
    )
    .option(
      "--filter-created-before <value>",
      "Filter by created_at upper bound before closing (ISO/relative)",
    )
    .option("--filter-assignee <value>", "Filter by assignee before closing")
    .option(
      "--filter-assignee-filter <value>",
      "Filter assignee presence: assigned|unassigned before closing",
    )
    .option(
      "--filter-parent <value>",
      "Filter by parent item ID before closing",
    )
    .option("--filter-sprint <value>", "Filter by sprint before closing")
    .option("--filter-release <value>", "Filter by release before closing");
  registerBulkContentAndGovernanceFilters(closeManyCommand, "closing");
  closeManyCommand
    .option(
      "--ids <value>",
      "Restrict to an explicit comma-separated ID allowlist (intersected with other filters)",
    )
    .option("--limit <n>", "Limit matched item count before apply/preview")
    .option("--offset <n>", "Skip first n matched rows before apply/preview")
    .option(
      "--reason <value>",
      "Shared close reason applied to matched items (required when governance.require_close_reason is enabled)",
    )
    .option(
      "--resolution <value>",
      "Shared closure resolution applied to every matched item (closure-validation field)",
    )
    .option(
      "--expected-result <value>",
      "Shared expected-result note (closure-validation field)",
    )
    .option("--expected <value>", "Short alias for --expected-result")
    .option(
      "--actual-result <value>",
      "Shared actual-result note (closure-validation field)",
    )
    .option("--actual <value>", "Short alias for --actual-result")
    .option(
      "--validate-close [mode]",
      'Validate closure metadata per item: "off", "warn", or "strict" (default: settings governance preset)',
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option(
      "--force",
      "Re-close already-terminal matches and override ownership",
    )
    .option(
      "--dry-run",
      "Preview matched items + per-item skip/active-child plan without mutating",
    )
    .option("--rollback <value>", "Rollback a prior close-many checkpoint ID")
    .option("--no-checkpoint", "Disable checkpoint creation during apply mode");
  addHiddenOption(
    closeManyCommand,
    "--filter-assignee_filter <value>",
    "Alias for --filter-assignee-filter",
    false,
  );
  addHiddenOption(
    closeManyCommand,
    "--expected_result <value>",
    "Alias for --expected-result",
    false,
  );
  addHiddenOption(
    closeManyCommand,
    "--actual_result <value>",
    "Alias for --actual-result",
    false,
  );
  closeManyCommand.action(runCloseManyAction);

  program
    .command("delete")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .option(
      "--dry-run",
      "Preview the item file that would be deleted without mutating",
    )
    .description("Delete an item and record the change in history.")
    .action(runDeleteAction);

  program
    .command("append")
    .argument("<id>", "Item id")
    .argument(
      "[text]",
      "Optional body text shorthand (equivalent to --body; use - for stdin)",
    )
    .option("--body <value>", "Text to append to body (or - for stdin)")
    .option("--text <value>", "Alias for --body")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override")
    .description("Append text to an item's body.")
    .action(runAppendAction);

  program
    .command("restore")
    .argument("<id>", "Item id")
    .argument("<target>", "Restore target timestamp or version number")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership/lock override")
    .description("Restore an item to an earlier timestamp or version.")
    .action(runRestoreAction);

  const planCommand = program
    .command("plan")
    .description(
      "Agent-optimized Plan item workflow: create, manage steps, link dependencies, approve, and materialize.",
    )
    .argument(
      "[subcommand]",
      "Plan subcommand: create|show|add-step|update-step|complete-step|block-step|reorder-step|remove-step|link|unlink|decision|discovery|validation|resume|approve|materialize",
    )
    .argument(
      "[id]",
      "Plan id (required for non-create subcommands); for create this may be the positional title",
    )
    .argument(
      "[stepRef]",
      "Step reference: stable id (plan-step-001) or order integer",
    )
    .argument("[reorderTo]", "New order integer for reorder-step")
    .option("--title <value>", "Plan title")
    .option("--description <value>", "Plan description")
    .option(
      "--scope <value>",
      "Short scope statement of the target change or investigation",
    )
    .option("--parent <value>", "Parent pm item id")
    .option(
      "--related <value>",
      "Related pm item ids (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--blocks <value>",
      "Pm item ids this plan blocks (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--blocked-by <value>",
      "Pm item ids that block this plan (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--harness <value>",
      "Plan harness provenance: codex|claude-code|cursor|generic",
    )
    .option(
      "--mode <value>",
      "Plan mode: draft|research|review|approved|executing|paused|completed|superseded",
    )
    .option(
      "--resume-context <value>",
      "Compact context summary for a future stateless agent",
    )
    .option("--tags <value>", "Comma-separated tags")
    .option("--priority <value>", "Priority 0-4")
    .option("--body <value>", "Plan item body")
    .option("--claim", "Claim the plan on create for the author")
    .option(
      "--from-search <value>",
      "Record the search query that led to plan creation",
    )
    .option(
      "--template <value>",
      "Seed plan steps from a built-in template: bug-investigation|feature-implementation|refactoring-sprint",
    )
    .option("--step-title <value>", "Step title for add-step / update-step")
    // pm-6mit: --step is a Commander collect repeatable so `pm plan create
    // --step A --step B` seeds ordered steps (previously a single-value alias
    // for --step-title where the last value silently won). It must NOT be
    // list:true in contracts — the bootstrap coalescer would comma-join values
    // and corrupt titles containing commas.
    .option(
      "--step <value>",
      "Step title (repeatable on create: each --step appends an ordered step; elsewhere a single value aliases --step-title)",
      collect,
    )
    .option("--step-body <value>", "Step body text")
    .option("--step-owner <value>", "Step owner")
    .option(
      "--step-status <value>",
      "Step status: pending|in_progress|completed|blocked|skipped|superseded",
    )
    .option(
      "--step-evidence <value>",
      "Step evidence text (used by update-step/complete-step)",
    )
    .option(
      "--step-blocked-reason <value>",
      "Step blocked reason (required when blocking)",
    )
    .option(
      "--step-replacement <value>",
      "Replacement reference for a superseded step",
    )
    .option(
      "--depends-on <value>",
      "Pm item ids the step depends on (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--link <value>",
      "Pm item id to link (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--link-kind <value>",
      "Link kind: related|blocks|blocked_by|depends_on|discovered_from|implements|verifies|supersedes",
    )
    .option("--link-note <value>", "Optional note for the link")
    .option(
      "--promote-to-item-dep",
      "Also add the linked id as a top-level item dependency when linking",
    )
    .option(
      "--allow-multiple-active",
      "Allow multiple steps to be in_progress at once",
    )
    .option(
      "--file <value>",
      "Step linked file path=<value>[,scope=project|global,note=<text>] (repeatable)",
      collect,
    )
    .option(
      "--test <value>",
      "Step linked test command=<value>[,path=<value>,note=<text>] (repeatable)",
      collect,
    )
    .option(
      "--doc <value>",
      "Step linked doc path=<value>[,scope=project|global,note=<text>] (repeatable)",
      collect,
    )
    .option("--decision-text <value>", "Decision log entry text")
    .option("--decision <value>", "Alias for --decision-text")
    .option("--decision-rationale <value>", "Decision log entry rationale")
    .option("--decision-evidence <value>", "Decision log entry evidence")
    .option("--discovery-text <value>", "Discovery log entry text")
    .option("--discovery <value>", "Alias for --discovery-text")
    .option("--validation-text <value>", "Validation log entry text")
    .option("--validation <value>", "Alias for --validation-text")
    .option("--validation-command <value>", "Validation log entry command")
    .option(
      "--validation-expected <value>",
      "Validation log entry expected outcome",
    )
    .option(
      "--depth <value>",
      "Show depth: brief|standard|deep (default: brief)",
    )
    .option(
      "--fields <value>",
      "Comma-separated field projection for show output",
    )
    .option(
      "--steps <value>",
      "Comma-separated step ids/orders for materialize",
    )
    .option(
      "--materialize-type <value>",
      "Item type for materialized steps (default: Task)",
    )
    .option(
      "--materialize-parent <value>",
      "Parent item id for materialized children (default: the plan)",
    )
    .option(
      "--materialize-tags <value>",
      "Comma-separated tags for materialized children",
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "Mutation message")
    .option("--force", "Force ownership override");
  // Hidden pure snake_case underscore-duplicate aliases (kept parse-functional,
  // omitted from --help to save agent context).
  addHiddenOptions(
    planCommand,
    [
      ["--resume_context <value>", "Alias for --resume-context"],
      ["--from_search <value>", "Alias for --from-search"],
      ["--step_title <value>", "Alias for --step-title"],
      ["--step_body <value>", "Alias for --step-body"],
      ["--step_owner <value>", "Alias for --step-owner"],
      ["--step_status <value>", "Alias for --step-status"],
      ["--step_evidence <value>", "Alias for --step-evidence"],
      ["--step_blocked_reason <value>", "Alias for --step-blocked-reason"],
      ["--step_replacement <value>", "Alias for --step-replacement"],
      ["--link_kind <value>", "Alias for --link-kind"],
      ["--link_note <value>", "Alias for --link-note"],
      ["--promote_to_item_dep", "Alias for --promote-to-item-dep"],
      ["--allow_multiple_active", "Alias for --allow-multiple-active"],
      ["--decision_text <value>", "Alias for --decision-text"],
      ["--decision_rationale <value>", "Alias for --decision-rationale"],
      ["--decision_evidence <value>", "Alias for --decision-evidence"],
      ["--discovery_text <value>", "Alias for --discovery-text"],
      ["--validation_text <value>", "Alias for --validation-text"],
      ["--validation_command <value>", "Alias for --validation-command"],
      ["--validation_expected <value>", "Alias for --validation-expected"],
      ["--materialize_type <value>", "Alias for --materialize-type"],
      ["--materialize_parent <value>", "Alias for --materialize-parent"],
      ["--materialize_tags <value>", "Alias for --materialize-tags"],
    ],
    false,
  );
  addHiddenOptions(
    planCommand,
    [
      ["--blocked_by <value>", "Alias for --blocked-by"],
      ["--depends_on <value>", "Alias for --depends-on"],
    ],
    true,
  );
  planCommand.action(runPlanAction);
  void planCommand;

  program
    .command("history-redact")
    .argument("<id>", "Item id")
    .option(
      "--literal <value>",
      "Literal string to redact (repeatable)",
      collect,
    )
    .option(
      "--regex <value>",
      "Regex pattern to redact (repeatable; accepts /pattern/flags or raw pattern)",
      collect,
    )
    .option(
      "--replacement <value>",
      'Replacement string (default: "[redacted]")',
    )
    .option(
      "--dry-run",
      "Preview redaction impact without writing item/history files",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the redaction marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Redact sensitive literals/patterns from an item history stream and recompute hashes.",
    )
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runHistoryRedact } = await import("./commands/history-redact.js");
      const literal = Array.isArray(options.literal)
        ? (options.literal as string[])
        : undefined;
      const regex = Array.isArray(options.regex)
        ? (options.regex as string[])
        : undefined;
      const result = await runHistoryRedact(
        id,
        {
          literal,
          regex,
          replacement:
            typeof options.replacement === "string"
              ? options.replacement
              : undefined,
          dryRun: options.dryRun === true,
          author:
            typeof options.author === "string" ? options.author : undefined,
          message:
            typeof options.message === "string" ? options.message : undefined,
          force: Boolean(options.force),
        },
        globalOptions,
      );
      if (result.changed && !result.dry_run) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(
          `profile:command=history-redact took_ms=${Date.now() - startedAt}`,
        );
      }
    });

  program
    .command("history-repair")
    .argument("[id]", "Item id (omit with --all)")
    .option(
      "--all",
      "Scan every stream for drift and repair each drifted stream in one audited pass",
    )
    .option(
      "--dry-run",
      "Preview the re-anchor impact without writing the history file",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the repair marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Re-anchor a drifted item history chain (recompute hashes, reconcile with the on-disk item) and record an audit marker. Use --all to repair every drifted stream.",
    )
    .action(
      async (
        id: string | undefined,
        options: Record<string, unknown>,
        command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const {
          runHistoryRepair,
          runHistoryRepairAll,
          assertHistoryRepairTarget,
        } = await import("./commands/history-repair.js");
        const all = options.all === true;
        assertHistoryRepairTarget(id, all);
        const repairOptions = {
          dryRun: options.dryRun === true,
          author:
            typeof options.author === "string" ? options.author : undefined,
          message:
            typeof options.message === "string" ? options.message : undefined,
          force: Boolean(options.force),
        };
        // history-repair only re-anchors the audit stream; item content is untouched,
        // so search caches do not need invalidation.
        if (all) {
          const result = await runHistoryRepairAll(
            repairOptions,
            globalOptions,
          );
          printResult(result, globalOptions);
          if (result.totals.failed > 0) {
            // Per-stream failures are collected (one bad stream never aborts the
            // pass) but must still fail the command for gating callers.
            process.exitCode = EXIT_CODE.GENERIC_FAILURE;
          }
        } else {
          const result = await runHistoryRepair(
            id as string,
            repairOptions,
            globalOptions,
          );
          printResult(result, globalOptions);
        }
        if (globalOptions.profile) {
          printError(
            `profile:command=history-repair took_ms=${Date.now() - startedAt}`,
          );
        }
      },
    );

  program
    .command("history-compact")
    .argument("[id]", "Item id (omit when using a bulk selector)")
    .option(
      "--before <value>",
      "Compact entries strictly before this version number or ISO timestamp (single-id mode only)",
    )
    .option(
      "--ids <value>",
      "Bulk: compact an explicit comma-separated list of item ids",
    )
    .option(
      "--all-over <n>",
      "Bulk: compact every stream with more than N entries",
    )
    .option("--closed", "Bulk: compact only closed (terminal) items' streams")
    .option(
      "--all-streams",
      "Bulk: compact every history stream regardless of lifecycle state",
    )
    .option(
      "--min-entries <n>",
      "Bulk: skip streams with at most N entries (already compact; default 3)",
    )
    .option(
      "--dry-run",
      "Preview compaction impact without writing the history file",
    )
    .option("--author <value>", "Mutation author")
    .option(
      "--message <value>",
      "Audit history message for the compaction marker entry",
    )
    .option("--force", "Force ownership/lock override")
    .description(
      "Compact item history streams into a synthetic baseline plus retained tail entries. Pass an item id for one stream, or a bulk selector (--ids/--all-over/--closed/--all-streams) to compact many.",
    )
    .action(runHistoryCompactAction);

  const schemaCommand = program
    .command("schema")
    .argument(
      "[subcommand]",
      "Schema subcommand: list, show, show-status, add-type, remove-type, add-status, remove-status, or a custom item type name shorthand",
    )
    .argument(
      "[name]",
      "Item type name (add-type/remove-type/show) or status id (show-status/add-status/remove-status)",
    )
    .option(
      "--description <text>",
      "Human description for the custom item type, status, or field",
    )
    .option(
      "--default-status <status>",
      "Default status hint recorded for the custom item type",
    )
    .option("--folder <dir>", "Storage folder for items of this custom type")
    .option(
      "--alias <name>",
      "Alias for the custom type, status, or field flag (repeatable, csv-friendly)",
      collect,
    )
    .option(
      "--role <value>",
      "Lifecycle role for a custom status (repeatable): draft, active, blocked, terminal, terminal_done, terminal_canceled, default_open, default_close, default_cancel",
      collect,
    )
    .option("--order <n>", "Display/sort order for a custom status")
    .option(
      "--type <type>",
      "Value type for a custom field (add-field): string, number, boolean, string_array",
    )
    .option(
      "--commands <list>",
      "Commands a custom field is wired onto (add-field; repeatable, comma-friendly): create, update, update_many, list, search, calendar, context",
      collect,
    )
    .option(
      "--cli-flag <flag>",
      "Override the auto-derived CLI flag for a custom field (add-field)",
    )
    .option("--required", "Mark a custom field as always required (add-field)")
    .option(
      "--required-on-create",
      "Mark a custom field as required at create time (add-field)",
    )
    .option(
      "--no-allow-unset",
      "Disallow clearing a custom field via --unset (add-field)",
    )
    .option(
      "--required-types <list>",
      "Restrict a custom field's requirement to specific item types (add-field; repeatable, comma-friendly)",
      collect,
    )
    .option(
      "--infer",
      "Infer custom item types from title-prefix conventions (add-type; preview unless --apply)",
    )
    .option(
      "--min-count <n>",
      "Minimum items sharing a prefix for add-type --infer (default 10)",
    )
    .option(
      "--apply",
      "Register inferred types (add-type --infer); without it the command previews only",
    )
    .option("--author <value>", "Mutation author")
    .option("--force", "Force ownership/lock override")
    .description(
      "Inspect and manage config-driven runtime schema (types, statuses, fields, presets).",
    );
  // Hidden pure snake_case underscore-duplicate alias.
  addHiddenOption(
    schemaCommand,
    "--default_status <status>",
    "Alias for --default-status",
    false,
  );
  schemaCommand.action(runSchemaAction);

  const profileCommand = program
    .command("profile")
    .argument("[subcommand]", "Profile subcommand: list, show, apply, or lint")
    .argument(
      "[name]",
      "Profile name for show/apply/lint: agile, ops, or research",
    )
    .option(
      "--dry-run",
      "Preview the apply diff without writing any files (apply)",
    )
    .option("--author <value>", "Mutation author")
    .option("--force", "Force ownership/lock override")
    .description(
      "List, show, apply, and lint project profiles — archetype bundles of item types, statuses, fields, workflows, config, templates, and recommended packages.",
    );
  profileCommand.action(runProfileAction);

  const commentsCommand = program
    .command("comments")
    .argument("<id>", "Item id")
    .argument("[text]", "Optional comment text shorthand (equivalent to --add)")
    .option(
      "--add <text>",
      "Add one comment entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)",
    )
    .option(
      "--stdin",
      "Read comment text from stdin (supports multiline markdown)",
    )
    .option(
      "--file <path>",
      "Read comment text from file (supports multiline markdown)",
    )
    .option(
      "--edit <index>",
      "Replace the comment at 1-based <index> (replacement text from positional [text], --add, --stdin, or --file)",
      parsePositiveIntOption("--edit"),
    )
    .option(
      "--delete <index>",
      "Delete the comment at 1-based <index>",
      parsePositiveIntOption("--delete"),
    )
    .option("--limit <n>", "Return only latest n comments")
    .option(
      "--author [value]",
      "Comment author (optional; falls back to PM_AUTHOR/settings)",
    )
    .option("--message <value>", "History message")
    .option(
      "--allow-audit-comment",
      "Allow non-owner append-only comment audits (add/edit/delete) without requiring --force",
    )
    .option("--force", "Force ownership override")
    .description("List, add, edit, or delete comments for an item.")
    .action(runCommentsAction);
  addHiddenOption(commentsCommand, "--body <text>", "Alias for --add", false);
  addHiddenOption(
    commentsCommand,
    "--comment <text>",
    "Alias for --add",
    false,
  );

  program
    .command("notes")
    .argument("<id>", "Item id")
    .argument(
      "[text]",
      "Optional note text shorthand (equivalent to --add; use - for stdin)",
    )
    .option(
      "--add <text>",
      "Add one note entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)",
    )
    .option("--limit <n>", "Return only latest n notes")
    .option(
      "--author [value]",
      "Note author (optional; falls back to PM_AUTHOR/settings)",
    )
    .option("--message <value>", "History message")
    .option(
      "--allow-audit-note",
      "Allow non-owner append-only note audits without requiring --force",
    )
    .option(
      "--allow-audit-comment",
      "Backward-compatible alias for --allow-audit-note",
    )
    .option("--force", "Force ownership override")
    .description("List or add notes for an item.")
    .action(runNotesAction);

  program
    .command("learnings")
    .argument("<id>", "Item id")
    .argument(
      "[text]",
      "Optional learning text shorthand (equivalent to --add; use - for stdin)",
    )
    .option(
      "--add <text>",
      "Add one learning entry (plain text fallback, text=<value>, markdown pairs, or - for stdin; CSV-like key fragments are preserved as plain text unless text is explicit)",
    )
    .option("--limit <n>", "Return only latest n learnings")
    .option(
      "--author [value]",
      "Learning author (optional; falls back to PM_AUTHOR/settings)",
    )
    .option("--message <value>", "History message")
    .option(
      "--allow-audit-learning",
      "Allow non-owner append-only learning audits without requiring --force",
    )
    .option(
      "--allow-audit-comment",
      "Backward-compatible alias for --allow-audit-learning",
    )
    .option("--force", "Force ownership override")
    .description("List or add learnings for an item.")
    .action(runLearningsAction);

  const filesCommand = program
    .command("files")
    .description("Manage files linked to an item.");

  filesCommand
    .argument("<id>", "Item id")
    .option(
      "--add <value>",
      "Add linked file entry (CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--add-glob <value>",
      "Add linked file entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)",
      collect,
    )
    .option(
      "--remove <value>",
      "Remove linked file by path only (path=<value>, path:<value>, plain path, or - for stdin); does not accept note=/scope= — record removal context with --message",
      collect,
    )
    .option(
      "--migrate <value>",
      "Migrate linked file paths in-place (from=<prefix>,to=<prefix>; repeatable)",
      collect,
    )
    .option(
      "--note <value>",
      "Note attached to every link added by --add/--add-glob in this invocation (embedded note= wins)",
    )
    .option("--list", "List linked files without mutating")
    .option(
      "--append-stable",
      "Preserve existing linked-file order and append new links without full-array resorting",
    )
    .option(
      "--validate-paths",
      "Validate linked file paths for existence and file shape",
    )
    .option(
      "--audit",
      "Audit linked file usage across all items for this item's linked paths",
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .action(runFilesAction);

  filesCommand
    .command("discover")
    .argument("<id>", "Item id")
    .option("--apply", "Add discovered missing files to the item")
    .option("--note <value>", "Note to attach to discovered file links")
    .option(
      "--append-stable",
      "Preserve existing linked-file order and append discovered links without full-array resorting",
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description(
      "Discover existing file paths referenced in item text and optionally link missing files.",
    )
    .action(runFilesDiscoverAction);

  program
    .command("docs")
    .argument("<id>", "Item id")
    .option(
      "--add <value>",
      "Add linked doc entry (CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--add-glob <value>",
      "Add linked doc entries from a glob (plain glob or pattern=<glob>,scope=<scope>,note=<text>; repeatable)",
      collect,
    )
    .option(
      "--remove <value>",
      "Remove linked doc by path only (path=<value>, path:<value>, plain path, or - for stdin); does not accept note=/scope= — record removal context with --message",
      collect,
    )
    .option(
      "--migrate <value>",
      "Migrate linked doc paths in-place (from=<prefix>,to=<prefix>; repeatable)",
      collect,
    )
    .option(
      "--note <value>",
      "Note attached to every link added by --add/--add-glob in this invocation (embedded note= wins)",
    )
    .option("--list", "List linked docs without mutating")
    .option(
      "--validate-paths",
      "Validate linked doc paths for existence and file shape",
    )
    .option(
      "--audit",
      "Audit linked doc usage across all items for this item's linked paths",
    )
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Manage docs linked to an item.")
    .action(runDocsAction);

  program
    .command("deps")
    .argument("<id>", "Item id")
    .option("--format <value>", "Output format (tree or graph)", "tree")
    .option(
      "--max-depth <value>",
      "Maximum dependency traversal depth (0 keeps only the root)",
    )
    .option("--collapse <value>", "Collapse mode (none or repeated)", "none")
    .option("--summary", "Return counts only without full tree/graph payload")
    .description("Show dependency relationships for an item.")
    .action(runDepsAction);
}
