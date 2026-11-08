/**
 * @module sdk/generated/error-code-catalog-rows
 *
 * Compact generated error-code catalog rows and their lossless expansion into
 * full contracts. The generator omits every field that is derivable, so the
 * catalog ships once per build output without repeating shared guidance.
 */
import {
  PM_ERROR_CODE_EXIT_CLASS_CONTRACTS,
  type PmErrorCodeClass,
  type PmErrorCodeContract,
} from "../error-code-catalog.js";

/** Recovery guidance shared by every generated catalog row. */
const GENERATED_ERROR_CODE_RECOVERY =
  "Inspect the structured error guidance, then retry the suggested command when one is present.";

const CLASS_BY_EXIT_CODE: ReadonlyMap<number, PmErrorCodeClass> = new Map(
  PM_ERROR_CODE_EXIT_CLASS_CONTRACTS.map(
    (contract) => [contract.exit_code, contract.class] as const,
  ),
);

/**
 * One generated catalog row with every derivable field omitted: `meaning`
 * follows from the code, `class` from the exit code, `recovery` is shared,
 * `stability` is provisional unless `stable` is set, and `emitting_commands`
 * defaults to every command. `canonical_code`, `aliases` and `owned_states`
 * default inside definePmErrorCodeCatalog (pm-998juj).
 */
export interface PmErrorCodeCatalogRow {
  /** Stable snake_case identifier. */
  code: string;
  /** Process exit code emitted by the CLI transport. */
  exit_code: PmErrorCodeContract["exit_code"];
  /** Subsystems that can emit the code. */
  sources: string[];
  /** Present when the code is in the reviewed stability ledger. */
  stable?: true;
  /** CLI command roots, when narrower than every command. */
  emitting_commands?: string[];
  /** Canonical machine identifier, when the code is an alias. */
  canonical_code?: string;
  /** Compatibility spellings that resolve to this code. */
  aliases?: string[];
  /** Observable states this code claims. */
  owned_states?: PmErrorCodeContract["owned_states"];
}

/**
 * Expand compact generated rows into the full contracts that
 * definePmErrorCodeCatalog validates, keeping the original key order so every
 * serialized catalog projection stays byte-identical.
 */
export function expandPmErrorCodeCatalogRows(
  rows: readonly PmErrorCodeCatalogRow[],
): PmErrorCodeContract[] {
  return rows.map((row) => {
    const meaning = `${row.code.replaceAll("_", " ")} condition.`;
    const contract: PmErrorCodeContract = {
      code: row.code,
      meaning: `${meaning.charAt(0).toUpperCase()}${meaning.slice(1)}`,
      stability: row.stable ? "stable" : "provisional",
      exit_code: row.exit_code,
      class: CLASS_BY_EXIT_CODE.get(row.exit_code) as PmErrorCodeClass,
      recovery: GENERATED_ERROR_CODE_RECOVERY,
      sources: row.sources,
      emitting_commands: row.emitting_commands ?? ["*"],
      canonical_code: row.canonical_code ?? row.code,
      aliases: row.aliases ?? [],
    };
    if (row.owned_states) contract.owned_states = row.owned_states;
    return contract;
  });
}
