import type * as childProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PM_COMMAND_DESTINATION_CONTRACTS,
  PM_COMMAND_POSITIONAL_CONTRACTS,
} from "../../../../src/sdk/cli-contracts/grammar-contracts.js";
import { createScriptHarness } from "../../../helpers/scriptModule.js";

const harness = createScriptHarness();
const initialExitCode = process.exitCode;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = initialExitCode;
});

async function runGrammarGate(
  commandSummaries: unknown,
  options: {
    argumentOverrides?: Readonly<Record<string, readonly unknown[]>>;
    helpFailures?: readonly string[];
    rootHelpRows?: readonly unknown[];
    positionalSignatures?: unknown;
    runtimeCommands?: readonly string[];
  } = {},
): Promise<{
  report: {
    ok: boolean;
    command_count: number;
    findings: Array<{ code: string; spelling: string }>;
    positionals: {
      ok: boolean;
      findings: Array<{ code: string; command: string }>;
      inactive_package_commands: string[];
    };
    mcp: {
      ok: boolean;
      findings: Array<{ code: string }>;
      option_parity: {
        create: { ok: boolean; parameter_count: number };
        update: { ok: boolean; parameter_count: number };
      };
    };
  };
  exitCode: number | string | null | undefined;
  module: {
    collectLiveCliCommandPaths: (
      loadHelp?: (
        commandPath?: string[],
        disableExtensions?: boolean,
      ) => unknown,
      activePackageCommands?: string[],
      registeredCommandSeeds?: string[],
    ) => string[];
    verifyMcpGrammar: (
      actions: string[],
      tools: Array<Record<string, unknown>>,
      narrowActions: Record<string, string>,
    ) => { ok: boolean; findings: Array<{ code: string }> };
  };
}> {
  const derivedPositionalSignatures = Array.isArray(commandSummaries)
    ? commandSummaries
        .filter(
          (summary): summary is { command: string; positionals?: unknown[] } =>
            typeof summary === "object" &&
            summary !== null &&
            typeof (summary as { command?: unknown }).command === "string",
        )
        .map(({ command, positionals }) => ({
          command,
          slots: Array.isArray(positionals) ? positionals : [],
        }))
    : undefined;
  const runtimeCommands =
    options.runtimeCommands ??
    PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => command);
  const coreRuntimeCommands = PM_COMMAND_DESTINATION_CONTRACTS.filter(
    ({ disposition }) => disposition !== "package_owned",
  ).map(({ command }) => command);
  const execFileSync = vi.fn((_executable: string, args: string[]) => {
    if (args.includes("contracts")) {
      return JSON.stringify({
        command_summaries: commandSummaries,
        grammar_contracts: {
          positional_signatures: Object.hasOwn(options, "positionalSignatures")
            ? options.positionalSignatures
            : derivedPositionalSignatures,
        },
      });
    }
    const helpIndex = args.indexOf("help");
    const budgetIndex = args.indexOf("--output-budget");
    const parentPath = args.slice(helpIndex + 1, budgetIndex);
    const parent = parentPath.join(" ");
    if (
      parent.length > 0 &&
      !runtimeCommands.some(
        (command) => command === parent || command.startsWith(`${parent} `),
      )
    ) {
      throw new Error(`Synthetic missing command ${parent}`);
    }
    if (options.helpFailures?.includes(parent) === true) {
      throw new Error(`Synthetic help failure for ${parent}`);
    }
    const prefix = parent.length > 0 ? `${parent} ` : "";
    const helpCommands = args.includes("--no-extensions")
      ? coreRuntimeCommands
      : runtimeCommands;
    const subcommands: unknown[] = [
      ...new Set(
        helpCommands.flatMap((command) => {
          if (!command.startsWith(prefix)) return [];
          const remainder = command.slice(prefix.length);
          const name = remainder.split(" ")[0];
          return typeof name === "string" && name.length > 0 ? [name] : [];
        }),
      ),
    ].map((name) => ({
      name,
      aliases:
        name === "context" ? ["ctx"] : name === "package" ? ["packages"] : [],
    }));
    if (parent.length === 0) subcommands.push(...(options.rootHelpRows ?? []));
    const contract = PM_COMMAND_POSITIONAL_CONTRACTS.find(
      ({ command }) => command === parent,
    );
    return JSON.stringify({
      arguments:
        options.argumentOverrides?.[parent] ??
        contract?.slots.map(({ name, required, variadic }) => ({
          name,
          required,
          variadic,
        })) ??
        [],
      subcommands,
    });
  });
  vi.doMock("node:child_process", async (importOriginal) => ({
    ...(await importOriginal<typeof childProcess>()),
    execFileSync,
  }));
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  const module = await harness.importModule<{
    collectLiveCliCommandPaths: (
      loadHelp?: (
        commandPath?: string[],
        disableExtensions?: boolean,
      ) => unknown,
      activePackageCommands?: string[],
    ) => string[];
    verifyMcpGrammar: (
      actions: string[],
      tools: Array<Record<string, unknown>>,
      narrowActions: Record<string, string>,
    ) => { ok: boolean; findings: Array<{ code: string }> };
  }>("scripts/release/command-grammar-gate.mjs", "commandGrammarGate");
  expect(execFileSync).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(["contracts", "--full", "--json"]),
    expect.objectContaining({
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }),
  );
  return {
    report: JSON.parse(output) as {
      ok: boolean;
      command_count: number;
      findings: Array<{ code: string; spelling: string }>;
      positionals: {
        ok: boolean;
        findings: Array<{ code: string; command: string }>;
        inactive_package_commands: string[];
      };
      mcp: {
        ok: boolean;
        findings: Array<{ code: string }>;
        option_parity: {
          create: { ok: boolean; parameter_count: number };
          update: { ok: boolean; parameter_count: number };
        };
      };
    },
    exitCode: process.exitCode,
    module,
  };
}

