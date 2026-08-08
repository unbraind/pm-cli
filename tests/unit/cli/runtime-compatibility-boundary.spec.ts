import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeCompatibleCli } from "../../../src/cli/runtime-compatibility-boundary.js";
import { PmCliError } from "../../../src/sdk/runtime-primitives.js";

const newerPin = {
  devDependencies: { "@unbrained/pm-cli": "2026.8.9" },
};
const roots: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI runtime compatibility boundary", () => {
  it.each([
    [["--json", "create"], true],
    [["--output-format", "json", "create"], true],
    [["create"], false],
  ] as const)("renders stale mutation recovery for %j", async (argv, json) => {
    const writeError = vi.fn();
    const run = vi.fn();
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "pm-runtime-boundary-"),
    );
    roots.push(projectRoot);
    await writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(newerPin),
    );
    await runRuntimeCompatibleCli({
      executingVersion: "2026.8.7",
      projectRoot,
      argv,
      allowStale: false,
      run,
      writeError,
    });
    expect(process.exitCode).toBe(4);
    expect(run).not.toHaveBeenCalled();
    const rendered = String(writeError.mock.calls[0]?.[0]);
    if (json) {
      expect(JSON.parse(rendered)).toMatchObject({
        code: "project_runtime_stale_mutation",
        exit_code: 4,
      });
    } else {
      expect(rendered).toContain("cannot mutate a project pinned to newer pm");
    }
  });

  it("runs without a readable executable version and returns no exit code", async () => {
    const run = vi.fn(async () => undefined);
    await expect(
      runRuntimeCompatibleCli({
        projectRoot: "/missing",
        argv: ["create"],
        allowStale: false,
        run,
        writeError: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it("rethrows non-pm defects from deferred dispatch", async () => {
    const defect = new TypeError("bundle defect");
    await expect(
      runRuntimeCompatibleCli({
        projectRoot: "/missing",
        argv: ["context"],
        allowStale: false,
        run: async () => {
          throw defect;
        },
        writeError: vi.fn(),
      }),
    ).rejects.toBe(defect);
  });

  it("renders an SDK refusal raised by deferred dispatch", async () => {
    const writeError = vi.fn();
    await expect(
      runRuntimeCompatibleCli({
        projectRoot: "/missing",
        argv: ["--json", "context"],
        allowStale: false,
        run: async () => {
          throw new PmCliError("Deferred refusal", 2, {
            code: "invalid_command_usage",
            required: "Use a valid command.",
          });
        },
        writeError,
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(writeError.mock.calls[0]?.[0]))).toMatchObject({
      code: "invalid_command_usage",
      exit_code: 2,
    });
  });
});
