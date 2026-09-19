/**
 * @module sdk/runtime/schema
 * Translates schema action arguments into SDK schema operations.
 */
import { createUnknownSubcommandError } from "../agent/subcommand-recovery.js";
import { WORKFLOW_POLICY_ACTIONS,runWorkflowPolicyAction } from "../governance/workflow-policy.js";
import {
  parseRuntimeInteger as parseMcpInteger,
  readRuntimeString as readString,
  readRuntimeStringArray as readStringArray
} from "../runtime-input.js";
import {
  SCHEMA_SUBCOMMANDS,
  runSchemaAddField,
  runSchemaAddStatus,
  runSchemaAddType,
  runSchemaApplyPreset,
  runSchemaEvolutionMigration,
  runSchemaInferTypes,
  runSchemaList,
  runSchemaListFields,
  runSchemaRemoveField,
  runSchemaRemoveStatus,
  runSchemaRemoveType,
  runSchemaShow,
  runSchemaShowField,
  runSchemaShowStatus,
  type SchemaEvolutionMigrationRequest,
  type SchemaEvolutionMigrationResult
} from "../schema.js";
import type { McpActionDispatchContext } from "./context.js";
import { getOwnHandler,readRequiredString } from "./context.js";

interface McpSchemaContext {
  ctx: McpActionDispatchContext;
  subcommand: string;
  name: string | undefined;
  author: string | undefined;
  force: boolean;
  aliases: string[] | undefined;
}

/** Normalize schema subcommand, name, author, force and aliases once for all schema action handlers. */
function createMcpSchemaContext(
  ctx: McpActionDispatchContext,
): McpSchemaContext {
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const aliasSource = ctx.args.alias ?? ctx.options.alias;
  return {
    ctx,
    subcommand: subcommand.trim().toLowerCase(),
    name: readString(ctx.args, "name") ?? readString(ctx.options, "name"),
    author: readString(ctx.args, "author") ?? readString(ctx.options, "author"),
    force: ctx.args.force === true || ctx.options.force === true,
    aliases:
      aliasSource === undefined ? undefined : readStringArray(aliasSource),
  };
}

/** Dispatch schema inspection, removal and preset operations, returning null when a specialized handler is needed. */
function runMcpSchemaReadOrRemoveAction(
  schema: McpSchemaContext,
): Promise<unknown> | unknown | null {
  const { ctx, subcommand, name, author, force } = schema;
  const simpleHandlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runSchemaList(ctx.global),
    show: () => runSchemaShow(name, ctx.global),
    "show-status": () => runSchemaShowStatus(name, ctx.global),
    "list-fields": () => runSchemaListFields(ctx.global),
    "show-field": () => runSchemaShowField(name, ctx.global),
    "remove-type": () =>
      runSchemaRemoveType(name, { author, force }, ctx.global),
    "remove-field": () =>
      runSchemaRemoveField(name, { author, force }, ctx.global),
    "remove-status": () =>
      runSchemaRemoveStatus(name, { author, force }, ctx.global),
    "apply-preset": () =>
      runSchemaApplyPreset(
        readString(ctx.args, "typePreset") ??
          readString(ctx.options, "typePreset"),
        { author, force },
        ctx.global,
      ),
  };
  const handler = getOwnHandler(simpleHandlers, subcommand);
  return handler ? handler() : null;
}

/** Translate transport field declarations, requirement policies and aliases into the SDK schema field creation contract. */
function runMcpSchemaAddFieldAction(
  schema: McpSchemaContext,
): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const commandsSource = ctx.args.commands ?? ctx.options.commands;
  const requiredTypesSource =
    ctx.args.requiredTypes ?? ctx.options.requiredTypes;
  return runSchemaAddField(
    name,
    {
      type:
        readString(ctx.args, "fieldType") ??
        readString(ctx.options, "fieldType"),
      commands:
        commandsSource === undefined
          ? undefined
          : readStringArray(commandsSource),
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      cliFlag:
        readString(ctx.args, "cliFlag") ?? readString(ctx.options, "cliFlag"),
      alias: aliases,
      required: ctx.args.required === true || ctx.options.required === true,
      requiredOnCreate:
        ctx.args.requiredOnCreate === true ||
        ctx.options.requiredOnCreate === true,
      allowUnset: !(
        ctx.args.allowUnset === false || ctx.options.allowUnset === false
      ),
      requiredTypes:
        requiredTypesSource === undefined
          ? undefined
          : readStringArray(requiredTypesSource),
      author,
      force,
    },
    ctx.global,
  );
}

