import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/measure-agent-token-surface.mjs";

const ROOT_HELP = [
  "Usage: pm [options] [command]",
  "",
  "Commands:",
  "  ls|list                 List workspace items",
  "  get                     Read a single item",
  "  help                    Show help for a command",
  "      wrapped description continuation line",
  "",
  "Intent examples:",
  "  pm ls --status open",
  "",
].join("\n");

const LS_HELP = "Usage: pm ls [options] — a deliberately longer help payload for sorting";
const GET_HELP_STDOUT = "GET HELP VIA STDOUT";
const CONTRACTS = {
  summary_toon: "SUMMARY-TOON",
  summary_json: "SUMMARY-JSON-PAYLOAD",
  json: "CONTRACTS-JSON-PAYLOAD-LONG",
  full: "CONTRACTS-FULL",
};

interface ExecOverrides {
  lsHelp?: () => string;
}

function keyOf(args: readonly string[]): string {
  return args.join(" ");
}

function createExecFileSync(overrides: ExecOverrides = {}) {
  return vi.fn((_command: string, args: readonly string[]) => {
    const key = keyOf(args);
    if (key === "--version") return "9.9.9-test\n";
    if (key === "--help --no-pager") return ROOT_HELP;
    if (key === "ls --help --no-pager") {
      return (overrides.lsHelp ?? (() => LS_HELP))();
    }
    if (key === "get --help --no-pager") {
      throw Object.assign(new Error("exit 2"), { stdout: GET_HELP_STDOUT });
    }
    if (key === "contracts --summary --no-pager") return CONTRACTS.summary_toon;
    if (key === "contracts --summary --json --no-pager") return CONTRACTS.summary_json;
    if (key === "contracts --json --no-pager") return CONTRACTS.json;
    if (key === "contracts --full --no-pager") return CONTRACTS.full;
    throw new Error(`unexpected execFileSync args: ${key}`);
  });
}

interface FakeMcpChild {
  child: EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  spawn: ReturnType<typeof vi.fn>;
}

function createMcpChild(onRequest: (child: FakeMcpChild["child"]) => void): FakeMcpChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    kill: vi.fn(),
    stdin: { write: vi.fn(() => onRequest(child)) },
  });
  const spawn = vi.fn(() => child);
  return { child, spawn };
}

function mockChildProcess(execFileSync: ReturnType<typeof vi.fn>, spawn: ReturnType<typeof vi.fn>): void {
  vi.doMock("node:child_process", () => ({ execFileSync, spawn }));
}

