/**
 * @module mcp/tool-definitions
 *
 * Defines the Tool Definitions module for pm CLI source.
 */
import { PM_TOOL_ACTIONS } from "../sdk/cli-contracts/enum-contracts.js";
import { COPY_FLAG_CONTRACTS } from "../sdk/cli-contracts/flag-contracts.js";
import { RUNTIME_STATUS_ROLE_VALUES } from "../types.js";

/**
 * Static MCP tool surface for the pm MCP server.
 *
 * Kept as a dependency-light data module (only the enum contract import) so the
 * `pm contracts` command can snapshot the tool surface into the contract
 * golden file (pm-4os2) without importing the full MCP server runtime, and so
 * the server itself stays the single consumer of the dispatch handlers.
 */
export interface ToolDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports description for this contract. */
  description: string;
  /** Value that configures or reports input schema for this contract. */
  inputSchema: Record<string, unknown>;
}

const TOOL_SCHEMA_BASE = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description:
        "Workspace directory to run the native pm operation in. Defaults to the MCP server process cwd.",
    },
    path: {
      type: "string",
      description:
        "Optional pm data root, equivalent to PM_PATH/global --path. Leave unset for real repository tracking.",
    },
    author: {
      type: "string",
      description:
        "Mutation author. Defaults to PM_AUTHOR or pm settings when supported by the underlying operation.",
    },
  },
  additionalProperties: true,
} as const;

const idSchema = {
  type: "string",
  description: "pm item id, for example pm-abc1.",
};

// pm-fd8n: derive the pm_run action enumeration from the canonical
// PM_TOOL_ACTIONS contract instead of a hand-maintained prose list, so the
// MCP-facing description can never drift from the actual supported actions.
const PM_RUN_ACTION_DESCRIPTION =
  `Operation name (one of): ${PM_TOOL_ACTIONS.join(", ")}. ` +
  "Package-owned actions are available dynamically when their provider package is installed.";

const LIST_TOP_LEVEL_OPTION_PROPERTIES: Record<string, unknown> = {
  status: { type: "string", description: "Alias for options.status." },
  type: { type: "string", description: "Alias for options.type." },
  tag: { type: "string", description: "Alias for options.tag." },
  priority: { type: "string", description: "Alias for options.priority." },
  limit: {
    type: ["string", "number"],
    description: "Alias for options.limit.",
  },
  offset: {
    type: ["string", "number"],
    description: "Alias for options.offset.",
  },
};

const SEARCH_TOP_LEVEL_OPTION_PROPERTIES: Record<string, unknown> = {
  mode: { type: "string", description: "Alias for options.mode." },
  status: { type: "string", description: "Alias for options.status." },
  type: { type: "string", description: "Alias for options.type." },
  tag: { type: "string", description: "Alias for options.tag." },
  priority: { type: "string", description: "Alias for options.priority." },
  limit: {
    type: ["string", "number"],
    description: "Alias for options.limit.",
  },
};

const COPY_TOP_LEVEL_OPTION_PROPERTIES: Record<string, unknown> = Object.fromEntries(
  COPY_FLAG_CONTRACTS.filter(({ flag }) => flag !== "--author").map(({ flag }) => [
    flag.slice(2),
    { type: "string", description: `Alias for options.${flag.slice(2).replaceAll("-", "_")}.` },
  ]),
);

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    ...TOOL_SCHEMA_BASE,
    properties: {
      ...TOOL_SCHEMA_BASE.properties,
      ...properties,
    },
    required,
  };
}

