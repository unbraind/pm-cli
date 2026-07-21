import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness([
  "../../../../scripts/release/utils.mjs",
  "../../../../scripts/smoke-cleanup.mjs",
]);

type TokenBudgetMeasurement = {
  id: string;
  args: string[];
  bytes: number;
  estimated_tokens: number;
};

type TokenBudgetManifest = {
  version: number;
  metric: string;
  token_estimate: string;
  fixture: string;
  budgets: Array<{
    id: string;
    args: string[];
    max_bytes: number;
    max_estimated_tokens: number;
  }>;
};

type TokenBudgetGateModule = {
  measureOutput: (stdout: string) => { bytes: number; estimated_tokens: number };
  budgetForMeasurement: (
    measurement: TokenBudgetMeasurement,
    multiplier: number,
  ) => TokenBudgetManifest["budgets"][number];
  buildManifest: (measurements: TokenBudgetMeasurement[], multiplier: number) => TokenBudgetManifest;
  compareBudgets: (measurements: TokenBudgetMeasurement[], manifest: TokenBudgetManifest) => string[];
  mutationId: (result: unknown, label: string) => string;
  main: () => void;
};

async function loadModule(): Promise<TokenBudgetGateModule> {
  return harness.importModule<TokenBudgetGateModule>("scripts/release/token-budget-gate.mjs");
}

const CORPUS_IDS = [
  "root-help",
  "search-help",
  "create-help",
  "update-help",
  "contracts-summary-json",
  "contracts-flags-json",
  "list-default",
  "list-json",
  "get-default",
  "get-json-compact-fields",
  "context-default",
  "next-default",
  "search-inline-default",
  "search-inline-json",
];

function manifestForBudget(maxBytes: number): string {
  return JSON.stringify({
    version: 1,
    metric: "utf8_bytes",
    token_estimate: "ceil(bytes / 4)",
    fixture: "test",
    budgets: CORPUS_IDS.map((id) => ({
      id,
      args: [id],
      max_bytes: maxBytes,
      max_estimated_tokens: maxBytes,
    })),
  });
}

function commandStdout(args: string[]): string {
  const joined = args.join(" ");
  if (joined.includes("Alpha planning context")) {
    return JSON.stringify({ id: "pm-parent" });
  }
  if (joined.includes("Beta blocker")) {
    return JSON.stringify({ item: { id: "pm-blocker" } });
  }
  if (joined.includes("Alpha implementation task")) {
    return JSON.stringify({ item: { id: "pm-child" } });
  }
  if (joined.includes("comments pm-child")) {
    return JSON.stringify({ id: "pm-child" });
  }
  if (joined.includes("init --defaults --json")) {
    return JSON.stringify({ ok: true });
  }
  return `output for ${joined}`;
}

