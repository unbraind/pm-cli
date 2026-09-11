/** @module cli/schema/registration Schema command parsing and presentation over public SDK operations. */
import type { Command } from "commander";
import { stringArrayOption } from "../option-values.js";
import { WORKFLOW_POLICY_ACTIONS } from "../../sdk/cli-contracts/enum-contracts.js";
import { EXIT_CODE, PmCliError, createUnknownSubcommandError, type GlobalOptions } from "../../sdk/runtime-primitives.js";
import * as schemaModule from "../commands/schema.js";
import { looksLikeSchemaSubcommandTypo, parseSchemaOrderOption } from "../schema-registration-helpers.js";
import { addHiddenOption, collect, formatHookWarnings, getGlobalOptions, printError, printResult, readOptionString, writeStdout } from "../registration-helpers.js";

/** Derive dispatch and presentation contracts from the existing command adapter. */
type SchemaCommandModule = typeof schemaModule;
/** Results accepted by the common schema renderer. */
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
  | Awaited<ReturnType<SchemaCommandModule["runSchemaInferTypes"]>>
  | Awaited<ReturnType<SchemaCommandModule["runSchemaEvolutionMigration"]>>;

/** Parsed schema inputs shared by each SDK-backed subcommand. */
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

/** Recognize schema migration verbs and forward their idempotency and preview controls. */
function dispatchSchemaMigration(
  schema: SchemaCommandModule,
  inputs: SchemaDispatchInputs,
): Promise<SchemaCommandResult> | null {
  const kind = inputs.normalizedSubcommand;
  if (
    kind !== "rename-type" &&
    kind !== "rename-field" &&
    kind !== "remap-status"
  ) {
    return null;
  }
  return schema.runSchemaEvolutionMigration(
    {
      kind,
      from: inputs.typeName!,
      to: readOptionString(inputs.options, "to")!,
      ...(kind === "rename-field" && typeof inputs.options.type === "string"
        ? { type: inputs.options.type }
        : {}),
    },
    {
      migrationId:
        readOptionString(inputs.options, "migrationId") ??
        readOptionString(inputs.options, "migration_id"),
      dryRun: inputs.options.dryRun === true,
      author: inputs.author,
      force: inputs.force,
    },
    inputs.globalOptions,
  );
}

/** Route inspection, removal, and preset verbs without interpreting their SDK results. */
function dispatchSchemaReadRemoveOrPreset(
  schema: SchemaCommandModule,
  inputs: SchemaDispatchInputs,
): Promise<SchemaCommandResult> | null {
  const { normalizedSubcommand, typeName, globalOptions, author, force } =
    inputs;
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
    case "remove-status":
      return schema.runSchemaRemoveStatus(
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
    default:
      return null;
  }
}

