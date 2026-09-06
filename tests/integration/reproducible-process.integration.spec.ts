import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliPath = path.join(repoRoot, "dist", "cli.js");
const mcpPath = path.join(repoRoot, "dist", "mcp", "server.js");
const CLOCK = "2026-08-22T12:00:00.000Z";
const PROCESS_TIMEOUT_MS = 30_000;

const temporaryRoots: string[] = [];

/** Pin entropy and clock while disabling external telemetry and model discovery. */
function processEnvironment(
  seed = "process-conformance-seed",
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PM_PATH: undefined,
    PM_CLOCK: CLOCK,
    PM_CLOCK_TICK_MS: "1",
    PM_MCP_PROFILE: "full",
    PM_AGENT_PROBES: "0",
    PM_SEED: seed,
    PM_TELEMETRY_DISABLED: "1",
    PM_TELEMETRY_OTEL_DISABLED: "1",
    PM_TELEMETRY_PROMPT: "0",
    PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
  };
}

async function createTrackerRoot(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pm-repro-process-"));
  temporaryRoots.push(workspace);
  return path.join(workspace, ".agents", "pm");
}

/** Run the built CLI against its fixture while preserving deliberately conflicting ambient discovery. */
function runCli(
  pmRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv = processEnvironment(),
) {
  return spawnSync(process.execPath, [cliPath, "--pm-path", pmRoot, ...args], {
    cwd: path.dirname(path.dirname(pmRoot)),
    encoding: "utf8",
    env: {
      ...env,
      PM_PATH: env.PM_PATH ?? pmRoot,
      PM_GLOBAL_PATH: path.join(
        path.dirname(path.dirname(pmRoot)),
        ".global-pm",
      ),
    },
    timeout: PROCESS_TIMEOUT_MS,
  });
}