function mockRuntime(options: {
  exists?: (targetPath: string) => boolean;
  manifestText?: string;
  stdout?: (args: string[]) => string;
} = {}): {
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  cleanupTempRoot: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
} {
  const readFileSync = vi.fn(() => options.manifestText ?? manifestForBudget(10_000));
  const writeFileSync = vi.fn();
  const cleanupTempRoot = vi.fn();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    return {
      ...actual,
      existsSync: (targetPath: string) => (options.exists ? options.exists(targetPath) : true),
      mkdtempSync: () => "/tmp/pm-token-budget-test",
      readFileSync,
      writeFileSync,
    };
  });
  const runCommand = vi.fn((_command: string, args: string[]) => ({
    status: 0,
    stdout: options.stdout ? options.stdout(args) : commandStdout(args),
    stderr: "",
  }));
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../../../../scripts/release/utils.mjs");
    return {
      ...actual,
      repoRoot: "/repo",
      runCommand,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
  vi.doMock("../../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));
  return { readFileSync, writeFileSync, cleanupTempRoot, runCommand };
}

describe("scripts/release/token-budget-gate", () => {
  let originalArgv: string[];
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalArgv = [...process.argv];
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    delete process.env.PM_TOKEN_BUDGET_SENTINEL;
  });

  it("measures UTF-8 bytes and conservative token estimates", async () => {
    const mod = await loadModule();

    expect(mod.measureOutput("abcd")).toEqual({ bytes: 4, estimated_tokens: 1 });
    expect(mod.measureOutput("abcde")).toEqual({ bytes: 5, estimated_tokens: 2 });
    expect(mod.measureOutput("é")).toEqual({ bytes: 2, estimated_tokens: 1 });
  });

  it("builds budget entries with explicit headroom", async () => {
    const mod = await loadModule();
    const measurement: TokenBudgetMeasurement = {
      id: "context-default",
      args: ["context", "--limit", "5"],
      bytes: 101,
      estimated_tokens: 26,
    };

    expect(mod.budgetForMeasurement(measurement, 1.1)).toEqual({
      id: "context-default",
      args: ["context", "--limit", "5"],
      max_bytes: 112,
      max_estimated_tokens: 29,
    });
  });

  it("reads compact and legacy mutation ids and rejects missing ids", async () => {
    mockRuntime();
    const mod = await loadModule();

    expect(mod.mutationId({ id: "pm-compact" }, "compact")).toBe("pm-compact");
    expect(mod.mutationId({ item: { id: "pm-legacy" } }, "legacy")).toBe("pm-legacy");
    expect(() => mod.mutationId({}, "missing")).toThrow(
      "Token budget fixture missing mutation did not return an item id",
    );
    expect(() => mod.mutationId({ id: "" }, "empty")).toThrow(
      "Token budget fixture empty mutation did not return an item id",
    );
  });

  it("emits a versioned manifest from measured surfaces", async () => {
    const mod = await loadModule();
    const manifest = mod.buildManifest(
      [
        {
          id: "search-json",
          args: ["search", "status:all token", "--json"],
          bytes: 200,
          estimated_tokens: 50,
        },
      ],
      1.05,
    );

    expect(manifest).toMatchObject({
      version: 1,
      metric: "utf8_bytes",
      token_estimate: "ceil(bytes / 4)",
      budgets: [
        {
          id: "search-json",
          max_bytes: 210,
          max_estimated_tokens: 53,
        },
      ],
    });
  });

  it("reports missing and exceeded budget entries", async () => {
    const mod = await loadModule();
    const manifest: TokenBudgetManifest = {
      version: 1,
      metric: "utf8_bytes",
      token_estimate: "ceil(bytes / 4)",
      fixture: "test",
      budgets: [
        {
          id: "root-help",
          args: ["--help"],
          max_bytes: 10,
          max_estimated_tokens: 3,
        },
      ],
    };

    const violations = mod.compareBudgets(
      [
        {
          id: "root-help",
          args: ["--help"],
          bytes: 12,
          estimated_tokens: 3,
        },
        {
          id: "context-default",
          args: ["context"],
          bytes: 4,
          estimated_tokens: 1,
        },
      ],
      manifest,
    );

    expect(violations).toEqual([
      "root-help: 12 bytes exceeds budget 10 bytes (--help)",
      "context-default: missing budget entry",
    ]);
  });

  it("runs direct update mode against a deterministic fixture corpus", async () => {
    const runtime = mockRuntime();
    const scriptPath = path.join(process.cwd(), "scripts/release/token-budget-gate.mjs");
    process.argv = ["node", scriptPath, "--update", "--manifest", "/repo/budgets.json"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.PM_TOKEN_BUDGET_SENTINEL = "kept";

    await harness.importModule<TokenBudgetGateModule>("scripts/release/token-budget-gate.mjs");

    expect(runtime.runCommand).toHaveBeenCalledTimes(19);
    const runOptions = runtime.runCommand.mock.calls[0]?.[2] as { env?: Record<string, string | undefined> } | undefined;
    expect(runOptions?.env).toMatchObject({
      PM_AUTHOR: "token-budget-gate",
      PM_GLOBAL_PATH: path.join("/tmp/pm-token-budget-test", ".global-pm"),
      PM_PATH: path.join("/tmp/pm-token-budget-test", ".agents", "pm"),
      PM_TOKEN_BUDGET_SENTINEL: "kept",
    });
    expect(runtime.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(String(runtime.writeFileSync.mock.calls[0]?.[1])) as TokenBudgetManifest;
    expect(written.budgets.map((entry) => entry.id)).toEqual(CORPUS_IDS);
    expect(runtime.cleanupTempRoot).toHaveBeenCalledWith("/tmp/pm-token-budget-test");
    expect(log).toHaveBeenCalledWith("Updated token budget manifest: budgets.json");
  });

  it("passes budget check mode with a checked manifest", async () => {
    mockRuntime({ manifestText: manifestForBudget(10_000) });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mod = await loadModule();

    mod.main();

    expect(log).toHaveBeenCalledWith("Token budget gate passed (14 surfaces checked).");
  });

  it("uses the default manifest path for a bare manifest flag", async () => {
    const runtime = mockRuntime({ manifestText: manifestForBudget(10_000) });
    process.argv = ["node", "vitest", "--manifest"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mod = await loadModule();

    mod.main();

    expect(runtime.readFileSync.mock.calls[0]?.[0]).toBe(path.join("/repo", "scripts", "release", "token-budgets.json"));
    expect(log).toHaveBeenCalledWith("Token budget gate passed (14 surfaces checked).");
  });

  it("fails for invalid headroom", async () => {
    mockRuntime();
    process.argv = ["node", "vitest", "--headroom", "0"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow("FAIL:1:--headroom must be a finite number >= 1");
  });

  it("fails when the built CLI is missing", async () => {
    mockRuntime({ exists: (targetPath) => path.basename(targetPath) !== "cli.js" });
    process.argv = ["node", "vitest"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow("Built CLI not found");
  });

  it("fails when the token budget manifest is missing", async () => {
    const runtime = mockRuntime({ exists: (targetPath) => !targetPath.endsWith("budgets.json") });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow("Token budget manifest missing");
    expect(runtime.runCommand).not.toHaveBeenCalled();
  });

  it("fails when a measured surface exceeds its budget", async () => {
    mockRuntime({ manifestText: manifestForBudget(1) });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow("Token budget gate failed");
  });

  it("fails when the token budget manifest shape is malformed", async () => {
    mockRuntime({ manifestText: "{}" });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: expected a top-level budgets array",
    );
  });

  it("fails when a token budget entry is malformed", async () => {
    mockRuntime({ manifestText: JSON.stringify({ budgets: [{ id: "", max_bytes: -1 }] }) });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: each budget entry requires a string id and non-negative max_bytes",
    );
  });

  it("fails when a fixture command expected to be JSON returns malformed output", async () => {
    mockRuntime({
      stdout: (args) => (args.join(" ").includes("Alpha planning context") ? "not json" : commandStdout(args)),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];

    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget fixture command did not return JSON",
    );
  });
});
