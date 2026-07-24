import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceMutationGuardPreflight } from "../../../src/cli/migration-gates.js";
import { _testOnly as mcpTestOnly } from "../../../src/mcp/server.js";
import { runInit } from "../../../src/sdk/index.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/sdk/runtime-primitives.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
  );
});

async function initializedTracker(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guard-adapter-"));
  tempRoots.push(tempRoot);
  const pmRoot = path.join(tempRoot, ".agents", "pm");
  await runInit(
    undefined,
    { path: pmRoot },
    { defaults: true, agentGuidance: "skip" },
  );
  const settings = await readSettings(pmRoot);
  settings.mutation_guard.secret_guard = "advise";
  await writeSettings(pmRoot, settings, "test:mutation-guard-settings");
  return pmRoot;
}

describe("CLI and MCP mutation guard adapters", () => {
  it("keeps reads and uninitialized init calls behavior-compatible", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-guard-empty-"));
    tempRoots.push(tempRoot);
    await expect(
      enforceMutationGuardPreflight(
        "search",
        [],
        { query: "ghp_123456789012345678901234567890" },
        {},
        path.join(tempRoot, ".agents", "pm"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceMutationGuardPreflight(
        "schema",
        ["add"],
        {},
        {},
        path.join(tempRoot, ".agents", "pm"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      mcpTestOnly.collectMutationGuardWarnings("pm_run", "init", {
        cwd: tempRoot,
      }),
    ).resolves.toEqual([]);
  });

  it("emits redacted CLI advice and structured MCP warnings", async () => {
    const pmRoot = await initializedTracker();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await enforceMutationGuardPreflight(
      "create",
      [],
      {
        title: "Credential",
        description: "token=AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      },
      { author: "agent" },
      pmRoot,
    );
    expect(stderr).toHaveBeenCalledWith(
      "warning:secret_guard_detected:1:rules=high_entropy_assignment\n",
    );
    await expect(
      enforceMutationGuardPreflight(
        "copy",
        [],
        {},
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceMutationGuardPreflight(
        "schema",
        ["add"],
        {},
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
    await expect(
      mcpTestOnly.collectMutationGuardWarnings("pm_run", "create", {
        path: pmRoot,
        author: "agent",
        title: "Credential",
        description: "ghp_123456789012345678901234567890",
      }),
    ).resolves.toEqual(["secret_guard_detected:1:rules=github_token"]);
    await expect(
      mcpTestOnly.collectMutationGuardWarnings("pm_search", "search", {
        path: pmRoot,
        query: "ghp_123456789012345678901234567890",
      }),
    ).resolves.toEqual([]);
  });

  it("redacts blocked values from CLI recovery bundles even with explain enabled", async () => {
    const pmRoot = await initializedTracker();
    const settings = await readSettings(pmRoot);
    settings.mutation_guard.secret_guard = "block";
    await writeSettings(pmRoot, settings, "test:blocking-secret-guard");
    const credential = "ghp_123456789012345678901234567890";
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "--json",
        "--explain",
        "create",
        "--title",
        "Credential",
        "--description",
        credential,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PM_PATH: pmRoot,
          PM_AUTHOR: "agent",
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(credential);
    const error = JSON.parse(result.stderr) as {
      recovery?: {
        attempted_command?: string;
        normalized_args?: string[];
        suggested_retry?: string;
      };
    };
    expect(error.recovery).toEqual({
      recovery_mode: "compact",
      attempted_command: "pm <mutation> [REDACTED]",
      normalized_args: ["[REDACTED]"],
      provided_fields: ["--json", "--explain", "--title", "--description"],
      suggested_retry:
        "Remove credential-shaped content, then retry the mutation.",
    });
  });

  it("advises when update moves an unclaimed item into active work", async () => {
    const pmRoot = await initializedTracker();
    const environment = {
      ...process.env,
      PM_PATH: pmRoot,
      PM_AUTHOR: "agent",
    };
    const created = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "--json",
        "create",
        "--title",
        "Unclaimed work",
        "--type",
        "Task",
        "--status",
        "open",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(created.status).toBe(0);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await enforceMutationGuardPreflight(
      "update",
      [id],
      { status: "in-progress" },
      { author: "agent" },
      pmRoot,
    );
    expect(stderr).toHaveBeenCalledWith(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}\n`,
    );
    stderr.mockClear();
    await enforceMutationGuardPreflight(
      "update",
      [id],
      { status: "in_progress", assignee: "agent" },
      { author: "agent" },
      pmRoot,
    );
    expect(stderr).not.toHaveBeenCalled();
    await enforceMutationGuardPreflight(
      "update",
      [id],
      { status: "in_progress", assignee: "none" },
      { author: "agent" },
      pmRoot,
    );
    expect(stderr).toHaveBeenCalledWith(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}\n`,
    );
    stderr.mockRestore();

    const unclaimed = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "update",
        id,
        "--status",
        "in_progress",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(unclaimed.status).toBe(0);
    expect(unclaimed.stderr).toContain(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}`,
    );

    const assigned = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "update",
        id,
        "--status",
        "in_progress",
        "--assignee",
        "agent",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(assigned.status).toBe(0);
    expect(assigned.stderr).not.toContain("in_progress_item_unclaimed");
    const assignedStderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await enforceMutationGuardPreflight(
      "update",
      [id],
      { status: "in_progress" },
      { author: "agent" },
      pmRoot,
    );
    expect(assignedStderr).not.toHaveBeenCalled();
    assignedStderr.mockRestore();

    const stillAssigned = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "update",
        id,
        "--status",
        "in_progress",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(stillAssigned.status).toBe(0);
    expect(stillAssigned.stderr).not.toContain("in_progress_item_unclaimed");

    const released = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "update",
        id,
        "--status",
        "in_progress",
        "--assignee",
        "none",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(released.status).toBe(0);
    expect(released.stderr).toContain(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}`,
    );

    const jsonUpdate = spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "--json",
        "update",
        id,
        "--status",
        "in_progress",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(jsonUpdate.status).toBe(0);
    expect(jsonUpdate.stderr).not.toContain("in_progress_item_unclaimed");
    expect(() => JSON.parse(jsonUpdate.stdout)).not.toThrow();
    await expect(
      enforceMutationGuardPreflight(
        "update",
        [id],
        { status: "in_progress" },
        { author: "agent", json: true },
        pmRoot,
      ),
    ).resolves.toBeUndefined();

    await expect(
      enforceMutationGuardPreflight(
        "update",
        [],
        { status: "in_progress" },
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceMutationGuardPreflight(
        "update",
        ["pm-missing"],
        { status: "in_progress" },
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceMutationGuardPreflight(
        "update",
        [id],
        { status: "open" },
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceMutationGuardPreflight(
        "update",
        [id],
        {},
        { author: "agent" },
        pmRoot,
      ),
    ).resolves.toBeUndefined();
  });
});