/** Route normalized schema verbs while preserving field requirements and custom workflow roles. */
async function dispatchSchemaSubcommand(
  schema: SchemaCommandModule,
  inputs: SchemaDispatchInputs,
): Promise<SchemaCommandResult> {
  const { normalizedSubcommand, typeName, options, globalOptions } = inputs;
  const { author, force, description } = inputs;
  const migration = dispatchSchemaMigration(schema, inputs);
  if (migration) return migration;
  const readRemoveOrPreset = dispatchSchemaReadRemoveOrPreset(schema, inputs);
  if (readRemoveOrPreset) return readRemoveOrPreset;
  switch (normalizedSubcommand) {
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

/** Render schema results for human output and retain mutation hook diagnostics. */
function renderSchemaResultHuman(
  schema: SchemaCommandModule,
  result: SchemaCommandResult,
): void {
  if ("migration_id" in result) {
    writeStdout(`${schema.formatSchemaEvolutionMigrationHuman(result)}\n`);
    return;
  }
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

/** Split repeated CSV options into trimmed entries, excluding empty segments. */
function splitCollectedCommaList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return (raw as string[])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Resolve schema shorthand, dispatch policies or definitions, and respect global presentation controls. */
async function runSchemaAction(
  subcommand: string | undefined,
  name: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { SCHEMA_SUBCOMMANDS } = schemaModule;
  let normalizedSubcommand = (subcommand ?? "").trim().toLowerCase();
  let typeName = name;
  assertSchemaSubcommandPresent(normalizedSubcommand, SCHEMA_SUBCOMMANDS);
  if (
    !SCHEMA_SUBCOMMANDS.includes(
      normalizedSubcommand as (typeof SCHEMA_SUBCOMMANDS)[number],
    ) &&
    typeName === undefined &&
    !looksLikeSchemaSubcommandTypo(subcommand!)
  ) {
    typeName = subcommand;
    normalizedSubcommand = "add-type";
  }
  if (
    !SCHEMA_SUBCOMMANDS.includes(
      normalizedSubcommand as (typeof SCHEMA_SUBCOMMANDS)[number],
    )
  ) {
    throw createUnknownSubcommandError({
      command_path: "schema",
      token: normalizedSubcommand,
      allowed: SCHEMA_SUBCOMMANDS,
    });
  }
  const policyAction = WORKFLOW_POLICY_ACTIONS.find(
    (action) => action === normalizedSubcommand,
  );
  if (policyAction) {
    printResult(await schemaModule.runWorkflowPolicyAction(policyAction, name, {
      definition: options.definition,
      policy: readOptionString(options, "policy"),
      message: readOptionString(options, "message"),
      author: readOptionString(options, "author"),
      dryRun: options.dryRun === true,
    }, globalOptions), globalOptions);
  } else {
    const result = await dispatchSchemaSubcommand(schemaModule, {
      normalizedSubcommand,
      typeName,
      options,
      aliases: stringArrayOption(options.alias),
      roles: stringArrayOption(options.role),
      commands: splitCollectedCommaList(options.commands),
      requiredTypes: splitCollectedCommaList(options.requiredTypes),
      defaultStatus: readOptionString(options, "defaultStatus") ?? readOptionString(options, "default_status"),
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
  }
  if (globalOptions.profile) {
    printError(`profile:command=schema took_ms=${Date.now() - startedAt}`);
  }
}

/** Refuse a missing schema verb with executable examples before any mutation. */
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
        "pm schema rename-type Spike --to Experiment --migration-id spike-v2 --dry-run",
        "pm schema rename-field severity --to impact --migration-id severity-v2",
        "pm schema remap-status review --to verifying --migration-id review-v2",
      ],
    },
  );
}

/** Register schema controls in discoverable groups without changing SDK mutation semantics. */
export function registerSchemaCommand(program: Command): void {
  const schemaCommand = program
    .command("schema")
    .option("--definition <json>", "Policy or proposed fields JSON")
    .option("--policy <id>", "Policy id for policy-approve")
    .option("--message <text>", "Audit rationale for a policy mutation")
    .argument(
      "[subcommand]",
      "Required; schema verb (list/show, add/remove, rename/remap, policy-*), or custom type shorthand",
    )
    .argument(
      "[name]",
      "Definition/source name or item id; policy-mode: advise|refuse",
    )
    .option(
      "--description <text>",
      "Type, status, or field description",
    )
    .option(
      "--default-status <status>",
      "Default status for this type",
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
    .optionsGroup("Field options (add-field):")
    .option(
      "--type <type>",
      "Value type for a custom field (add-field): string, number, boolean, string_array, array, object",
    )
    .option(
      "--commands <list>",
      "Field commands (repeatable/csv): create, update, update_many, list, search, calendar, context",
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
    .optionsGroup("Type inference and migration options:")
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
    .option("--to <name>", "Target definition name for rename/remap migrations")
    .option(
      "--migration-id <id>",
      "Stable idempotency key for a resumable schema migration",
    )
    .option(
      "--dry-run",
      "Preview schema changes without writes",
    )
    .option("--author <value>", "Mutation author")
    .option("--force", "Force ownership/lock override")
    .description(
      "Manage types, statuses, fields, presets, and workflow policies.",
    );
  // Hidden pure snake_case underscore-duplicate alias.
  addHiddenOption(
    schemaCommand,
    "--default_status <status>",
    "Alias for --default-status",
    false,
  );
  addHiddenOption(
    schemaCommand,
    "--migration_id <id>",
    "Alias for --migration-id",
    false,
  );
  schemaCommand.action(runSchemaAction);

}
