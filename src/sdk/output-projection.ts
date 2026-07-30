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

/** Machine-readable location and field-projection support for read-result rows. */
export interface ReadRowContract {
  /** Canonical read command that owns the result. */
  command: string;
  /** Top-level array keys containing iterable result rows. */
  row_keys: string[];
  /** Whether the command accepts an explicit row-field projection. */
  fields: "supported" | "unsupported";
  /** Universal jq expression that iterates every declared top-level row. */
  jq_selector: string;
}

/** Universal selector for results carrying a {@link ReadRowContract}. */
export const PM_READ_ROW_JQ_SELECTOR =
  ".row_contract.row_keys[] as $key | .[$key][]?";

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
    row_keys: ["compact_activity", "activity"],
    fields: "unsupported",
  },
  history: { row_keys: ["compact_history", "history"], fields: "unsupported" },
  deps: { row_keys: [], fields: "unsupported" },
  health: { row_keys: ["checks"], fields: "unsupported" },
  aggregate: { row_keys: ["groups"], fields: "unsupported" },
  duplicates: { row_keys: ["clusters"], fields: "unsupported" },
  stats: { row_keys: [], fields: "unsupported" },
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
      compact: [
        {
          name: "provenance",
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
  activity: ["compact_activity", "activity"],
  history: ["compact_history", "history"],
  deps: ["tree", "graph", "projection"],
  health: ["checks"],
  aggregate: ["groups"],
  duplicates: ["clusters"],
  stats: ["totals", "by_type", "by_status"],
};

/** Resolve one command's canonical top-level row collection declaration. */
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
    return {
      command: "graph",
      row_keys: [...(GRAPH_ROW_KEYS[subcommand] ?? [])],
      fields: "unsupported",
      jq_selector: PM_READ_ROW_JQ_SELECTOR,
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
    : {
        command: rootCommand,
        row_keys: declaration.row_keys.filter((key) =>
          Array.isArray(result[key]),
        ),
        fields: declaration.fields,
        jq_selector: PM_READ_ROW_JQ_SELECTOR,
      };
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
  const groups = ["children", "claim_state", "linked"].map((name) => ({
    name,
    restore_with: `--fields ${name}`,
  }));
  return createOutputOmissionReceipt(
    groups,
    new Set(
      groups.flatMap(({ name }) => (result[name] === undefined ? [] : [name])),
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

  const rowContract = isRecord(result.row_contract)
    ? undefined
    : resolveReadRowContract(command, result);
  const disclosedResult =
    rowContract === undefined
      ? result
      : { ...result, row_contract: rowContract };
  if (isRecord(disclosedResult.omission_receipt)) return disclosedResult;
  const receipt = resolveOutputOmissionReceipt(command, disclosedResult);
  return receipt === undefined
    ? disclosedResult
    : { ...disclosedResult, omission_receipt: receipt };
}