/** Resolve status roles, aliases and strict integer ordering before invoking the schema status mutation. */
function runMcpSchemaAddStatusAction(
  schema: McpSchemaContext,
): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  const roleSource = ctx.args.role ?? ctx.options.role;
  return runSchemaAddStatus(
    name,
    {
      role: roleSource === undefined ? undefined : readStringArray(roleSource),
      alias: aliases,
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      order: parseMcpInteger(
        ctx.args.order ?? ctx.options.order,
        "schema add-status order",
      ),
      author,
      force,
    },
    ctx.global,
  );
}

/** Resolve item type metadata and both default-status spellings before invoking the schema type mutation. */
function runMcpSchemaAddTypeAction(schema: McpSchemaContext): Promise<unknown> {
  const { ctx, name, author, force, aliases } = schema;
  return runSchemaAddType(
    name,
    {
      description:
        readString(ctx.args, "description") ??
        readString(ctx.options, "description"),
      defaultStatus:
        readString(ctx.args, "defaultStatus") ??
        readString(ctx.args, "default_status") ??
        readString(ctx.options, "defaultStatus") ??
        readString(ctx.options, "default_status"),
      folder:
        readString(ctx.args, "folder") ?? readString(ctx.options, "folder"),
      alias: aliases,
      author,
      force,
    },
    ctx.global,
  );
}

/** Construct the requested type, field or status migration with dry-run, scope and migration identity options. */
function runMcpSchemaMigrationAction(
  schema: McpSchemaContext,
): Promise<SchemaEvolutionMigrationResult> {
  const { ctx, subcommand, name, author, force } = schema;
  const to =
    readString(ctx.args, "to") ?? readRequiredString(ctx.options, "to");
  const migrationId =
    readString(ctx.args, "migrationId") ??
    readString(ctx.args, "migration_id") ??
    readString(ctx.options, "migrationId") ??
    readString(ctx.options, "migration_id");
  const fieldTypeScope =
    readString(ctx.args, "fieldTypeScope") ??
    readString(ctx.options, "fieldTypeScope") ??
    readString(ctx.args, "type") ??
    readString(ctx.options, "type");
  const request: SchemaEvolutionMigrationRequest =
    subcommand === "rename-type"
      ? { kind: "rename-type", from: name ?? "", to }
      : subcommand === "rename-field"
        ? {
            kind: "rename-field",
            from: name ?? "",
            to,
            ...(fieldTypeScope === undefined ? {} : { type: fieldTypeScope }),
          }
        : { kind: "remap-status", from: name ?? "", to };
  return runSchemaEvolutionMigration(
    request,
    {
      migrationId,
      dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
      author,
      force,
    },
    ctx.global,
  );
}

/** Translate schema transport arguments into the matching SDK schema or workflow-policy operation. */
function runMcpSchemaAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> | unknown {
  const schema = createMcpSchemaContext(ctx);
  const policyAction = WORKFLOW_POLICY_ACTIONS.find((action) => action === schema.subcommand);
  if (policyAction) return runWorkflowPolicyAction(policyAction, schema.name, {
    definition: ctx.args.definition ?? ctx.options.definition,
    policy: readString(ctx.args, "policy") ?? readString(ctx.options, "policy"),
    message: readString(ctx.args, "message") ?? readString(ctx.options, "message"),
    author: schema.author,
    dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
  }, ctx.global);
  const simpleResult = runMcpSchemaReadOrRemoveAction(schema);
  if (simpleResult !== null) {
    return simpleResult;
  }
  if (
    ["rename-type", "rename-field", "remap-status"].includes(schema.subcommand)
  ) {
    return runMcpSchemaMigrationAction(schema);
  }
  if (schema.subcommand === "add-field") {
    return runMcpSchemaAddFieldAction(schema);
  }
  if (schema.subcommand === "add-status") {
    return runMcpSchemaAddStatusAction(schema);
  }
  if (schema.subcommand === "add-type") {
    if (ctx.args.infer === true || ctx.options.infer === true) {
      return runSchemaInferTypes(
        {
          minCount: parseMcpInteger(
            ctx.args.minCount ?? ctx.options.minCount,
            "schema infer minCount",
          ),
          apply: ctx.args.apply === true || ctx.options.apply === true,
          author: schema.author,
          force: schema.force,
        },
        ctx.global,
      );
    }
    return runMcpSchemaAddTypeAction(schema);
  }
  throw createUnknownSubcommandError({
    command_path: "schema",
    token: schema.subcommand,
    allowed: SCHEMA_SUBCOMMANDS,
    exit_code: 64,
  });
}

export { runMcpSchemaAction };