describe("command grammar gate", () => {
  const liveCommandSummaries = PM_COMMAND_POSITIONAL_CONTRACTS.map(
    ({ command, slots: positionals }) => ({ command, positionals }),
  );

  it("accepts the exhaustive live destination census and ignores malformed rows", async () => {
    const result = await runGrammarGate(
      [...liveCommandSummaries, null, { command: 42 }, {}],
      {
        rootHelpRows: [
          null,
          {},
          { name: 42 },
          { name: " " },
          { name: "context", aliases: "ctx" },
          { name: "context", aliases: [null, "", "ctx"] },
        ],
      },
    );
    expect(result.report).toMatchObject({
      ok: true,
      command_count: PM_COMMAND_DESTINATION_CONTRACTS.length,
      positionals: { ok: true, findings: [] },
      mcp: {
        ok: true,
        findings: [],
        option_parity: {
          create: { ok: true, parameter_count: 43 },
          update: { ok: true, parameter_count: 48 },
        },
      },
    });
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.module.collectLiveCliCommandPaths()).toEqual(
      PM_COMMAND_DESTINATION_CONTRACTS.map(({ command }) => command).sort(
        (left, right) => left.localeCompare(right),
      ),
    );
  });

  it("loads positional help for an active package command absent from root help", async () => {
    const { module } = await runGrammarGate(liveCommandSummaries);
    const loadHelp = vi.fn((commandPath: string[] = []) =>
      commandPath.length === 0
        ? { subcommands: [{ name: "help", aliases: ["h"] }] }
        : {
            arguments: [
              null,
              { name: "", required: true, variadic: false },
              { name: "query", required: false, variadic: true },
            ],
            subcommands: [],
          },
    );

    expect(
      module.collectLiveCliCommandPaths(loadHelp, ["package search"]),
    ).toEqual(["h", "help", "package search"]);
    expect(loadHelp).toHaveBeenCalledWith(["package", "search"]);
  });

  it("fails closed for MCP action and narrow-tool drift", async () => {
    const { module } = await runGrammarGate(liveCommandSummaries);
    const result = module.verifyMcpGrammar(
      ["create"],
      [
        {
          name: "pm_run",
          inputSchema: { properties: { action: { enum: ["update"] } } },
        },
        { name: "pm_run", inputSchema: {} },
        { name: "pm_orphan", inputSchema: {} },
        { name: "pm_unbound", inputSchema: {} },
      ],
      { pm_missing: "create", pm_orphan: "missing" },
    );

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "duplicate_mcp_tool",
        "missing_pm_run_action",
        "stale_pm_run_action",
        "missing_narrow_mcp_tool",
        "undiscoverable_narrow_action",
        "unbound_narrow_mcp_tool",
      ]),
    );
  });

  it("rejects a missing or untyped pm_run dispatcher", async () => {
    const { module } = await runGrammarGate(liveCommandSummaries);
    expect(module.verifyMcpGrammar([], [], {}).findings).toContainEqual(
      expect.objectContaining({ code: "missing_pm_run_tool" }),
    );
    expect(
      module.verifyMcpGrammar([], [{ name: "pm_run", inputSchema: {} }], {})
        .findings,
    ).toContainEqual(
      expect.objectContaining({ code: "invalid_pm_run_action_enum" }),
    );
  });

  it("fails closed when the contracts response omits its summary array", async () => {
    const result = await runGrammarGate(undefined);
    expect(result.report.ok).toBe(false);
    expect(result.report.command_count).toBe(
      PM_COMMAND_DESTINATION_CONTRACTS.length,
    );
    expect(result.report.findings).toContainEqual(
      expect.objectContaining({
        spelling: "contracts.command_summaries",
        nearest_target: "pm contracts --full --json",
      }),
    );
    expect(result.exitCode).toBe(1);
  });

  it("fails closed when a declared contract has no live CLI registration", async () => {
    const result = await runGrammarGate(liveCommandSummaries, {
      runtimeCommands: PM_COMMAND_DESTINATION_CONTRACTS.map(
        ({ command }) => command,
      ).filter((command) => command !== "create"),
    });
    expect(result.report).toMatchObject({
      ok: false,
      command_count: PM_COMMAND_DESTINATION_CONTRACTS.length - 1,
      findings: [
        expect.objectContaining({
          code: "stale_destination",
          spelling: "create",
        }),
      ],
    });
    expect(result.exitCode).toBe(1);
  });

  it("ignores longer Commander aliases while preserving termination", async () => {
    const result = await runGrammarGate(liveCommandSummaries, {
      rootHelpRows: [{ name: "loop", aliases: ["loop loop"] }],
    });
    expect(result.report).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_destination",
          spelling: "loop",
        }),
      ]),
    });
    expect(result.report.findings).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it("fails closed when an observed positional slot changes arity", async () => {
    const schemaSlots = PM_COMMAND_POSITIONAL_CONTRACTS.find(
      ({ command }) => command === "schema",
    )!.slots;
    const result = await runGrammarGate(liveCommandSummaries, {
      argumentOverrides: {
        schema: schemaSlots.map(({ name, required, variadic }, index) => ({
          name,
          required: index === 0 ? !required : required,
          variadic,
        })),
      },
    });
    expect(result.report).toMatchObject({
      ok: false,
      positionals: {
        ok: false,
        findings: [
          expect.objectContaining({
            code: "positional_signature_mismatch",
            command: "schema",
          }),
        ],
      },
    });
    expect(result.exitCode).toBe(1);
  });

  it("fails closed when active package help omits its positional slots", async () => {
    const omittedCommand = "changelog export";
    const result = await runGrammarGate(liveCommandSummaries, {
      argumentOverrides: { [omittedCommand]: [] },
    });
    expect(result.report).toMatchObject({
      ok: false,
      positionals: {
        ok: false,
        findings: [
          expect.objectContaining({
            code: "positional_signature_mismatch",
            command: omittedCommand,
          }),
        ],
      },
    });
    expect(result.exitCode).toBe(1);
  });

  it("reports an active package command whose live help cannot be read", async () => {
    const unreadableCommand = "changelog export";
    const result = await runGrammarGate(liveCommandSummaries, {
      helpFailures: [unreadableCommand],
      runtimeCommands: PM_COMMAND_DESTINATION_CONTRACTS.map(
        ({ command }) => command,
      ).filter((command) => command !== unreadableCommand),
    });
    expect(result.report).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_destination",
          spelling: unreadableCommand,
          nearest_target: `pm ${unreadableCommand} --help --json`,
        }),
      ]),
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not duplicate a declared signature for an inactive package command", async () => {
    const inactiveCommand = "search-advanced";
    const result = await runGrammarGate(
      liveCommandSummaries.filter(({ command }) => command !== inactiveCommand),
      {
        runtimeCommands: PM_COMMAND_DESTINATION_CONTRACTS.map(
          ({ command }) => command,
        ).filter((command) => command !== inactiveCommand),
      },
    );
    expect(result.report).toMatchObject({
      ok: true,
      positionals: {
        ok: true,
        inactive_package_commands: [inactiveCommand],
        findings: [],
      },
    });
    expect(result.exitCode ?? 0).toBe(0);
  });
});