/** Public contract for tools, shared by SDK and presentation-layer consumers. */
export const TOOLS: ToolDefinition[] = [
  {
    name: "pm_run",
    description:
      "Run any supported pm operation natively through the pm library. Use this for commands not covered by narrower pm_* tools.",
    inputSchema: objectSchema(
      {
        action: {
          type: "string",
          description: PM_RUN_ACTION_DESCRIPTION,
        },
        id: idSchema,
        query: {
          type: "string",
          description: "Search query for action=search.",
        },
        reason: {
          type: "string",
          description: "Close reason for action=close.",
        },
        force: {
          type: "boolean",
          description:
            "Force ownership/terminal-state override when supported.",
        },
        // pm-v68d: the schema-specific subcommand enum and add-type/add-status
        // properties migrated to the dedicated pm_schema tool. action=schema
        // still accepts them as passthrough, but agents should prefer pm_schema.
        subcommand: {
          type: "string",
          description:
            "Subcommand selector for actions that take one (for example telemetry, or schema — prefer the dedicated pm_schema tool for schema operations).",
        },
        options: {
          type: "object",
          description: "Underlying pm command options using camelCase keys.",
        },
        fullChangedFields: {
          type: "boolean",
          description:
            "For mutation actions, return the full changed_fields array instead of the default changed_field_count.",
        },
        idOnly: {
          type: "boolean",
          description:
            "For single-item mutation actions, return only id and status.",
        },
      },
      ["action"],
    ),
  },
  {
    name: "pm_context",
    description:
      "Return the agent-oriented project context snapshot. " +
      "Pass options.depth=brief|standard|deep|full (full = every section with no per-section row cap), " +
      "options.parent='<id>' to scope the snapshot to one item's subtree (the item plus all descendants), " +
      "options.fields='id,title,priority' to project focus rows to a field subset for low-token reads, " +
      "or options.section=['hierarchy','progress',...] to pick sections.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_next",
    description:
      "Recommend the next actionable work item: the single highest-priority READY item " +
      "(active status, no open blockers, no open children; completed containers surface only when no concrete leaf work is ready) plus the ranked ready and blocked queues. " +
      "The recommended item carries a rationale and each blocked item lists the open blockers gating it. " +
      "Pass options.parent='<id>' to scope to one subtree, options.limit=N to cap ready rows, " +
      "options.readyOnly=true to omit the blocked list, or filters (options.type/tag/priority/assignee/sprint/release). " +
      "The most token-efficient 'what should I do now?' read for agents.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_search",
    description:
      "Search pm items with keyword, semantic, or hybrid search. " +
      "Defaults to a compact projection for token efficiency. " +
      "Pass options.mode=keyword|semantic|hybrid, options.limit=N to cap hits, " +
      "options.status='all' for no lifecycle restriction, " +
      "options.fields='id,title,score' for a custom projection, or options.full=true for full item bodies (can be large). " +
      "The result echoes the applied filters and projection mode in query_summary.",
    inputSchema: objectSchema(
      {
        query: { type: "string" },
        options: { type: "object" },
        ...SEARCH_TOP_LEVEL_OPTION_PROPERTIES,
      },
      ["query"],
    ),
  },
  {
    name: "pm_list",
    description:
      "List pm items with status/type/tag/priority filters. Defaults to compact projection for token efficiency. " +
      "options.status accepts CSV (all,open,in_progress). " +
      "Pass options.compact=false or options.includeBody=true for full bodies/comments. " +
      "Pass options.brief=true for ultra-terse (id/status/type/title only). " +
      "Pass options.fields='id,title,priority' for custom projection. " +
      "Pass options.limit=N to cap row count. " +
      "The result echoes the applied filters and projection mode in query_summary.",
    inputSchema: objectSchema({
      options: { type: "object" },
      ...LIST_TOP_LEVEL_OPTION_PROPERTIES,
    }),
  },
  {
    name: "pm_get",
    description:
      "Read one pm item. Pass options.depth='brief' or options.fields='id,title,status' for low-token inspection.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        options: {
          type: "object",
          description:
            "Get options such as depth=brief|standard|deep|full or fields=id,title,status.",
        },
      },
      ["id"],
    ),
  },
  {
    name: "pm_create",
    description:
      "Create a pm item natively and write pm history. " +
      "Output is compact by default (changed_fields replaced with changed_field_count for token efficiency); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        fullChangedFields: {
          type: "boolean",
          description:
            "Return full changed_fields instead of changed_field_count.",
        },
        allowMissingParent: {
          type: "boolean",
          description:
            "Allow unresolved parent references and emit a validation warning.",
        },
        options: {
          type: "object",
          description: "Create options. title and description are required.",
        },
      },
      ["options"],
    ),
  },
  {
    name: "pm_copy",
    description:
      "Copy an existing pm item into a new id while resetting lifecycle fields. " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        ...COPY_TOP_LEVEL_OPTION_PROPERTIES,
        fullChangedFields: {
          type: "boolean",
          description:
            "Return full changed_fields instead of changed_field_count.",
        },
        idOnly: {
          type: "boolean",
          description: "Return only id and status.",
        },
        options: {
          type: "object",
          description:
            "Copy options such as title override, author, and message.",
        },
      },
      ["id"],
    ),
  },
  {
    name: "pm_focus",
    description:
      "Set, clear, or show the session focused item. When focused, pm_create defaults its parent to the focused item " +
      "(an explicit parent still overrides). Pass id to focus an item, options.clear=true to clear, or neither to show current focus.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        clear: {
          type: "boolean",
          description: "Clear the focused item (cannot be combined with id).",
        },
        options: {
          type: "object",
          description: "Focus options such as clear (boolean).",
        },
      },
      [],
    ),
  },
  {
    name: "pm_update",
    description:
      "Update pm item metadata/body/dependencies/log seeds natively. " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields delta.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        fullChangedFields: {
          type: "boolean",
          description:
            "Return full changed_fields instead of changed_field_count.",
        },
        options: { type: "object" },
      },
      ["id", "options"],
    ),
  },
  {
    name: "pm_append",
    description:
      "Append markdown text to a pm item body and write pm history. Useful for seeding evidence/log entries before close. " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        body: {
          type: "string",
          description:
            "Markdown text to append to the item body. Required here or as options.body.",
        },
        fullChangedFields: {
          type: "boolean",
          description:
            "Return full changed_fields instead of changed_field_count.",
        },
        options: {
          type: "object",
          description: "Append options such as body, author, and message.",
        },
      },
      ["id"],
    ),
  },
  {
    name: "pm_claim",
    description: "Claim a pm item.",
    inputSchema: objectSchema(
      { id: idSchema, force: { type: "boolean" }, options: { type: "object" } },
      ["id"],
    ),
  },
  {
    name: "pm_release",
    description: "Release a pm item claim.",
    inputSchema: objectSchema(
      { id: idSchema, force: { type: "boolean" }, options: { type: "object" } },
      ["id"],
    ),
  },
  {
    name: "pm_close",
    description:
      "Close a pm item with optional close reason and optional close validation (reason requirement follows governance settings). " +
      "Output is compact by default (changed_fields replaced with changed_field_count); pass fullChangedFields=true for the full changed_fields array.",
    inputSchema: objectSchema(
      {
        id: idSchema,
        reason: {
          type: "string",
          description:
            "Close reason text when provided or required by governance settings.",
        },
        duplicateOf: {
          type: "string",
          description:
            "Canonical item id when closing this item as a duplicate.",
        },
        fullChangedFields: {
          type: "boolean",
          description:
            "Return full changed_fields instead of changed_field_count.",
        },
        idOnly: { type: "boolean", description: "Return only id and status." },
        options: { type: "object" },
      },
      ["id"],
    ),
  },
  {
    name: "pm_comments",
    description:
      "List, add, edit, or delete comments on a pm item. Use options.add to append, options.edit=<1-based index> with replacement text to fix a comment, or options.delete=<1-based index> to remove one. " +
      "List calls default to the most recent 20 comments with total_count/has_more metadata for token efficiency. " +
      "Pass options.limit=N to choose a page size, options.limit=0 for summary-only metadata, or options.full=true for full history.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_files",
    description:
      "List, add, remove, or validate linked files for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_docs",
    description: "List, add, or remove linked docs for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_notes",
    description:
      "List or add structured notes on a pm item. Use options.add to append a note; omit it to list existing notes.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_learnings",
    description:
      "List or add learnings on a pm item. Use options.add to capture a learning/insight; omit it to list existing learnings.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_deps",
    description:
      "List, add, or remove dependencies for a pm item. Use options.add to declare a dependency and options.remove to drop one; omit both to list current dependencies.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_test",
    description: "List, add, remove, or run linked tests for a pm item.",
    inputSchema: objectSchema({ id: idSchema, options: { type: "object" } }, [
      "id",
    ]),
  },
  {
    name: "pm_validate",
    description: "Run pm validation checks.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_health",
    description:
      "Run pm health diagnostics. Pass options.brief=true for compact low-token details, options.skipIntegrity=true, options.skipDrift=true, options.skipVectors=true for a fast status-only check, or options.full=true for the complete deep check.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_contracts",
    description:
      "Inspect pm command, flag, schema, and availability contracts.",
    inputSchema: objectSchema({ options: { type: "object" } }),
  },
  {
    name: "pm_schema",
    description:
      "Inspect or modify the workspace item-type/status/field schema (pm schema). " +
      "subcommand selects the operation; name carries the item type name (show/add-type/remove-type), status id (show-status/add-status/remove-status), or field key (show-field/add-field/remove-field). " +
      "apply-preset adopts a domain type preset; add-type with infer=true derives types from title-prefix conventions. " +
      "Schema mutations write workspace config files, not item history.",
    inputSchema: objectSchema(
      {
        subcommand: {
          type: "string",
          enum: [
            "list",
            "show",
            "show-status",
            "add-type",
            "remove-type",
            "add-status",
            "remove-status",
            "add-field",
            "remove-field",
            "list-fields",
            "show-field",
            "apply-preset",
          ],
          description: "Schema subcommand to run.",
        },
        name: {
          type: "string",
          description:
            "Item type name (show/add-type/remove-type), status id (show-status/add-status/remove-status), or custom field key (show-field/add-field/remove-field). Required for those subcommands.",
        },
        description: {
          type: "string",
          description:
            "Custom item type, status, or field description for add-type/add-status/add-field.",
        },
        defaultStatus: {
          type: "string",
          description: "Default status for add-type.",
        },
        folder: { type: "string", description: "Storage folder for add-type." },
        alias: {
          type: "array",
          items: { type: "string" },
          description:
            "Aliases for add-type/add-status, or extra CLI flag aliases for add-field.",
        },
        role: {
          type: "array",
          items: { type: "string", enum: [...RUNTIME_STATUS_ROLE_VALUES] },
          description: `Lifecycle roles for add-status: ${RUNTIME_STATUS_ROLE_VALUES.join(", ")}.`,
        },
        order: {
          type: "number",
          description: "Display/sort order for add-status.",
        },
        fieldType: {
          type: "string",
          enum: ["string", "number", "boolean", "string_array"],
          description: "Value type for a custom field (add-field).",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          description:
            "Commands a custom field is wired onto (add-field): create, update, update_many, list, search, calendar, context.",
        },
        cliFlag: {
          type: "string",
          description:
            "Override the auto-derived CLI flag for a custom field (add-field).",
        },
        required: {
          type: "boolean",
          description: "Mark a custom field as always required (add-field).",
        },
        requiredOnCreate: {
          type: "boolean",
          description:
            "Mark a custom field as required at create time (add-field).",
        },
        allowUnset: {
          type: "boolean",
          description:
            "Whether a custom field may be cleared via --unset (add-field); defaults to true.",
        },
        requiredTypes: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict a custom field's requirement to specific item types (add-field).",
        },
        typePreset: {
          type: "string",
          enum: ["agile", "ops", "research"],
          description: "Domain type preset to adopt (apply-preset).",
        },
        infer: {
          type: "boolean",
          description:
            "Infer item types from title-prefix conventions (add-type); previews unless apply is true.",
        },
        minCount: {
          type: "number",
          description:
            "Minimum items sharing a prefix for add-type inference (default 10).",
        },
        apply: {
          type: "boolean",
          description:
            "Register inferred types (add-type infer); without it the call previews only.",
        },
        force: {
          type: "boolean",
          description:
            "Override removal guardrails for destructive schema changes when supported.",
        },
        options: {
          type: "object",
          description: "Additional schema options using camelCase keys.",
        },
      },
      ["subcommand"],
    ),
  },
  {
    name: "pm_profile",
    description:
      "List, show, apply, or lint project profiles (pm profile) — archetype bundles that stage item types, statuses, fields, per-type workflows, config knobs, create templates, and recommended packages. " +
      "subcommand selects the operation; name carries the profile name (agile, ops, research) for show/apply/lint. " +
      "apply stages every dimension idempotently; dryRun previews the diff without writing; lint reports author-time consistency findings (graded error/warning) without touching the tracker. Profile staging writes workspace config/schema files, not item history.",
    inputSchema: objectSchema(
      {
        subcommand: {
          type: "string",
          enum: ["list", "show", "apply", "lint"],
          description: "Profile subcommand to run.",
        },
        name: {
          type: "string",
          description:
            "Profile name for show/apply/lint. Required for those subcommands. Built-ins are agile, ops, and research; an active extension can contribute additional archetype names that resolve here too.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Preview the apply diff without writing any files (apply).",
        },
        author: { type: "string", description: "Mutation author for apply." },
        force: {
          type: "boolean",
          description: "Force ownership/lock override for apply.",
        },
        options: {
          type: "object",
          description: "Additional profile options using camelCase keys.",
        },
      },
      ["subcommand"],
    ),
  },
  {
    name: "pm_config",
    description:
      "Read or write pm workspace configuration (pm config). " +
      "configAction selects get/set/list/export; key/value address a single setting for get/set. " +
      "scope chooses the project (default) or global settings file.",
    inputSchema: objectSchema(
      {
        configAction: {
          type: "string",
          enum: ["get", "set", "list", "export"],
          description:
            "Config operation to perform. get/set require key; list/export dump the resolved settings surface.",
        },
        key: {
          type: "string",
          description:
            "Settings key for get/set, for example governance-require-close-reason, telemetry-tracking, or a nested leaf such as search_provider (dash and underscore variants accepted; configAction=get without a key lists supported keys in the error).",
        },
        value: {
          type: "string",
          description: "New value for configAction=set.",
        },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "Settings scope to read or write. Defaults to project.",
        },
        options: {
          type: "object",
          description:
            "Additional config options such as criterion, clearCriteria, format, or policy.",
        },
      },
      ["configAction"],
    ),
  },
  {
    name: "pm_plan",
    description:
      "Run agent-optimized Plan workflows. options.subcommand selects: create|show|add-step|update-step|complete-step|block-step|reorder-step|remove-step|link|unlink|decision|discovery|validation|resume|approve|materialize. Provide id for all non-create subcommands; provide stepRef for step lifecycle subcommands. Plans store agent-readable steps with dependencies, decisions, discoveries, validation, and resume context.",
    inputSchema: objectSchema({
      id: {
        type: "string",
        description: "Plan id (required for all subcommands except create).",
      },
      stepRef: {
        type: "string",
        description: "Step id or order for step lifecycle subcommands.",
      },
      reorderTo: { type: "number", description: "New order for reorder-step." },
      options: {
        type: "object",
        description:
          "Plan options including subcommand, stepRef, stepStatus, link, depth, etc.",
      },
    }),
  },
];

/** Stable projection of one MCP tool definition for the contract golden file (pm-4os2): tool name, description, required top-level fields, and the full inputSchema shape. Any drift (typo'd property, dropped required field, changed TOOL_SCHEMA_BASE) shows up in `pnpm contracts:check`. */
export interface McpToolContract {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports description for this contract. */
  description: string;
  /** Value that configures or reports required for this contract. */
  required: string[];
  /** Value that configures or reports input schema for this contract. */
  input_schema: Record<string, unknown>;
}

/** Implements build mcp tool contracts for the public runtime surface of this module. */
export function buildMcpToolContracts(): McpToolContract[] {
  return TOOLS.map((tool) => {
    const schemaRequired = tool.inputSchema["required"];
    const required = Array.isArray(schemaRequired)
      ? schemaRequired
          .map((entry) => String(entry))
          .sort((left, right) => left.localeCompare(right))
      : [];
    return {
      name: tool.name,
      description: tool.description,
      required,
      input_schema: tool.inputSchema,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
