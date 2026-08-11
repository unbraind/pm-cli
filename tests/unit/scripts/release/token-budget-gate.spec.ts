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
  lines?: number;
  max_lines?: number;
  kind?: "discovery" | "answer";
  scale_tier?: string;
  command?: string;
  contract_max_estimated_tokens?: number;
  intent?: boolean;
  intent_receipt?: {
    declaration_feasible: boolean;
    result_omitted: boolean;
    within_budget: boolean;
    estimated_tokens: number;
    token_budget: number;
  };
};

type TokenBudgetManifest = {
  version: number;
  metric: string;
  token_estimate: string;
  fixture: string;
  budgets: Array<{
    id: string;
    args: string[];
    kind: "discovery" | "answer";
    scale_tier: string;
    baseline_bytes: number;
    baseline_estimated_tokens: number;
    baseline_lines?: number;
    max_lines?: number;
    command?: string;
    contract_max_estimated_tokens?: number;
    max_bytes?: number;
    max_estimated_tokens?: number;
  }>;
};

type TokenBudgetGateModule = {
  measureOutput: (stdout: string) => {
    bytes: number;
    estimated_tokens: number;
    lines: number;
  };
  budgetForMeasurement: (
    measurement: TokenBudgetMeasurement,
    multiplier: number,
  ) => TokenBudgetManifest["budgets"][number];
  buildManifest: (
    measurements: TokenBudgetMeasurement[],
    multiplier: number,
  ) => TokenBudgetManifest;
  compareBudgets: (
    measurements: TokenBudgetMeasurement[],
    manifest: TokenBudgetManifest,
  ) => string[];
  mutationId: (result: unknown, label: string) => string;
  main: () => void;
};

async function loadModule(): Promise<TokenBudgetGateModule> {
  return harness.importModule<TokenBudgetGateModule>(
    "scripts/release/token-budget-gate.mjs",
  );
}

const CORPUS_IDS = [
  "root-help",
  "search-help",
  "create-help",
  "update-help",
  "contracts-summary-json",
  "contracts-flags-json",
  "list-default",
  "list-open-default",
  "list-json",
  "get-default",
  "get-json-compact-fields",
  "context-default",
  "next-default",
  "activity-default",
  "stats-default",
  "deps-tree-default",
  "deps-tree-json",
  "graph-audit-summary",
  "duplicates-default",
  "events-default",
  "health-default",
  "validate-counts",
  "search-inline-default",
  "search-inline-json",
  "context-intent-orient",
  "get-intent-inspect",
  "list-intent-triage",
  "next-intent-execute",
  "search-intent-discover",
];

