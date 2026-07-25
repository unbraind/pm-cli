import { describe, expect, it } from "vitest";
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import { PM_TOOL_ACTIONS } from "@unbrained/pm-cli/sdk/contracts";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runValidate } from "@unbrained/pm-cli/sdk/governance";
import { runGraph } from "@unbrained/pm-cli/sdk/graph";
import { mergeItemDocuments } from "@unbrained/pm-cli/sdk/merge";
import { runList } from "@unbrained/pm-cli/sdk/query";
import { assertExtensionBlueprint } from "@unbrained/pm-cli/sdk/testing";

describe("public SDK capability entrypoints", () => {
  it("resolve independently through the package export map", () => {
    expect(defineExtension).toBeTypeOf("function");
    expect(PM_TOOL_ACTIONS).toContain("create");
    expect(PmClient).toBeTypeOf("function");
    expect(runValidate).toBeTypeOf("function");
    expect(runGraph).toBeTypeOf("function");
    expect(mergeItemDocuments).toBeTypeOf("function");
    expect(runList).toBeTypeOf("function");
    expect(assertExtensionBlueprint).toBeTypeOf("function");
  });
});
