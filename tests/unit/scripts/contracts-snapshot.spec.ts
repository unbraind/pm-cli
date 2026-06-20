import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

interface ContractsSnapshotOptions {
  args: string[];
  cliExists?: boolean;
  spawnResult?: {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  snapshotReadResult?: string;
  snapshotReadError?: Error;
}

async function runContractsSnapshotScenario(options: ContractsSnapshotOptions) {
  process.argv = ["node", "scripts/contracts-snapshot.mjs", ...options.args];

  const existsSync = vi.fn(() => options.cliExists ?? true);
  const mkdtempSync = vi.fn(() => "/tmp/pm-cli-contracts-global-test");
  const rmSync = vi.fn();
  vi.doMock("node:fs", () => ({ existsSync, mkdtempSync, rmSync }));

  const mkdir = vi.fn(async () => undefined);
  const readFile = vi.fn(async () => {
    if (options.snapshotReadError) {
      throw options.snapshotReadError;
    }
    return options.snapshotReadResult ?? '{\n  "a": 1,\n  "b": 2\n}\n';
  });
  const writeFile = vi.fn(async () => undefined);
  vi.doMock("node:fs/promises", () => ({ mkdir, readFile, writeFile }));

  const spawnSync = vi.fn(() => ({
    status: "status" in (options.spawnResult ?? {}) ? options.spawnResult?.status : 0,
    stdout: "stdout" in (options.spawnResult ?? {}) ? options.spawnResult?.stdout : '{"b":2,"a":1}',
    stderr: "stderr" in (options.spawnResult ?? {}) ? options.spawnResult?.stderr : "",
    error: options.spawnResult?.error,
  }));
  vi.doMock("node:child_process", () => ({ spawnSync }));

  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    errors.push(String(value ?? ""));
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exitSpy = harness.mockProcessExit();

  let failure: unknown = null;
  try {
    await harness.importModule("scripts/contracts-snapshot.mjs", "contractsSnapshotScenario");
  } catch (error) {
    failure = error;
  }
  exitSpy.mockRestore();
  return { failure, logs, errors, existsSync, readFile, writeFile, mkdir, spawnSync };
}

describe("scripts/contracts-snapshot: mode and build guards", () => {
  it("requires --update or --check", async () => {
    const result = await runContractsSnapshotScenario({ args: [] });
    expect(String(result.failure ?? "")).toContain("EXIT:2");
    expect(result.errors.join("\n")).toContain("Usage: node scripts/contracts-snapshot.mjs --update|--check");
  });

  it("requires a built dist/cli.js", async () => {
    const result = await runContractsSnapshotScenario({ args: ["--check"], cliExists: false });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Missing dist/cli.js");
  });
});

describe("scripts/contracts-snapshot: check/update flows", () => {
  it("confirms a current snapshot on --check", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadResult: '{\n  "a": 1,\n  "b": 2\n}\n',
      spawnResult: { status: 0, stdout: '{"b":2,"a":1}' },
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain("Contract snapshot is current");
  });

  it("fails on a stale snapshot and reports the first differing line", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadResult: '{\n  "a": 1,\n  "b": 3\n}\n',
      spawnResult: { status: 0, stdout: '{"b":2,"a":1}' },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Contract snapshot is stale");
  });

  it("fails when the snapshot file is missing (ENOENT)", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadError: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Missing contracts snapshot");
  });

  it("writes the stable snapshot on --update", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--update"],
      spawnResult: { status: 0, stdout: '{"z":9,"a":1}' },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:0");
    expect(result.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(path.join("tests", "fixtures", "contracts", "full.json")),
      '{\n  "a": 1,\n  "z": 9\n}\n',
      "utf8",
    );
    expect(result.logs.join("\n")).toContain("Updated");
  });

  it("stably sorts nested arrays/objects on update (array map recursion)", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--update"],
      spawnResult: { status: 0, stdout: JSON.stringify({ list: [{ b: 2, a: 1 }, "leaf"], top: 1 }) },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:0");
    const written = String(result.writeFile.mock.calls.at(-1)?.[1] ?? "");
    expect(written.indexOf('"a"')).toBeLessThan(written.indexOf('"b"'));
    expect(written.indexOf('"list"')).toBeLessThan(written.indexOf('"top"'));
    expect(written).toContain('"leaf"');
  });
});

describe("scripts/contracts-snapshot: spawn and parse failures", () => {
  it("fails to start when spawn returns an error", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { error: new Error("spawn failed"), status: null, stdout: "", stderr: "" },
    });
    expect(String(result.failure ?? "")).toContain("failed to start");
  });

  it("fails with the exit code when the contracts subprocess exits non-zero", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { status: 4, stdout: "stdout text", stderr: "stderr text" },
    });
    expect(String(result.failure ?? "")).toContain("failed with exit code 4");
  });

  it("uses fallback defaults when spawn fails with undefined stdio and null status", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { status: null, stdout: undefined, stderr: undefined, error: undefined },
    });
    expect(String(result.failure ?? "")).toContain("failed with exit code unknown");
  });

  it("fails when the contracts subprocess emits invalid JSON", async () => {
    const result = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { status: 0, stdout: "not-json", stderr: "" },
    });
    expect(String(result.failure ?? "")).toContain("invalid JSON");
  });
});
