/**
 * @module sdk/output-projection
 *
 * Declares machine-readable field-group omissions for bounded command results.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

/** One field group that a richer output projection can restore. */
export interface OutputProjectionFieldGroup {
  /** Stable machine-readable field-group name. */
  name: string;
  /** Exact CLI flag or flag/value pair that restores the group. */
  restore_with: string;
}

/** Bounded disclosure that distinguishes complete output from silent omission. */
export interface OutputOmissionReceipt {
  /** Whether the active projection withheld at least one declared field group. */
  has_omissions: boolean;
  /** Constant-size count of withheld field groups. */
  omitted_field_group_count: number;
  /** Withheld groups and the exact opt-in that restores each one. */
  omitted_field_groups: OutputProjectionFieldGroup[];
}

/** Self-describing projection metadata that built-ins and extensions can use to derive receipts without command-specific code. */
export interface OutputProjectionDeclaration {
  /** Active projection name. */
  mode: string;
  /** Every optional field group supported by this result shape. */
  declared_field_groups: OutputProjectionFieldGroup[];
  /** Names of declared groups present in this result. */
  included_field_groups: string[];
}

const MATERIAL_FIELD_GROUPS_BY_RESULT = new WeakMap<object, ReadonlySet<string>>();

/** Register non-serialized materiality evidence used to keep omission receipts token-proportional. */
export function registerOutputMaterialFieldGroups(
  result: object,
  fieldGroups: readonly string[],
): void {
  MATERIAL_FIELD_GROUPS_BY_RESULT.set(result, new Set(fieldGroups));
}

/** Machine-readable location and field-projection support for read-result rows. */
export interface ReadRowContract {
  /** Canonical read command that owns the result. */
  command: string;
  /** Whether the result exposes iterable collections or intentionally has none. */
  row_kind: "collection" | "none";
  /** Dot-delimited paths to array or object-map collections containing iterable result rows. */
  row_keys: string[];
  /** Optional nested collections that are independently resumable without redefining primary result rows. */
  continuation_row_keys?: string[];
  /** Whether the command accepts an explicit row-field projection. */
  fields: "supported" | "unsupported";
  /** Universal jq expression that iterates every declared collection path. */
  jq_selector?: string;
  /** TOON row encoding selected whenever every row is a flat object with one shared key set. */
  toon_encoding?: "tabular_when_uniform";
}

/** Universal selector for results carrying a {@link ReadRowContract}. */
export const PM_READ_ROW_JQ_SELECTOR =
  '.row_contract.row_keys[] as $key | getpath($key | split(".")) | if type == "array" then .[] else if type == "object" then to_entries[] else empty end end';

