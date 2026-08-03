import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { _testOnly } from "../../../src/cli/help-json-payload.js";
import { hasSubcommandFlagContractsForCommand } from "../../../src/sdk/index.js";

describe("structured help command-path resolution", () => {
  it("resolves exact, implicit, and contract-backed positional command paths", () => {
    const root = new Command("pm");
    const workspace = root.command("workspace");
    const snapshot = workspace.command("snapshot");

    expect(_testOnly.resolveCommandFromPathTokens(root, [])).toBe(root);
    expect(_testOnly.resolveCommandFromPathTokens(root, ["workspace"])).toBe(
      workspace,
    );
    expect(_testOnly.resolveCommandFromPathTokens(root, ["help"])).toBe(root);
    expect(
      _testOnly.resolveCommandFromPathTokens(root, [
        "workspace",
        "snapshot",
        "create",
      ]),
    ).toBe(snapshot);
    expect(
      _testOnly.resolveCommandFromPathTokens(root, ["missing"]),
    ).toBeNull();

    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        snapshot,
        [],
        ["workspace", "snapshot", "create"],
        new Map(),
      ).resolved_path,
    ).toBe("workspace snapshot create");
    expect(
      _testOnly.buildJsonHelpPayload(
        root,
        snapshot,
        [],
        ["workspace", "snapshot"],
        new Map(),
      ).resolved_path,
    ).toBe("workspace snapshot");
  });

  it("fails closed when a known virtual path has no registered parent", () => {
    expect(
      _testOnly.resolveCommandFromPathTokens(new Command("pm"), [
        "workspace",
        "snapshot",
        "create",
      ]),
    ).toBeNull();
  });

  it("distinguishes concrete flag-contract paths from surface-less or invalid paths", () => {
    expect(
      hasSubcommandFlagContractsForCommand("workspace snapshot create"),
    ).toBe(true);
    expect(hasSubcommandFlagContractsForCommand(" extension init ")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand("package install")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand("packages doctor")).toBe(true);
    expect(hasSubcommandFlagContractsForCommand(undefined)).toBe(false);
    expect(hasSubcommandFlagContractsForCommand("help")).toBe(false);
    expect(hasSubcommandFlagContractsForCommand("extension unknown")).toBe(
      false,
    );
    expect(hasSubcommandFlagContractsForCommand("extension init extra")).toBe(
      false,
    );
  });
});
