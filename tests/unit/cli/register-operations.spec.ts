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

  it("forwards test-all workspace trust controls in foreground mode", () => {
    expect(
      _testOnlyRegisterOperations.buildRunTestAllOptions({
        workspaceContext: "snapshot",
        overrideLinkedWorkspaceContext: true,
        allowUntrustedLinkedTests: true,
      }),
    ).toMatchObject({
      workspaceContext: "snapshot",
      overrideLinkedWorkspaceContext: true,
      allowUntrustedLinkedTests: true,
    });
  });

  it("rejects background acknowledgement before launching a worker", () => {
    expect(() =>
      _testOnlyRegisterOperations.validateBackgroundTestOptions(
        {
          background: true,
          run: true,
          acknowledgeLinkedTests: true,
        },
        emptyValues,
      ),
    ).toThrow(/non-executing foreground operation/u);
  });
});