/** Static row declarations shared by CLI, SDK, MCP, and package consumers. */
export const PM_READ_ROW_CONTRACTS = {
  context: { row_keys: ["high_level", "low_level"], fields: "supported" },
  get: { row_keys: ["children"], fields: "supported" },
  list: { row_keys: ["items"], fields: "supported" },
  next: {
    row_keys: [
      "recommended",
      "ready",
      "decision_needed",
      "blocked",
      "held_by_others",
    ],
    fields: "unsupported",
  },
  search: { row_keys: ["items"], fields: "supported" },
  activity: {
    row_keys: [
      "activity_digest",
      "compact_activity",
      "provenance_activity",
      "activity",
    ],
    fields: "unsupported",
  },
  history: {
    row_keys: ["compact_history", "provenance_history", "history"],
    fields: "unsupported",
  },
  deps: {
    row_keys: ["graph.nodes", "graph.edges", "context.nodes", "context.edges"],
    fields: "unsupported",
  },
  health: { row_keys: ["checks"], fields: "unsupported" },
  aggregate: { row_keys: ["groups"], fields: "unsupported" },
  duplicates: { row_keys: ["clusters"], fields: "unsupported" },
  stats: { row_keys: ["by_type", "by_status"], fields: "unsupported" },
  comments: { row_keys: ["comments"], fields: "unsupported" },
  notes: { row_keys: ["notes"], fields: "unsupported" },
  learnings: { row_keys: ["learnings"], fields: "unsupported" },
  files: { row_keys: ["files"], fields: "unsupported" },
  docs: { row_keys: ["docs"], fields: "unsupported" },
  validate: { row_keys: ["checks", "warnings"], fields: "unsupported" },
  contracts: {
    row_keys: ["command_summaries", "commands"],
    fields: "unsupported",
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      row_keys: readonly string[];
      fields: ReadRowContract["fields"];
    }
  >
>;

/** Contract for a command whose output modes expose mutually exclusive row shapes. */
export interface ModePairedOutputProjectionContract {
  /** Stable command name. */
  command: string;
  /** Mode that contains the complete authoritative row shape. */
  complete_mode: string;
  /** Field groups withheld by each non-complete mode. */
  omissions_by_mode: Readonly<
    Record<string, readonly OutputProjectionFieldGroup[]>
  >;
}

/** Shared activity/history contract used by CLI, SDK, MCP, and conformance tests. */
export const PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS = [
  {
    command: "activity",
    complete_mode: "full",
    omissions_by_mode: {
      digest: [
        {
          name: "event_rows",
          restore_with: "--raw",
        },
      ],
      compact: [
        {
          name: "provenance",
          restore_with: "--full",
        },
      ],
      provenance: [
        {
          name: "patch_and_hashes",
          restore_with: "--full",
        },
      ],
    },
  },
  {
    command: "history",
    complete_mode: "full",
    omissions_by_mode: {
      compact: [
        {
          name: "raw_history",
          restore_with: "--full",
        },
      ],
      provenance: [
        {
          name: "patch_and_hashes",
          restore_with: "--full",
        },
      ],
    },
  },
] as const satisfies readonly ModePairedOutputProjectionContract[];

/** Reject a compact projection and its explicit full restoration when callers request both. */
export function assertProjectionModeChoice(
  compactRequested: boolean,
  fullRequested: boolean,
  compactFlag: string,
): void {
  if (compactRequested && fullRequested) {
    throw new PmCliError(
      `${compactFlag} cannot be combined with --full`,
      EXIT_CODE.USAGE,
    );
  }
}

/** Build an explicit constant-size receipt from declared and included groups. */
export function createOutputOmissionReceipt(
  declaredGroups: readonly OutputProjectionFieldGroup[],
  includedGroupNames: ReadonlySet<string> = new Set(),
): OutputOmissionReceipt {
  const omittedFieldGroups = declaredGroups
    .filter((group) => !includedGroupNames.has(group.name))
    .map((group) => ({ ...group }));
  return {
    has_omissions: omittedFieldGroups.length > 0,
    omitted_field_group_count: omittedFieldGroups.length,
    omitted_field_groups: omittedFieldGroups,
  };
}

/** Resolve the receipt declared for one mode-paired command result. */
export function resolveModePairedOutputOmissionReceipt(
  command: string,
  mode: string,
): OutputOmissionReceipt {
  const contract = PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS.find(
    (candidate) => candidate.command === command,
  );
  if (contract === undefined) {
    throw new TypeError(`Unknown mode-paired output command: ${command}`);
  }
  if (mode === contract.complete_mode) {
    return createOutputOmissionReceipt([]);
  }
  const groups = (
    contract.omissions_by_mode as Readonly<
      Record<string, readonly OutputProjectionFieldGroup[]>
    >
  )[mode];
  if (groups === undefined) {
    throw new TypeError(`Unknown ${command} output mode: ${mode}`);
  }
  return createOutputOmissionReceipt(groups);
}

const CONTEXT_FIELD_GROUPS = [
  { name: "hierarchy", restore_with: "--depth standard" },
  { name: "activity", restore_with: "--depth standard" },
  { name: "progress", restore_with: "--depth standard" },
  { name: "blockers", restore_with: "--depth standard" },
  { name: "recently_created", restore_with: "--depth standard" },
  { name: "unparented", restore_with: "--depth standard" },
  { name: "files", restore_with: "--depth deep" },
  { name: "workload", restore_with: "--depth standard" },
  { name: "staleness", restore_with: "--depth deep" },
  { name: "tests", restore_with: "--depth deep" },
  { name: "workspace_memory", restore_with: "--depth deep" },
] as const satisfies readonly OutputProjectionFieldGroup[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const READ_ROW_TOON_ENCODINGS = new Set<unknown>([
  undefined,
  "tabular_when_uniform",
]);
const READ_ROW_KINDS = new Set<unknown>(["collection", "none"]);
const READ_ROW_FIELD_MODES = new Set<unknown>(["supported", "unsupported"]);

function isUniqueNonEmptyStringArray(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (entry): entry is string =>
        typeof entry === "string" && entry.length > 0,
    ) &&
    new Set(value).size === value.length
  );
}

/** Return whether an unknown value is a structurally valid row declaration. */
export function isReadRowContract(value: unknown): value is ReadRowContract {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    READ_ROW_KINDS.has(value.row_kind) &&
    isUniqueNonEmptyStringArray(value.row_keys, true) &&
    (value.continuation_row_keys === undefined ||
      isUniqueNonEmptyStringArray(value.continuation_row_keys, false)) &&
    READ_ROW_FIELD_MODES.has(value.fields) &&
    READ_ROW_TOON_ENCODINGS.has(value.toon_encoding) &&
    (value.row_kind === "collection"
      ? value.row_keys.length > 0 &&
        typeof value.jq_selector === "string" &&
        value.jq_selector.trim().length > 0
      : value.row_keys.length === 0 && value.jq_selector === undefined)
  );
}

