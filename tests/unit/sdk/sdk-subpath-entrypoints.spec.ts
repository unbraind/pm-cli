import { describe, expect, it } from "vitest";
import * as sdk from "@unbrained/pm-cli/sdk";
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import {
  PM_TOOL_ACTIONS,
  parseMutationReceipt,
} from "@unbrained/pm-cli/sdk/contracts";
import {
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  PmClient,
  applyReadOutputDimensions,
  isReadOutputBudgetExceeded,
} from "@unbrained/pm-cli/sdk/core";
import {
  AssuranceMutationRefusalError,
  runReindex,
  runUpgrade,
  runValidate,
  validateGateDefinition,
} from "@unbrained/pm-cli/sdk/governance";
import { runGraph } from "@unbrained/pm-cli/sdk/graph";
import { mergeItemDocuments } from "@unbrained/pm-cli/sdk/merge";
import {
  runActivity,
  runAggregate,
  runCalendar,
  runContext,
  runGet,
  runHistory,
  runList,
  runNext,
  runSearch,
} from "@unbrained/pm-cli/sdk/query";
import { assertExtensionBlueprint } from "@unbrained/pm-cli/sdk/testing";

describe("public SDK capability entrypoints", () => {
  it("resolve independently through the package export map", () => {
    expect(defineExtension).toBeTypeOf("function");
    expect(PM_TOOL_ACTIONS).toContain("create");
    expect(
      parseMutationReceipt({
        id: "pm-demo",
        status: "open",
        changed_field_count: 1,
      }),
    ).toMatchObject({ id: "pm-demo", changedFieldCount: 1 });
    expect(PmClient).toBeTypeOf("function");
    expect(PM_READ_OUTPUT_SURFACE_CONTRACTS).toHaveLength(22);
    expect(
      isReadOutputBudgetExceeded(
        applyReadOutputDimensions(
          "stats",
          { outputBudget: 256 },
          Object.fromEntries(
            Array.from({ length: 1_000 }, (_, index) => [
              `field_${index}`,
              "x".repeat(100),
            ]),
          ),
        ),
      ),
    ).toBe(true);
    expect(runValidate).toBeTypeOf("function");
    expect(AssuranceMutationRefusalError).toBeTypeOf("function");
    expect(sdk.AssuranceMutationRefusalError).toBeTypeOf("function");
    expect(() =>
      validateGateDefinition({
        id: "quality",
        assertion_ids: ["quality-assertion"],
      } as never),
    ).toThrow(
      AssuranceMutationRefusalError,
    );
    expect(runReindex).toBeTypeOf("function");
    expect(runUpgrade).toBeTypeOf("function");
    expect(runGraph).toBeTypeOf("function");
    expect(mergeItemDocuments).toBeTypeOf("function");
    expect(runList).toBeTypeOf("function");
    for (const queryOperation of [
      runActivity,
      runAggregate,
      runCalendar,
      runContext,
      runGet,
      runHistory,
      runNext,
      runSearch,
    ]) {
      expect(queryOperation).toBeTypeOf("function");
    }
    expect(assertExtensionBlueprint).toBeTypeOf("function");
    for (const lifecycleOperation of [
      sdk.runAppend,
      sdk.runClaim,
      sdk.runClaimNext,
      sdk.runCloseMany,
      sdk.runComments,
      sdk.runCreate,
      sdk.runLearnings,
      sdk.runNotes,
      sdk.runPlan,
      sdk.runRelease,
      sdk.runUpdateMany,
      sdk.runUpgrade,
    ]) {
      expect(lifecycleOperation).toBeTypeOf("function");
    }
  });
});
