/**
 * pm-gh1666: in-process coverage of the inherited host-flag help rows, the JSON
 * help projection, and the undeclared root-only refusal for extension commands.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExtensionInheritedFlagHelp,
  buildExtensionInheritedHelpOptionSummaries,
  ensureCommandPath,
  mergeHelpOptionSummaries,
  type ExtensionCommandHelpDescriptor,
  type HelpOptionSummary,
} from "../../../src/cli/extension-command-help.js";
import { maybeRenderBootstrapJsonHelp } from "../../../src/cli/help-json-payload.js";
import { refuseUndeclaredRootOnlyOptions } from "../../../src/cli/runtime/invocation-options.js";
import { _testOnlyContractsCommand } from "../../../src/sdk/cli-contracts/runtime-contracts.js";

function descriptor(command: string, overrides: Partial<ExtensionCommandHelpDescriptor> = {}): ExtensionCommandHelpDescriptor {
  return { command, action: command.replaceAll(" ", "-"), examples: [], failure_hints: [], arguments: [], flags: [], tier: "standard", family: "extensions", ...overrides };
}

function summary(flags: string, overrides: Partial<HelpOptionSummary> = {}): HelpOptionSummary {
  return { flags, long: flags.split(" ")[0]!, short: null, description: "", takes_value: false, value_required: false, value_name: null, variadic: false, required: false, aliases: [], alias_for: null, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extension inherited host flags (pm-gh1666)", () => {
  it("renders inherited rows marked host-owned, with read-output controls only for read commands", () => {
    const rows = buildExtensionInheritedHelpOptionSummaries(descriptor("demo brief"));
    expect(rows.every((row) => row.owner === "host")).toBe(true);
    expect(rows.find((row) => row.long === "--pm-path")).toMatchObject({ flags: "--pm-path <path>", value_name: "path", aliases: ["--path"] });
    expect(rows.find((row) => row.long === "--json")).toMatchObject({ flags: "--json", takes_value: false, value_name: null });
    expect(rows.map((row) => row.long)).not.toContain("--output-limit");
    const readRows = buildExtensionInheritedHelpOptionSummaries(descriptor("demo read", { read_output_declared: true }));
    expect(readRows.map((row) => row.long)).toContain("--output-limit");
    expect(buildExtensionInheritedFlagHelp(descriptor("demo brief"))).toContain(
      "Run pm contracts --command demo brief --flags-only --json for each flag's owner and sdk_option key.",
    );
  });

  it("carries ownership into merged help rows only when the extension row declares it", () => {
    const base = [summary("--status <value>"), summary("--plain")];
    const merged = mergeHelpOptionSummaries(base, [
      summary("--status <value>", { owner: "extension", sdk_option: "status" }),
      summary("--plain"),
    ]);
    expect(merged[0]).toMatchObject({ owner: "extension", sdk_option: "status" });
    expect(merged[1]).not.toHaveProperty("owner");
    expect(merged[1]).not.toHaveProperty("sdk_option");
  });

  it("adds inherited_options to JSON help for extension-created commands only", async () => {
    const root = new Command("pm");
    root.command("list");
    ensureCommandPath(root, ["demo", "brief"]);
    const descriptors = new Map([
      ["demo brief", descriptor("demo brief")],
      ["list", descriptor("list")],
    ]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const read = async (argv: string[]) => {
      stdout.mockClear();
      expect(await maybeRenderBootstrapJsonHelp(root, argv, descriptors)).toBe(true);
      return JSON.parse(String(stdout.mock.calls[0]?.[0])) as { inherited_options?: HelpOptionSummary[] };
    };
    expect((await read(["help", "demo", "brief", "--json"])).inherited_options?.map((row) => row.long)).toContain("--author");
    // A core command an extension augments keeps its own help, and a command without a descriptor has none.
    expect(await read(["help", "list", "--json"])).not.toHaveProperty("inherited_options");
    expect(await read(["help", "demo", "--json"])).not.toHaveProperty("inherited_options");
  });

  it("refuses an undeclared root-only flag, and only a declared long flag unlocks it", () => {
    expect(() => refuseUndeclaredRootOnlyOptions({ all: true }, [], "demo brief")).toThrow(
      "Unknown option '--all' for extension command 'demo brief'. --all is a root-only pm flag and this command does not declare it.",
    );
    expect(() => refuseUndeclaredRootOnlyOptions({ explain: true }, [{ short: "-x" }], "demo brief")).toThrow("Unknown option '--explain'");
    // A short alias that normalizes to the same key does not own the root-only spelling.
    expect(() => refuseUndeclaredRootOnlyOptions({ all: true }, [{ short: "-all" }], "demo brief")).toThrow("Unknown option '--all'");
    expect(() => refuseUndeclaredRootOnlyOptions({ all: true }, [{ long: "--all" }], "demo brief")).not.toThrow();
    expect(() => refuseUndeclaredRootOnlyOptions({ status: "open" }, [], "demo brief")).not.toThrow();
  });

  it("marks contract rows extension-owned with the handler key a direct caller passes", () => {
    expect(_testOnlyContractsCommand.withExtensionFlagOwnership({ flag: "--status-filter" })).toEqual({
      flag: "--status-filter",
      owner: "extension",
      sdk_option: "statusFilter",
    });
    expect(_testOnlyContractsCommand.withExtensionFlagOwnership({ flag: "-S" })).toMatchObject({ owner: "extension", sdk_option: "s" });
    // A row naming no option a handler could read carries the owner without a key.
    expect(_testOnlyContractsCommand.withExtensionFlagOwnership({ flag: "" })).toEqual({ flag: "", owner: "extension" });
  });
});