function processDiagnostics(result: {
  error?: Error;
  stdout?: unknown;
  stderr?: unknown;
}): string {
  return JSON.stringify({
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function initializeTracker(pmRoot: string, env = processEnvironment()): void {
  const result = runCli(pmRoot, ["init", "--yes"], env);
  expect(result.status, processDiagnostics(result)).toBe(0);
}

async function authoritativeSnapshot(
  pmRoot: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const folder of ["tasks", "history"]) {
    const folderPath = path.join(pmRoot, folder);
    const entries = (await readdir(folderPath)).sort();
    for (const entry of entries) {
      snapshot[`${folder}/${entry}`] = await readFile(
        path.join(folderPath, entry),
        "utf8",
      );
    }
  }
  return snapshot;
}

function createCliFixture(
  pmRoot: string,
  title: string,
  env = processEnvironment(),
): string {
  const result = runCli(
    pmRoot,
    [
      "create",
      "--title",
      title,
      "--description",
      "Process-level reproducibility fixture",
      "--type",
      "Task",
      "--author",
      "reproducibility-gate",
      "--json",
    ],
    env,
  );
  expect(result.status, processDiagnostics(result)).toBe(0);
  const payload = JSON.parse(result.stdout) as { id?: string };
  expect(payload.id).toMatch(/^pm-/);
  return payload.id ?? "";
}

/** Execute the real stdio handshake and mutations without inheriting another tracker's work context. */
function runMcpFixture(pmRoot: string, env = processEnvironment()) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "reproducibility-gate", version: "1.0.0" },
      },
    },
    ...[2, 3].map((id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "pm_create",
        arguments: {
          path: pmRoot,
          options: {
            title: `MCP deterministic fixture ${id}`,
            description: "Process-level reproducibility fixture",
            type: "Task",
            author: "reproducibility-gate",
          },
        },
      },
    })),
  ];
  return spawnSync(process.execPath, [mcpPath], {
    cwd: path.dirname(path.dirname(pmRoot)),
    encoding: "utf8",
    env: {
      ...env,
      PM_PATH: env.PM_PATH ?? pmRoot,
      PM_GLOBAL_PATH: path.join(
        path.dirname(path.dirname(pmRoot)),
        ".global-pm",
      ),
    },
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: PROCESS_TIMEOUT_MS,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("reproducible process transport contract", () => {
  it("makes independent CLI process runs byte-identical and preserves seed sensitivity", async () => {
    const firstRoot = await createTrackerRoot();
    const secondRoot = await createTrackerRoot();
    for (const pmRoot of [firstRoot, secondRoot]) {
      initializeTracker(pmRoot);
      const closeTarget = createCliFixture(
        pmRoot,
        "CLI deterministic fixture one",
        processEnvironment("cli-step-one"),
      );
      createCliFixture(
        pmRoot,
        "CLI deterministic fixture two",
        processEnvironment("cli-step-two"),
      );
      const closeResult = runCli(
        pmRoot,
        [
          "close",
          closeTarget,
          "Reproducible process close",
          "--author",
          "reproducibility-gate",
          "--message",
          "Close deterministic fixture",
          "--json",
        ],
        processEnvironment("cli-close"),
      );
      expect(closeResult.status, processDiagnostics(closeResult)).toBe(0);
      const closedResult = runCli(pmRoot, [
        "get",
        closeTarget,
        "--json",
        "--full",
      ]);
      expect(closedResult.status, processDiagnostics(closedResult)).toBe(0);
      const closedPayload = JSON.parse(closedResult.stdout) as {
        item?: { closed_at?: string; completed_at?: string };
      };
      expect(closedPayload.item?.closed_at).toMatch(
        /^2026-08-22T12:00:00\.\d{3}Z$/,
      );
      expect(closedPayload.item?.completed_at).toBe(
        closedPayload.item?.closed_at,
      );
    }

    expect(await authoritativeSnapshot(firstRoot)).toEqual(
      await authoritativeSnapshot(secondRoot),
    );

    const differentSeedRoot = await createTrackerRoot();
    initializeTracker(differentSeedRoot);
    createCliFixture(
      differentSeedRoot,
      "CLI deterministic fixture one",
      processEnvironment("different-seed"),
    );
    createCliFixture(
      differentSeedRoot,
      "CLI deterministic fixture two",
      processEnvironment("cli-step-two"),
    );
    expect(await authoritativeSnapshot(differentSeedRoot)).not.toEqual(
      await authoritativeSnapshot(firstRoot),
    );
  });

  it.each(["CLI", "MCP"])("makes independent %s runs byte-identical despite conflicting ambient claims", async (transport) => {
    const firstRoot = await createTrackerRoot();
    const secondRoot = await createTrackerRoot();
    const ambientRoot = await createTrackerRoot();
    initializeTracker(ambientRoot);
    for (const [index, pmRoot] of [firstRoot, secondRoot].entries()) {
      const ambientEnvironment = {
        ...processEnvironment(`ambient-workset-${index}`),
        PM_PATH: ambientRoot,
      };
      const ambientId = createCliFixture(
        ambientRoot,
        `Unrelated work ${index}`,
        ambientEnvironment,
      );
      const claimed = runCli(
        ambientRoot,
        ["claim", ambientId],
        ambientEnvironment,
      );
      expect(claimed.status, processDiagnostics(claimed)).toBe(0);
      initializeTracker(pmRoot);
      if (transport === "CLI") {
        createCliFixture(pmRoot, "CLI explicit tracker fixture", {
          ...processEnvironment(),
          PM_PATH: ambientRoot,
        });
        continue;
      }
      const result = runMcpFixture(pmRoot, {
        ...processEnvironment(),
        PM_PATH: ambientRoot,
      });
      expect(result.status, processDiagnostics(result)).toBe(0);
      const responses = result.stdout
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: unknown;
              result?: { isError?: boolean };
            },
        );
      expect(responses).toHaveLength(3);
      expect(responses.every((response) => response.error === undefined)).toBe(
        true,
      );
      expect(
        responses
          .slice(1)
          .every((response) => response.result?.isError !== true),
      ).toBe(true);
    }

    expect(await authoritativeSnapshot(firstRoot)).toEqual(
      await authoritativeSnapshot(secondRoot),
    );
  });

  it("fails closed with typed CLI and MCP recovery when opt-in is incomplete", async () => {
    const partialEnvironment = processEnvironment();
    delete partialEnvironment.PM_SEED;
    delete partialEnvironment.PM_CLOCK_TICK_MS;
    const partialRoot = await createTrackerRoot();

    const cliResult = spawnSync(
      process.execPath,
      [cliPath, "--json", "--version"],
      {
        cwd: path.dirname(path.dirname(partialRoot)),
        encoding: "utf8",
        env: partialEnvironment,
        timeout: PROCESS_TIMEOUT_MS,
      },
    );
    expect(cliResult.status, processDiagnostics(cliResult)).toBe(2);
    expect(JSON.parse(cliResult.stderr)).toMatchObject({
      code: "invalid_reproducible_process_environment",
      exit_code: 2,
      recovery: { missing_required_fields: ["PM_SEED"] },
    });

    const mcpResult = runMcpFixture(partialRoot, partialEnvironment);
    expect(mcpResult.status, processDiagnostics(mcpResult)).toBe(0);
    const firstResponse = JSON.parse(mcpResult.stdout.split("\n")[0]) as {
      error?: { code?: number; data?: { code?: string; recovery?: unknown } };
    };
    expect(firstResponse.error).toMatchObject({
      code: 2,
      data: {
        code: "invalid_reproducible_process_environment",
        recovery: { missing_required_fields: ["PM_SEED"] },
      },
    });
  });
});
