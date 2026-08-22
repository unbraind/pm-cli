import { describe, expect, it } from "vitest";
import { _testOnlyRegisterOperations } from "../../../src/cli/register-operations.js";

const emptyValues = {
  addValues: [],
  addJsonValues: [],
  removeValues: [],
  removeIndexValues: [],
};

describe("operation registration adapters", () => {
  it("forwards valid workspace context values and rejects non-string shapes", () => {
    expect(
      _testOnlyRegisterOperations.buildRunTestOptions(
        { workspaceContext: "snapshot" },
        emptyValues,
      ).workspaceContext,
    ).toBe("snapshot");
    expect(
      _testOnlyRegisterOperations.buildRunTestOptions(
        { workspaceContext: 42 },
        emptyValues,
      ).workspaceContext,
    ).toBeUndefined();
  });
});
