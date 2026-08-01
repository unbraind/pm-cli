import { describe, expect, it } from "vitest";
import * as sdk from "@unbrained/pm-cli/sdk";
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import { PM_TOOL_ACTIONS } from "@unbrained/pm-cli/sdk/contracts";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import {
  runReindex,
  runUpgrade,
  runValidate,
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
    expect(PmClient).toBeTypeOf("function");
    expect(runValidate).toBeTypeOf("function");
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
