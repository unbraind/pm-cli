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
  return createOutputOmissionReceipt(
    declaredGroups,
    new Set(includedNames),
  );
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
      groups.flatMap(({ name }) =>
        result[name] === undefined ? [] : [name],
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
    new Set(
      result.projection.mode === "full" ? ["full_item_fields"] : [],
    ),
  );
}

function resolveHealthReceipt(
  result: Record<string, unknown>,
): OutputOmissionReceipt | undefined {
  if (!isRecord(result.projection)) return createOutputOmissionReceipt([]);
  if (typeof result.projection.mode !== "string") return undefined;
  return createOutputOmissionReceipt(
    [{ name: "full_check_details", restore_with: "--full" }],
    new Set(
      result.projection.mode === "full" ? ["full_check_details"] : [],
    ),
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
  if (
    command === undefined ||
    !isRecord(result) ||
    isRecord(result.omission_receipt)
  ) {
    return result;
  }

  const receipt = resolveOutputOmissionReceipt(command, result);
  return receipt === undefined
    ? result
    : { ...result, omission_receipt: receipt };
}
