import { describe, expect, it } from "vitest";
import type { ToolOptionFlagContract } from "../../../src/sdk/cli-contracts.js";
import {
  CREATE_FLAG_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
} from "../../../src/sdk/cli-contracts/flag-contracts.js";
import {
  TOOL_AGGREGATE_OPTION_CONTRACTS,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_LIST_FILTER_OPTION_CONTRACTS,
  TOOL_SEARCH_FILTER_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  verifyToolOptionCliParity,
} from "../../../src/sdk/cli-contracts/tool-option-contracts.js";

/**
 * Finds a named option contract or fails the regression test with a focused error.
 */
function requireOptionContract(
  contracts: readonly ToolOptionFlagContract[],
  param: string,
): ToolOptionFlagContract {
  const contract = contracts.find((entry) => entry.param === param);
  if (!contract) {
    throw new Error(`Expected option contract for ${param}.`);
  }
  return contract;
}

describe("tool option contract composition", () => {
  it("does not share option objects between exported contract arrays", () => {
    const listStatus = requireOptionContract(TOOL_LIST_FILTER_OPTION_CONTRACTS, "status");
    const searchStatus = requireOptionContract(TOOL_SEARCH_FILTER_OPTION_CONTRACTS, "status");
    const aggregateStatus = requireOptionContract(TOOL_AGGREGATE_OPTION_CONTRACTS, "status");
    const updateManyStatus = requireOptionContract(TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS, "filterStatus");
    const closeManyStatus = requireOptionContract(TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS, "filterStatus");

    expect(listStatus).not.toBe(searchStatus);
    expect(listStatus).not.toBe(aggregateStatus);
    expect(updateManyStatus).not.toBe(closeManyStatus);
  });

  it("maps every create and update parameter to an executable CLI spelling", () => {
    expect(
      verifyToolOptionCliParity(
        TOOL_CREATE_OPTION_CONTRACTS,
        CREATE_FLAG_CONTRACTS,
      ),
    ).toMatchObject({ ok: true, parameter_count: 43, findings: [] });
    expect(
      verifyToolOptionCliParity(
        TOOL_UPDATE_OPTION_CONTRACTS,
        UPDATE_FLAG_CONTRACTS,
      ),
    ).toMatchObject({ ok: true, parameter_count: 48, findings: [] });
  });

  it("fails closed for a missing CLI flag and a missing parameter alias", () => {
    expect(
      verifyToolOptionCliParity(
        [
          { param: "linkedFile", flag: "--file" },
          { param: "missing", flag: "--missing" },
        ],
        [{ flag: "--file" }],
      ).findings,
    ).toEqual([
      {
        code: "missing_parameter_alias",
        parameter: "linkedFile",
        flag: "--file",
        parameter_flag: "--linked-file",
      },
      {
        code: "missing_cli_flag",
        parameter: "missing",
        flag: "--missing",
        parameter_flag: "--missing",
      },
    ]);
  });
});
