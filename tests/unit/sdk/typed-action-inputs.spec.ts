import { describe, expect, it } from "vitest";
import {
  CLOSE_ACTION_OPTION_KEYS,
  PM_TOOL_ACTION_PARAMETER_CONTRACTS,
  TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACT_SOURCE,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_CREATE_OPTION_CONTRACT_SOURCE,
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACT_SOURCE,
  TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACT_SOURCE,
  TOOL_UPDATE_OPTION_CONTRACTS,
} from "../../../src/sdk/cli-contracts.js";

/**
 * Runtime parity for the typed per-action SDK inputs (GH-601 / pm-x29o): the
 * compile-time option types derive from the const-asserted `*_SOURCE` tuples,
 * while the executable contract tables are runtime clones of the same tuples.
 * These assertions pin the two representations together so the typed surface
 * can never drift from what the CLI/MCP layer actually accepts.
 */
describe("typed action input contract sources", () => {
  it("keeps the runtime contract tables identical to their const-asserted sources", () => {
    expect(TOOL_CREATE_OPTION_CONTRACTS).toEqual([
      ...TOOL_CREATE_OPTION_CONTRACT_SOURCE,
    ]);
    expect(TOOL_UPDATE_OPTION_CONTRACTS).toEqual([
      ...TOOL_UPDATE_OPTION_CONTRACT_SOURCE,
    ]);
    expect(TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS).toEqual([
      ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACT_SOURCE,
    ]);
    expect(TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS).toEqual([
      ...TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACT_SOURCE,
    ]);
    expect(TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS).toEqual([
      ...TOOL_BULK_MUTATION_FILTER_OPTION_CONTRACT_SOURCE,
    ]);
  });

  it("clones (not aliases) the exported runtime tables so entries stay mutation-isolated", () => {
    expect(TOOL_CREATE_OPTION_CONTRACTS[0]).not.toBe(
      TOOL_CREATE_OPTION_CONTRACT_SOURCE[0],
    );
    expect(TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS[0]).not.toBe(
      TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS[0],
    );
  });

  it("keeps the strict close schema's optional keys aligned with CLOSE_ACTION_OPTION_KEYS", () => {
    const closeContract = PM_TOOL_ACTION_PARAMETER_CONTRACTS.close;
    expect(closeContract).toBeDefined();
    for (const key of CLOSE_ACTION_OPTION_KEYS) {
      expect(closeContract.optional).toContain(key);
    }
  });
});