function configureSuccessfulMeasurement(): void {
  const execFileSync = createExecFileSync();
  const { spawn } = createMcpChild((mcp) => {
    mcp.stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "pm_get" }] },
      })}\n`,
    );
  });
  mockChildProcess(execFileSync, spawn);
}

function permissiveBaseline(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    metric: "utf8_bytes",
    surfaces: {
      root_help: 1_000_000,
      per_command_total: 1_000_000,
      full_help_surface: 1_000_000,
      mcp_tools_list: 1_000_000,
      contracts: {
        summary_toon: 1_000_000,
        summary_json: 1_000_000,
        json: 1_000_000,
        full: 1_000_000,
      },
      commands: { ls: 1_000_000, get: 1_000_000 },
    },
    ...overrides,
  });
}

interface Report {
  pm_version: string;
  root_help: { bytes: number; tokens: number };
  command_count: number;
  per_command_total: { bytes: number; tokens: number };
  full_help_surface: { bytes: number; tokens: number };
  commands: Array<{ name: string; bytes: number; tokens: number }>;
  contracts: Record<string, { bytes: number; tokens: number }>;
  mcp_tools_list: { bytes: number; tokens: number; tool_count: number };
}

interface TokenSurfaceBaseline {
  version: number;
  metric: string;
  headroom: number;
  surfaces: {
    root_help: number;
    per_command_total: number;
    full_help_surface: number;
    contracts: Record<string, number>;
    mcp_tools_list: number;
    commands: Record<string, number>;
  };
}

interface TokenSurfaceModule {
  buildBaseline: (report: Report, headroom?: number) => TokenSurfaceBaseline;
  compareBaseline: (
    report: Report,
    baseline: TokenSurfaceBaseline,
  ) => string[];
}

async function importAndCaptureReport(): Promise<Report> {
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await harness.importModule(SCRIPT);
  const payload = String(stdoutWrite.mock.calls.at(-1)?.[0] ?? "{}");
  stdoutWrite.mockRestore();
  return JSON.parse(payload) as Report;
}

async function importAndCaptureModule(): Promise<{
  report: Report;
  module: TokenSurfaceModule;
}> {
  const stdoutWrite = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const module = await harness.importModule<TokenSurfaceModule>(SCRIPT);
  const payload = String(stdoutWrite.mock.calls.at(-1)?.[0] ?? "{}");
  stdoutWrite.mockRestore();
  return { report: JSON.parse(payload) as Report, module };
}

describe("measure-agent-token-surface", () => {
  it("measures root help, per-command help (including stderr-exit commands), contracts, and MCP tools/list", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync();
    const toolsLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "pm_get" }, { name: "pm_list" }] },
    });
    const { child, spawn } = createMcpChild((mcp) => {
      mcp.stdout.emit(
        "data",
        ["   ", "not-json", '{"jsonrpc":"2.0","id":2,"result":{}}', toolsLine].join("\n"),
      );
    });
    mockChildProcess(execFileSync, spawn);

    const report = await importAndCaptureReport();

    expect(execFileSync.mock.calls[0]?.[0]).toBe("pm");
    expect(report.pm_version).toBe("9.9.9-test");
    const rootBytes = Buffer.byteLength(ROOT_HELP);
    expect(report.root_help).toEqual({ bytes: rootBytes, tokens: Math.round(rootBytes / 4) });
    // "help" is filtered, the alias line contributes only its primary name, and
    // the deeper-indented continuation line is skipped without ending the scan.
    expect(report.command_count).toBe(2);
    expect(report.commands.map((entry) => entry.name)).toEqual(["ls", "get"]);
    expect(report.commands[1]?.bytes).toBe(Buffer.byteLength(GET_HELP_STDOUT));
    const perCommand = Buffer.byteLength(LS_HELP) + Buffer.byteLength(GET_HELP_STDOUT);
    expect(report.per_command_total.bytes).toBe(perCommand);
    expect(report.full_help_surface).toEqual({
      bytes: rootBytes + perCommand,
      tokens: Math.round((rootBytes + perCommand) / 4),
    });
    for (const [key, payload] of Object.entries(CONTRACTS)) {
      expect(report.contracts[key]?.bytes).toBe(Buffer.byteLength(payload));
    }
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/dist[\\/]mcp[\\/]server\.js$/)],
      expect.objectContaining({ stdio: ["pipe", "pipe", "ignore"] }),
    );
    expect(report.mcp_tools_list).toEqual({
      bytes: Buffer.byteLength(toolsLine),
      tokens: Math.round(Buffer.byteLength(toolsLine) / 4),
      tool_count: 2,
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("honors PM_BIN and reports tool_count 0 when the tools/list result is absent", async () => {
    process.env.PM_BIN = "pm-alt";
    const execFileSync = createExecFileSync();
    const { spawn } = createMcpChild((mcp) => {
      mcp.stdout.emit("data", '{"jsonrpc":"2.0","id":1}\n');
    });
    mockChildProcess(execFileSync, spawn);

    const report = await importAndCaptureReport();

    expect(execFileSync.mock.calls[0]?.[0]).toBe("pm-alt");
    expect(report.mcp_tools_list.tool_count).toBe(0);
  });

  it("builds and compares versioned per-surface regression baselines", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync();
    const { spawn } = createMcpChild((mcp) => {
      mcp.stdout.emit(
        "data",
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "pm_get" }] },
        })}\n`,
      );
    });
    mockChildProcess(execFileSync, spawn);

    const { report, module } = await importAndCaptureModule();
    const baseline = module.buildBaseline(report, 1);

    expect(baseline).toMatchObject({
      version: 1,
      metric: "utf8_bytes",
      headroom: 1,
      surfaces: {
        root_help: report.root_help.bytes,
        contracts: {
          summary_toon: report.contracts.summary_toon?.bytes,
        },
      },
    });
    expect(module.compareBaseline(report, baseline)).toEqual([]);

    baseline.surfaces.root_help = 1;
    delete baseline.surfaces.commands.ls;
    expect(module.compareBaseline(report, baseline)).toEqual([
      `root_help: ${report.root_help.bytes} bytes exceeds 1`,
      "commands.ls: missing baseline",
    ]);
  });

  it("writes an intentional baseline update to an explicit path", async () => {
    delete process.env.PM_BIN;
    configureSuccessfulMeasurement();
    const writeFileSync = vi.fn();
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(),
      writeFileSync,
    }));
    const originalArgv = process.argv;
    process.argv = [
      "node",
      SCRIPT,
      "--update",
      "--baseline",
      "/tmp/token-surface.json",
    ];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await harness.importModule(SCRIPT);
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/token-surface.json",
        expect.stringContaining('"version": 1'),
        "utf8",
      );
      expect(stdoutWrite).toHaveBeenCalledWith(
        "Updated agent token-surface baseline: /tmp/token-surface.json\n",
      );
    } finally {
      stdoutWrite.mockRestore();
      process.argv = originalArgv;
    }
  });

  it("passes a checked baseline and falls back when --baseline has no value", async () => {
    delete process.env.PM_BIN;
    configureSuccessfulMeasurement();
    const readFileSync = vi.fn(() => permissiveBaseline());
    vi.doMock("node:fs", () => ({
      readFileSync,
      writeFileSync: vi.fn(),
    }));
    const originalArgv = process.argv;
    process.argv = ["node", SCRIPT, "--check", "--baseline"];
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await harness.importModule(SCRIPT);
      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/scripts[\\/]agent-token-surface-baseline\.json$/),
        "utf8",
      );
      expect(stdoutWrite).toHaveBeenCalledWith(
        "Agent token-surface gate passed (10 surfaces).\n",
      );
    } finally {
      stdoutWrite.mockRestore();
      process.argv = originalArgv;
    }
  });

  it.each([
    ["version", permissiveBaseline({ version: 2 })],
    ["metric", permissiveBaseline({ metric: "tokens" })],
  ])("rejects a checked baseline with an unsupported %s", async (_field, baselineText) => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      SCRIPT,
      "--check",
      "--baseline",
      "/tmp/token-surface.json",
    ];
    configureSuccessfulMeasurement();
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => baselineText),
      writeFileSync: vi.fn(),
    }));
    try {
      await expect(harness.importModule(SCRIPT)).rejects.toThrow(
        "Unsupported agent token-surface baseline",
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("rejects a checked baseline with token-surface regressions", async () => {
    const originalArgv = process.argv;
    process.argv = [
      "node",
      SCRIPT,
      "--check",
      "--baseline",
      "/tmp/token-surface.json",
    ];
    configureSuccessfulMeasurement();
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() =>
        permissiveBaseline({
          surfaces: {
            root_help: 0,
            per_command_total: 0,
            full_help_surface: 0,
            mcp_tools_list: 0,
            contracts: {},
            commands: {},
          },
        }),
      ),
      writeFileSync: vi.fn(),
    }));
    try {
      await expect(harness.importModule(SCRIPT)).rejects.toThrow(
        "Agent token-surface regression",
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("reports tool_count 0 when the result carries no tools array", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync();
    const { spawn } = createMcpChild((mcp) => {
      mcp.stdout.emit("data", '{"jsonrpc":"2.0","id":1,"result":{}}\n');
    });
    mockChildProcess(execFileSync, spawn);

    const report = await importAndCaptureReport();

    expect(report.mcp_tools_list.tool_count).toBe(0);
  });

  it("fails fast when a per-command help exits nonzero without stdout", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync({
      lsHelp: () => {
        throw new Error("spawn pm ENOENT");
      },
    });
    const { spawn } = createMcpChild(() => undefined);
    mockChildProcess(execFileSync, spawn);

    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/pm ls --help failed: spawn pm ENOENT/);
  });

  it("rejects when the MCP server process errors", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync();
    const { spawn } = createMcpChild((mcp) => {
      mcp.emit("error", new Error("mcp spawn boom"));
    });
    mockChildProcess(execFileSync, spawn);

    await expect(harness.importModule(SCRIPT)).rejects.toThrow(/mcp spawn boom/);
  });

  it("times out when the MCP server never answers tools/list", async () => {
    delete process.env.PM_BIN;
    const execFileSync = createExecFileSync();
    const { child, spawn } = createMcpChild(() => undefined);
    mockChildProcess(execFileSync, spawn);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const moduleError = harness.importModule(SCRIPT).then(
        () => new Error("import unexpectedly resolved"),
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(child.stdin.write).toHaveBeenCalled();
      });
      vi.advanceTimersByTime(30_001);
      const error = await moduleError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/MCP tools\/list timed out after 30s/);
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