const GRAPH_ROW_KEYS: Readonly<Record<string, readonly string[]>> = {
  ancestors: ["ids"],
  descendants: ["ids"],
  predecessors: ["ids"],
  successors: ["ids"],
  paths: ["paths"],
  impact: ["affected"],
  audit: ["findings"],
  communities: ["communities"],
  redundancy: ["redundant"],
  dominators: ["bottlenecks"],
  slack: ["rows"],
  centrality: ["rows"],
  articulation: ["articulation_points", "bridges"],
  plan: ["steps"],
};

const READ_RESULT_SENTINEL_KEYS: Readonly<Record<string, readonly string[]>> = {
  context: ["sections_included", "high_level", "low_level"],
  get: ["item"],
  list: ["items", "projection"],
  next: [
    "recommended",
    "ready",
    "decision_needed",
    "blocked",
    "held_by_others",
  ],
  search: ["items", "projection"],
  activity: [
    "activity_digest",
    "compact_activity",
    "provenance_activity",
    "activity",
  ],
  history: ["compact_history", "provenance_history", "history"],
  deps: ["tree", "graph", "projection"],
  health: ["checks"],
  aggregate: ["groups"],
  duplicates: ["clusters"],
  stats: ["totals", "by_type", "by_status"],
  comments: ["comments"],
  notes: ["notes"],
  learnings: ["learnings"],
  files: ["files"],
  docs: ["docs"],
  validate: ["checks", "warnings"],
  contracts: ["command_summaries", "commands", "selected"],
};

/** Resolve one command's canonical row collection declaration. */
export function resolveReadRowContract(
  command: string,
  result: Record<string, unknown>,
): ReadRowContract | undefined {
  const rawRootCommand = command.trim().toLowerCase().split(/\s+/u, 1)[0]!;
  const rootCommand = rawRootCommand?.startsWith("list-")
    ? "list"
    : rawRootCommand;
  if (rootCommand === "graph") {
    const subcommand =
      typeof result.subcommand === "string" ? result.subcommand : "";
    if (subcommand.length === 0) return undefined;
    const rowKeys = GRAPH_ROW_KEYS[subcommand];
    if (rowKeys === undefined) return undefined;
    const activeRowKeys = rowKeys.filter(
      (key) => Array.isArray(result[key]) || isRecord(result[key]),
    );
    return {
      command: "graph",
      row_kind: activeRowKeys.length > 0 ? "collection" : "none",
      row_keys: activeRowKeys,
      fields: "unsupported",
      ...(activeRowKeys.length > 0
        ? { jq_selector: PM_READ_ROW_JQ_SELECTOR }
        : {}),
      toon_encoding: "tabular_when_uniform",
    };
  }
  const declaration = (
    PM_READ_ROW_CONTRACTS as Readonly<
      Record<
        string,
        {
          row_keys: readonly string[];
          fields: ReadRowContract["fields"];
        }
      >
    >
  )[rootCommand];
  const sentinelKeys = READ_RESULT_SENTINEL_KEYS[rootCommand];
  return declaration === undefined ||
    sentinelKeys === undefined ||
    !sentinelKeys.some((key) => Object.hasOwn(result, key))
    ? undefined
    : (() => {
        const rowKeys = declaration.row_keys.filter((key) => {
          const value = key
            .split(".")
            .reduce<unknown>(
              (current, segment) =>
                isRecord(current) ? current[segment] : undefined,
              result,
            );
          return Array.isArray(value) || isRecord(value);
        });
        return {
          command: rootCommand,
          row_kind: rowKeys.length > 0 ? "collection" : "none",
          row_keys: rowKeys,
          fields: declaration.fields,
          ...(rowKeys.length > 0
            ? { jq_selector: PM_READ_ROW_JQ_SELECTOR }
            : {}),
          toon_encoding: "tabular_when_uniform",
        };
      })();
}

function resolveDeclaredProjectionReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!isRecord(result.projection)) return undefined;
  if (
    typeof result.projection.mode !== "string" ||
    result.projection.mode.trim().length === 0
  ) {
    return undefined;
  }
  const declared = result.projection.declared_field_groups;
  const included = result.projection.included_field_groups;
  if (!Array.isArray(declared) || !Array.isArray(included)) return undefined;
  const declaredGroups = declared.filter(
    (entry): entry is OutputProjectionFieldGroup =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      entry.name.trim().length > 0 &&
      typeof entry.restore_with === "string" &&
      entry.restore_with.trim().length > 0,
  );
  const includedNames = included.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (
    declaredGroups.length !== declared.length ||
    includedNames.length !== included.length
  ) {
    return undefined;
  }
  const declaredNames = new Set(declaredGroups.map((group) => group.name));
  if (
    declaredNames.size !== declaredGroups.length ||
    new Set(includedNames).size !== includedNames.length ||
    includedNames.some((name) => !declaredNames.has(name))
  ) {
    return undefined;
  }
  return createOutputOmissionReceipt(declaredGroups, new Set(includedNames));
}

function resolveContextReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!Array.isArray(result.sections_included)) return undefined;
  return createOutputOmissionReceipt(
    CONTEXT_FIELD_GROUPS,
    new Set(
      result.sections_included.filter(
        (section): section is string => typeof section === "string",
      ),
    ),
  );
}

function resolveGetReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!isRecord(result.item)) return undefined;
  const item = result.item;
  const itemGroups = [
    "comments",
    "notes",
    "learnings",
    "files",
    "tests",
    "docs",
    "reminders",
    "events",
  ];
  const resultGroups = [
    "body",
    "children",
    "claim_state",
    "linked",
    "schedule",
  ];
  const materialGroups = MATERIAL_FIELD_GROUPS_BY_RESULT.get(result);
  const ownerFor = (name: string): Record<string, unknown> =>
    itemGroups.includes(name) || name === "body" ? item : result;
  const groups = ["body", ...itemGroups, ...resultGroups.slice(1)]
    .filter((name) =>
      materialGroups === undefined ||
      materialGroups.has(name) ||
      Object.hasOwn(ownerFor(name), name),
    )
    .map((name) => ({
      name,
      restore_with: `--fields ${name}`,
    }));
  return createOutputOmissionReceipt(
    groups,
    new Set(
      groups.flatMap(({ name }) =>
        !Object.hasOwn(ownerFor(name), name)
          ? []
          : [name],
      ),
    ),
  );
}

function resolveListOrSearchReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!isRecord(result.projection)) return undefined;
  return createOutputOmissionReceipt(
    [{ name: "full_item_fields", restore_with: "--full" }],
    new Set(result.projection.mode === "full" ? ["full_item_fields"] : []),
  );
}

function resolveHealthReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!isRecord(result.projection)) return createOutputOmissionReceipt([]);
  if (typeof result.projection.mode !== "string") return undefined;
  return createOutputOmissionReceipt(
    [{ name: "full_check_details", restore_with: "--full" }],
    new Set(result.projection.mode === "full" ? ["full_check_details"] : []),
  );
}

function resolveContractsReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (
    !isRecord(result.selected) ||
    typeof result.selected.summary !== "boolean"
  ) {
    return undefined;
  }
  return createOutputOmissionReceipt(
    [{ name: "full_contract_catalog", restore_with: "--full" }],
    new Set(result.selected.summary ? [] : ["full_contract_catalog"]),
  );
}

/** Derive a receipt from one built-in read result without changing its rows. */
export function resolveOutputOmissionReceipt(
  command: string,
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  const declaredReceipt = resolveDeclaredProjectionReceipt(result);
  if (declaredReceipt !== undefined) return declaredReceipt;
  const [rootCommand] = command.split(/\s+/u, 1);
  if (rootCommand === "context") return resolveContextReceipt(result);
  if (rootCommand === "get") return resolveGetReceipt(result);
  if (rootCommand === "list" || rootCommand.startsWith("list-")) {
    return resolveListOrSearchReceipt(result);
  }
  if (rootCommand === "search") {
    return (
      resolveListOrSearchReceipt(result) ??
      createOutputOmissionReceipt([
        { name: "projection_metadata", restore_with: "--full" },
      ])
    );
  }
  if (rootCommand === "health") return resolveHealthReceipt(result);
  if (rootCommand === "contracts") return resolveContractsReceipt(result);
  return undefined;
}

/**
 * Attach a receipt to built-in read results that already expose enough
 * projection state to derive omissions without repeating command logic.
 */
export function attachOutputOmissionReceipt(
  command: string | undefined,
  result: unknown,
): unknown {
  if (command === undefined || !isRecord(result)) {
    return result;
  }

  const receipt = resolveOutputOmissionReceipt(command, result);
  const declaredRowContract = result.row_contract;
  const rowContract = isReadRowContract(declaredRowContract)
    ? declaredRowContract
    : resolveReadRowContract(command, result);
  const disclosedResult =
    rowContract !== undefined
      ? { ...result, row_contract: rowContract }
      : Object.hasOwn(result, "row_contract")
        ? Object.fromEntries(
            Object.entries(result).filter(([key]) => key !== "row_contract"),
          )
        : result;
  if (isRecord(disclosedResult.omission_receipt)) return disclosedResult;
  return receipt === undefined
    ? disclosedResult
    : { ...disclosedResult, omission_receipt: receipt };
}