function manifestForBudget(maxBytes: number): string {
  const answerCommands = new Map<string, string>([
    ["list-default", "list"],
    ["list-open-default", "list"],
    ["list-json", "list"],
    ["get-default", "get"],
    ["get-json-compact-fields", "get"],
    ["context-default", "context"],
    ["next-default", "next"],
    ["activity-default", "activity"],
    ["stats-default", "stats"],
    ["deps-tree-default", "deps"],
    ["deps-tree-json", "deps"],
    ["graph-audit-summary", "graph"],
    ["duplicates-default", "duplicates"],
    ["events-default", "events"],
    ["health-default", "health"],
    ["validate-counts", "validate"],
    ["search-inline-default", "search"],
    ["search-inline-json", "search"],
    ["context-intent-orient", "context"],
    ["get-intent-inspect", "get"],
    ["list-intent-triage", "list"],
    ["next-intent-execute", "next"],
    ["search-intent-discover", "search"],
  ]);
  return JSON.stringify({
    version: 2,
    metric: "utf8_bytes",
    token_estimate: "ceil(bytes / 4)",
    fixture: "test",
    budgets: CORPUS_IDS.map((id) => {
      const command = answerCommands.get(id);
      return {
        id,
        args: [id],
        kind: command ? "answer" : "discovery",
        scale_tier: command ? "medium" : "static",
        baseline_bytes: 1,
        baseline_estimated_tokens: 1,
        ...(command
          ? { command, contract_max_estimated_tokens: 4_000 }
          : { max_bytes: maxBytes, max_estimated_tokens: maxBytes }),
      };
    }),
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
  if (joined.includes("Scale fixture")) {
    return JSON.stringify({ id: "pm-scale" });
  }
  if (joined.includes("comments pm-child")) {
    return JSON.stringify({ id: "pm-child" });
  }
  if (joined.includes("init --defaults --json")) {
    return JSON.stringify({ ok: true });
  }
  if (joined.includes("contracts --command")) {
    return JSON.stringify({
      command_summaries: [{ default_max_estimated_tokens: 4_000 }],
    });
  }
  if (joined.includes("activity --json --full --unbounded")) {
    return "x".repeat(20_000);
  }
  if (joined.includes("--for") && joined.includes("--token-budget 256")) {
    return JSON.stringify({
      context_intent: {
        declaration_feasible: false,
        result_omitted: true,
        within_budget: false,
        estimated_tokens: 280,
        token_budget: 256,
      },
    });
  }
  if (joined.includes("--for")) {
    return JSON.stringify({
      context_intent: {
        declaration_feasible: true,
        result_omitted: false,
        within_budget: true,
        estimated_tokens: 100,
        token_budget: 1_200,
      },
    });
  }
  return `output for ${joined}`;
}

function mockRuntime(
  options: {
    exists?: (targetPath: string) => boolean;
    manifestText?: string;
    stdout?: (args: string[]) => string;
  } = {},
): {
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  cleanupTempRoot: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
} {
  const readFileSync = vi.fn(
    () => options.manifestText ?? manifestForBudget(10_000),
  );
  const writeFileSync = vi.fn();
  const cleanupTempRoot = vi.fn();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    return {
      ...actual,
      existsSync: (targetPath: string) =>
        options.exists ? options.exists(targetPath) : true,
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
    const actual = await vi.importActual<Record<string, unknown>>(
      "../../../../scripts/release/utils.mjs",
    );
    return {
      ...actual,
      repoRoot: "/repo",
      runCommand,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
  vi.doMock("../../../../scripts/smoke-cleanup.mjs", () => ({
    cleanupTempRoot,
  }));
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

    expect(mod.measureOutput("abcd")).toEqual({
      bytes: 4,
      estimated_tokens: 1,
      lines: 1,
    });
    expect(mod.measureOutput("abcde")).toEqual({
      bytes: 5,
      estimated_tokens: 2,
      lines: 1,
    });
    expect(mod.measureOutput("é")).toEqual({
      bytes: 2,
      estimated_tokens: 1,
      lines: 1,
    });
    expect(mod.measureOutput("one\ntwo\n")).toEqual({
      bytes: 8,
      estimated_tokens: 2,
      lines: 2,
    });
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
      kind: "discovery",
      scale_tier: "static",
      baseline_bytes: 101,
      baseline_estimated_tokens: 26,
      max_bytes: 112,
      max_estimated_tokens: 29,
    });

    expect(
      mod.budgetForMeasurement(
        {
          ...measurement,
          kind: "answer",
          scale_tier: "medium",
          command: "context",
          contract_max_estimated_tokens: 4_000,
        },
        1.1,
      ),
    ).toEqual({
      id: "context-default",
      args: ["context", "--limit", "5"],
      kind: "answer",
      scale_tier: "medium",
      baseline_bytes: 101,
      baseline_estimated_tokens: 26,
      command: "context",
      contract_max_estimated_tokens: 4_000,
      max_bytes: 112,
      max_estimated_tokens: 29,
    });
  });

  it("reads compact and legacy mutation ids and rejects missing ids", async () => {
    mockRuntime();
    const mod = await loadModule();

    expect(mod.mutationId({ id: "pm-compact" }, "compact")).toBe("pm-compact");
    expect(mod.mutationId({ item: { id: "pm-legacy" } }, "legacy")).toBe(
      "pm-legacy",
    );
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
      version: 3,
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
      version: 2,
      metric: "utf8_bytes",
      token_estimate: "ceil(bytes / 4)",
      fixture: "test",
      budgets: [
        {
          id: "root-help",
          args: ["--help"],
          kind: "discovery",
          scale_tier: "static",
          baseline_bytes: 9,
          baseline_estimated_tokens: 3,
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
          kind: "discovery",
          bytes: 12,
          estimated_tokens: 3,
        },
        {
          id: "context-default",
          args: ["context"],
          kind: "discovery",
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

    expect(
      mod.compareBudgets(
        [
          {
            id: "stats-default",
            args: ["stats"],
            kind: "answer",
            command: "stats",
            contract_max_estimated_tokens: 4_000,
            bytes: 500,
            estimated_tokens: 125,
            lines: 23,
          },
        ],
        {
          ...manifest,
          budgets: [
            {
              id: "stats-default",
              args: ["stats"],
              kind: "answer",
              scale_tier: "medium",
              baseline_bytes: 480,
              baseline_estimated_tokens: 120,
              baseline_lines: 22,
              max_lines: 22,
              command: "stats",
              contract_max_estimated_tokens: 4_000,
            },
          ],
        },
      ),
    ).toEqual([
      "stats-default: 23 lines exceeds screen ceiling 22 lines (stats)",
    ]);

    expect(
      mod.compareBudgets(
        [
          {
            id: "context-answer",
            args: ["context"],
            kind: "answer",
            command: "context",
            contract_max_estimated_tokens: 4,
            bytes: 20,
            estimated_tokens: 5,
          },
        ],
        {
          ...manifest,
          budgets: [
            {
              id: "context-answer",
              args: ["context"],
              kind: "answer",
              scale_tier: "medium",
              baseline_bytes: 16,
              baseline_estimated_tokens: 4,
              command: "context",
              contract_max_estimated_tokens: 4,
            },
          ],
        },
      ),
    ).toEqual([
      "context-answer: 5 estimated tokens exceeds context contract 4 tokens (context)",
    ]);

    expect(
      mod.compareBudgets(
        [
          {
            id: "context-intent",
            args: ["context", "--for", "orient"],
            kind: "answer",
            command: "context",
            contract_max_estimated_tokens: 4_000,
            bytes: 400,
            estimated_tokens: 100,
            intent: true,
            intent_receipt: {
              declaration_feasible: false,
              result_omitted: true,
              within_budget: false,
              estimated_tokens: 100,
              token_budget: 2_400,
            },
          },
        ],
        {
          ...manifest,
          budgets: [
            {
              id: "context-intent",
              args: ["context", "--for", "orient"],
              kind: "answer",
              scale_tier: "medium",
              baseline_bytes: 400,
              baseline_estimated_tokens: 100,
              command: "context",
              contract_max_estimated_tokens: 4_000,
            },
          ],
        },
      ),
    ).toEqual([
      "context-intent: intent receipt did not prove a feasible delivered result (context --for orient)",
    ]);

    const intentManifest = {
      ...manifest,
      budgets: [
        {
          id: "context-intent",
          args: ["context", "--for", "orient"],
          kind: "answer",
          scale_tier: "medium",
          baseline_bytes: 400,
          baseline_estimated_tokens: 100,
          command: "context",
          contract_max_estimated_tokens: 4_000,
        },
      ],
    };
    for (const intentReceipt of [
      {
        declaration_feasible: true,
        result_omitted: false,
        within_budget: true,
        estimated_tokens: "100",
        token_budget: 2_400,
      },
      {
        declaration_feasible: true,
        result_omitted: false,
        within_budget: true,
        estimated_tokens: 100,
        token_budget: Number.NaN,
      },
    ]) {
      expect(
        mod.compareBudgets(
          [
            {
              id: "context-intent",
              args: ["context", "--for", "orient"],
              kind: "answer",
              command: "context",
              contract_max_estimated_tokens: 4_000,
              bytes: 400,
              estimated_tokens: 100,
              intent: true,
              intent_receipt: intentReceipt,
            },
          ],
          intentManifest,
        ),
      ).toEqual([
        "context-intent: intent receipt did not prove a feasible delivered result (context --for orient)",
      ]);
    }

    expect(
      mod.compareBudgets(
        [
          {
            id: "context-intent",
            args: ["context", "--for", "orient"],
            kind: "answer",
            command: "context",
            contract_max_estimated_tokens: 4_000,
            bytes: 10_000,
            estimated_tokens: 2_500,
            intent: true,
            intent_receipt: {
              declaration_feasible: true,
              result_omitted: false,
              within_budget: true,
              estimated_tokens: 100,
              token_budget: 2_400,
            },
          },
        ],
        intentManifest,
      ),
    ).toEqual([
      "context-intent: intent receipt did not prove a feasible delivered result (context --for orient)",
    ]);
  });

  it("runs direct update mode against a deterministic fixture corpus", async () => {
    const runtime = mockRuntime();
    const scriptPath = path.join(
      process.cwd(),
      "scripts/release/token-budget-gate.mjs",
    );
    process.argv = [
      "node",
      scriptPath,
      "--update",
      "--manifest",
      "/repo/budgets.json",
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env.PM_TOKEN_BUDGET_SENTINEL = "kept";

    await harness.importModule<TokenBudgetGateModule>(
      "scripts/release/token-budget-gate.mjs",
    );

    expect(runtime.runCommand).toHaveBeenCalledTimes(73);
    const runOptions = runtime.runCommand.mock.calls[0]?.[2] as
      | { env?: Record<string, string | undefined> }
      | undefined;
    expect(runOptions?.env).toMatchObject({
      PM_AUTHOR: "token-budget-gate",
      PM_GLOBAL_PATH: path.join("/tmp/pm-token-budget-test", ".global-pm"),
      PM_PATH: path.join("/tmp/pm-token-budget-test", ".agents", "pm"),
      PM_TOKEN_BUDGET_SENTINEL: "kept",
    });
    expect(runtime.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      String(runtime.writeFileSync.mock.calls[0]?.[1]),
    ) as TokenBudgetManifest;
    expect(written.budgets.map((entry) => entry.id)).toEqual(CORPUS_IDS);
    expect(runtime.cleanupTempRoot).toHaveBeenCalledWith(
      "/tmp/pm-token-budget-test",
    );
    expect(log).toHaveBeenCalledWith(
      "Updated token budget manifest: budgets.json",
    );
  });

  it("passes budget check mode with a checked manifest", async () => {
    mockRuntime({ manifestText: manifestForBudget(10_000) });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mod = await loadModule();

    mod.main();

    expect(log).toHaveBeenCalledWith(
      "Token budget gate passed (29 surfaces checked; unbounded negative control 5000 tokens; infeasible intent receipt verified).",
    );
  });

  it("uses the default manifest path for a bare manifest flag", async () => {
    const runtime = mockRuntime({ manifestText: manifestForBudget(10_000) });
    process.argv = ["node", "vitest", "--manifest"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const mod = await loadModule();

    mod.main();

    expect(runtime.readFileSync.mock.calls[0]?.[0]).toBe(
      path.join("/repo", "scripts", "release", "token-budgets.json"),
    );
    expect(log).toHaveBeenCalledWith(
      "Token budget gate passed (29 surfaces checked; unbounded negative control 5000 tokens; infeasible intent receipt verified).",
    );
  });

  it("fails for invalid headroom", async () => {
    mockRuntime();
    process.argv = ["node", "vitest", "--headroom", "0"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "FAIL:1:--headroom must be a finite number >= 1",
    );
  });

  it("fails when the built CLI is missing", async () => {
    mockRuntime({
      exists: (targetPath) => path.basename(targetPath) !== "cli.js",
    });
    process.argv = ["node", "vitest"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Built CLI not found",
    );
  });

  it("fails when the token budget manifest is missing", async () => {
    const runtime = mockRuntime({
      exists: (targetPath) => !targetPath.endsWith("budgets.json"),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest missing",
    );
    expect(runtime.runCommand).not.toHaveBeenCalled();
  });

  it("fails when a measured surface exceeds its budget", async () => {
    mockRuntime({ manifestText: manifestForBudget(1) });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget gate failed",
    );
  });

  it("fails when the token budget manifest shape is malformed", async () => {
    mockRuntime({ manifestText: "{}" });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: expected a top-level budgets array",
    );
  });

  it("fails when a token budget entry is malformed", async () => {
    mockRuntime({
      manifestText: JSON.stringify({ budgets: [{ id: "", max_bytes: -1 }] }),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: each entry requires an id, kind, and its discovery or answer ceiling",
    );

    mockRuntime({
      manifestText: JSON.stringify({
        budgets: [
          {
            id: "stats-default",
            kind: "answer",
            command: "stats",
            contract_max_estimated_tokens: 4_000,
            max_bytes: 500,
            max_lines: 0,
          },
        ],
      }),
    });
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: each entry requires an id, kind, and its discovery or answer ceiling",
    );
  });

  it("measures empty and multiline output with exact screen lines", async () => {
    const mod = await loadModule();
    expect(mod.measureOutput("")).toEqual({
      bytes: 0,
      estimated_tokens: 0,
      lines: 0,
    });
    expect(mod.measureOutput("one\ntwo\n").lines).toBe(2);
  });

  it("fails closed for malformed answer contract manifest entries", async () => {
    mockRuntime({
      manifestText: JSON.stringify({
        budgets: [
          {
            id: "answer",
            kind: "answer",
            command: 1,
            contract_max_estimated_tokens: "none",
          },
        ],
      }),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget manifest is malformed: each entry requires an id, kind, and its discovery or answer ceiling",
    );

    const mod = await loadModule();
    const baseBudget = {
      id: "answer",
      args: ["stats"],
      kind: "answer" as const,
      scale_tier: "medium",
      baseline_bytes: 500,
      baseline_estimated_tokens: 125,
      command: "stats",
      contract_max_estimated_tokens: 4_000,
      max_bytes: 500,
    };
    for (const budget of [
      { ...baseBudget, max_lines: 0 },
      { ...baseBudget, max_bytes: undefined },
      { ...baseBudget, max_bytes: -1 },
    ]) {
      expect(() =>
        mod.compareBudgets([], {
          version: 3,
          metric: "utf8_bytes",
          token_estimate: "ceil(bytes / 4)",
          fixture: "test",
          budgets: [budget],
        }),
      ).toThrow(
        "Token budget manifest is malformed: each entry requires an id, kind, and its discovery or answer ceiling",
      );
    }
  });

  it("fails when the unbounded negative control no longer exceeds the default contract", async () => {
    mockRuntime({
      manifestText: manifestForBudget(10_000),
      stdout: (args) =>
        args.join(" ").includes("activity --json --full --unbounded")
          ? "bounded"
          : commandStdout(args),
    });
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "negative-control: explicit unbounded activity",
    );
  });

  it("fails when the infeasible intent control claims success", async () => {
    mockRuntime({
      manifestText: manifestForBudget(10_000),
      stdout: (args) =>
        args.join(" ").includes("--for triage --token-budget 256")
          ? JSON.stringify({
              context_intent: {
                declaration_feasible: true,
                result_omitted: false,
                within_budget: true,
              },
            })
          : commandStdout(args),
    });
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "intent-negative-control: infeasible 256-token list declaration",
    );
  });

  it("fails when an answer command has no declared contract ceiling", async () => {
    mockRuntime({
      manifestText: manifestForBudget(10_000),
      stdout: (args) =>
        args.join(" ").includes("contracts --command")
          ? JSON.stringify({
              command_summaries: [{ default_max_estimated_tokens: null }],
            })
          : commandStdout(args),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];
    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget contract missing for answer command",
    );
  });

  it("fails when a fixture command expected to be JSON returns malformed output", async () => {
    mockRuntime({
      stdout: (args) =>
        args.join(" ").includes("Alpha planning context")
          ? "not json"
          : commandStdout(args),
    });
    process.argv = ["node", "vitest", "--manifest", "/repo/budgets.json"];

    await expect(loadModule().then((mod) => mod.main())).rejects.toThrow(
      "Token budget fixture command did not return JSON",
    );
  });
});
