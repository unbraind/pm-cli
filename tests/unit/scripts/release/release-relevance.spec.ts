import { describe, expect, it } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

describe("scripts/release/release-relevance", () => {
  it("treats .agents/pm/ paths as not release-relevant (forward and back slashes)", async () => {
    const module = await harness.importModule<
      typeof import("../../../../scripts/release/release-relevance.mjs")
    >("scripts/release/release-relevance.mjs");
    expect(module.isReleaseRelevantPath(".agents/pm/tasks/pm-1.md")).toBe(false);
    expect(module.isReleaseRelevantPath(".agents\\pm\\tasks\\pm-1.md")).toBe(false);
    expect(module.isReleaseRelevantPath("src/cli/main.ts")).toBe(true);
  });
});
