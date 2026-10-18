import { describe, expect, it } from "vitest";
import { normalizeBootstrapInvocation, parseBootstrapCommandName } from "../../../../src/sdk/cli-bootstrap.js";
import { resolveSubcommandFlagContractsForCommand } from "../../../../src/sdk/cli-contracts/flag-contracts.js";

describe("SDK output format compatibility", () => {
  it.each(["comments", "files", "docs", "test", "notes", "learnings", "create", "update", "close", "claim", "package upgrade"])("declares and normalizes the encoding alias for %s", (command) => {
    const encoding = resolveSubcommandFlagContractsForCommand(command).find((entry) => entry.flag === "--output-format");
    expect(encoding?.aliases).toContain("--format");
    const argv = ["--format", "json", ...command.split(" ")];
    expect(parseBootstrapCommandName(argv)).toBe(command.split(" ")[0]);
    expect(normalizeBootstrapInvocation(argv).argv).toEqual(["--output-format", "json", ...normalizeBootstrapInvocation(command.split(" ")).argv]);
  });

  it.each(["list", "get", "config", "deps", "test-runs-worker", "package unknown", "custom-package-command", ""])("preserves command-local and package format vocabulary for %s", (command) => {
    const encoding = resolveSubcommandFlagContractsForCommand(command).find((entry) => entry.flag === "--output-format");
    expect(encoding?.aliases ?? []).not.toContain("--format");
    const canonical = normalizeBootstrapInvocation(command.split(" ").filter(Boolean)).argv;
    expect(normalizeBootstrapInvocation([...command.split(" ").filter(Boolean), "--format", "json"]).argv).toEqual([...canonical, "--format", "json"]);
  });

  it("preserves terminators and flag-shaped tracker path values", () => {
    expect(normalizeBootstrapInvocation(["notes", "pm-a", "--", "--format=json"]).argv).toEqual(["item", "notes", "pm-a", "--", "--format=json"]);
    expect(normalizeBootstrapInvocation(["--pm-path", "--format", "notes", "pm-a"]).argv).toEqual(["--pm-path", "--format", "item", "notes", "pm-a"]);
  });
});
