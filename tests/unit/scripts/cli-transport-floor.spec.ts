import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCliTransportFloorBudgets,
  buildCliTransportFloorReport,
  compareCliTransportFloorBudgets,
  main,
  renderCliTransportFloorMarkdown,
  runEntrypoint,
} from "../../../scripts/bench/cli-transport-floor.mjs";

const temporaryRoots: string[] = [];

function report() {
  const operation = {
    runs: 3,
    min_ms: 250,
    p50_ms: 270,
    p95_ms: 300,
    max_ms: 300,
    max_peak_rss_bytes: 1000,
    max_output_bytes: 100,
    max_estimated_tokens: 25,
  };
  return {
    schema_version: 1,
    node_version: "v26.5.0",
    platform: "linux",
    architecture: "x64",
    workspace_items_at_start: 1,
    iterations: 3,
    operations: {
      get: { ...operation },
      list: { ...operation },
      context: { ...operation },
      next: { ...operation },
      create: { ...operation },
      claim: { ...operation },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI transport-floor benchmark", () => {
  it("measures all required operations on isolated one-item workspaces", async () => {
    const commands: string[] = [];
    const result = await buildCliTransportFloorReport({
      iterations: 1,
      measure: async (
        args: string[],
        environment: { workspaceRoot: string },
      ) => {
        commands.push(args[0] ?? "");
        const fixture = JSON.parse(
          await readFile(
            path.join(environment.workspaceRoot, ".pm-scale-fixture.json"),
            "utf8",
          ),
        ) as { item_count: number };
        expect(fixture.item_count).toBe(1);
        return {
          duration_ms: 100,
          peak_rss_bytes: 1000,
          output_bytes: 40,
          estimated_tokens: 10,
        };
      },
    });
    expect(Object.keys(result.operations)).toEqual([
      "get",
      "list",
      "context",
      "next",
      "create",
      "claim",
    ]);
    expect(commands).toHaveLength(12);
    expect(new Set(commands)).toEqual(
      new Set(["get", "list", "context", "next", "create", "claim"]),
    );
    await expect(
      buildCliTransportFloorReport({ iterations: 0 }),
    ).rejects.toThrow("between 1 and 20");
    const defaultIterations = await buildCliTransportFloorReport({
      measure: async () => ({
        duration_ms: 100,
        output_bytes: 10,
        estimated_tokens: 3,
      }),
    });
    expect(defaultIterations.iterations).toBe(3);
  });

  it("runs the default measurement and committed-budget path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-cli-real-floor-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "budgets.json");
    await writeFile(
      budgetPath,
      JSON.stringify({
        operations: Object.fromEntries(
          ["get", "list", "context", "next", "create", "claim"].map(
            (operation) => [
              operation,
              {
                max_latency_ms: 1_000_000,
                max_peak_rss_bytes: null,
              },
            ],
          ),
        ),
      }),
    );
    await expect(
      main(["--check", "--iterations", "1"], { budgetPath }),
    ).resolves.toMatchObject({ mode: "check", violations: [] });
  });

  it("builds ratchets and reports latency, RSS, and missing budgets", () => {
    const baseline = report();
    const budgets = buildCliTransportFloorBudgets(baseline, 1);
    expect(budgets.operations.get).toEqual({
      max_latency_ms: 250,
      max_peak_rss_bytes: 1000,
    });
    expect(compareCliTransportFloorBudgets(baseline, budgets)).toEqual([]);
    const regressed = structuredClone(baseline);
    regressed.operations.get.min_ms = 300;
    regressed.operations.get.max_peak_rss_bytes = 1200;
    delete budgets.operations.list;
    expect(compareCliTransportFloorBudgets(regressed, budgets)).toEqual(
      expect.arrayContaining([
        "get: best 300ms > 275ms",
        "get: peak RSS 1200 > 1000",
        "list: missing budget",
      ]),
    );
    regressed.operations.get.max_peak_rss_bytes = null;
    budgets.operations.get.max_peak_rss_bytes = null;
    expect(compareCliTransportFloorBudgets(regressed, budgets)).not.toContain(
      expect.stringContaining("peak RSS"),
    );
    expect(
      buildCliTransportFloorBudgets(regressed).operations.get
        .max_peak_rss_bytes,
    ).toBeNull();
  });

  it("renders the measured floor and architecture attribution", () => {
    const markdown = renderCliTransportFloorMarkdown(report());
    expect(markdown).toContain("| `get` | 250 ms | 270 ms | 300 ms |");
    expect(markdown).toContain("exactly one item");
    expect(markdown).toContain("CLI-minus-SDK delta");
  });
});

describe("CLI transport-floor command", () => {
  it("writes and verifies custom budget and documentation paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-cli-floor-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "budgets", "floor.json");
    const documentationPath = path.join(root, "docs", "floor.md");
    const baseline = report();
    await expect(
      main(["--update"], {
        budgetPath,
        documentationPath,
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "update", violations: [] });
    expect(await readFile(documentationPath, "utf8")).toContain("`claim`");
    await expect(
      main(["--check"], {
        budgetPath,
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "check", violations: [] });
    await expect(
      main(["--check", "--iterations", "7"], {
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "check", violations: [] });
  });

  it("fails regressions and requires exactly one mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-cli-floor-fail-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "floor.json");
    const baseline = report();
    await main(["--update"], {
      budgetPath,
      documentationPath: path.join(root, "floor.md"),
      buildReport: async () => structuredClone(baseline),
    });
    const regressed = structuredClone(baseline);
    regressed.operations.get.min_ms = 999;
    await expect(
      main(["--check"], {
        budgetPath,
        buildReport: async () => regressed,
      }),
    ).rejects.toThrow("transport-floor gate failed");
    await expect(main([])).rejects.toThrow("Usage:");
    await expect(main(["--update", "--check"])).rejects.toThrow("Usage:");
  });

  it("executes, skips, and reports failures through the script entrypoint", async () => {
    const scriptPath = path.resolve("scripts/bench/cli-transport-floor.mjs");
    await expect(runEntrypoint(["node"])).resolves.toBe(false);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          mode: "update",
          report: { operations: { get: {} } },
        }),
      }),
    ).resolves.toBe(true);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          mode: "check",
          report: { operations: { get: {} } },
        }),
      }),
    ).resolves.toBe(true);
    const previousExitCode = process.exitCode;
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => {
          throw "entrypoint failure";
        },
      }),
    ).resolves.toBe(false);
    await expect(runEntrypoint(["node", scriptPath])).resolves.toBe(false);
    process.exitCode = previousExitCode;
  });
});
