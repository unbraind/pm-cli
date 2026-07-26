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
import { runInProcessDistCli } from "../../helpers/cliRunner.js";

const tempRoots: string[] = [];
const GITHUB_TOKEN_SAMPLE = ["gh", "p_", "123456789012345678901234567890"].join(
  "",
);
const NPM_TOKEN_SAMPLE = ["npm_", "A".repeat(36)].join("");
const SLACK_TOKEN_SAMPLE = [
  "xoxb-",
  "1234567890-",
  "1234567890-",
  "A".repeat(24),
].join("");

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
        { query: GITHUB_TOKEN_SAMPLE },
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
        description: NPM_TOKEN_SAMPLE,
      },
      { author: "agent" },
      pmRoot,
    );
    expect(stderr).toHaveBeenCalledWith(
      "warning:secret_guard_detected:1:rules=npm_token\n",
    );
    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining(NPM_TOKEN_SAMPLE),
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
        description: SLACK_TOKEN_SAMPLE,
      }),
    ).resolves.toEqual(["secret_guard_detected:1:rules=slack_token"]);
    await expect(
      mcpTestOnly.collectMutationGuardWarnings("pm_search", "search", {
        path: pmRoot,
        query: GITHUB_TOKEN_SAMPLE,
      }),
    ).resolves.toEqual([]);
  });

  it("redacts blocked values from CLI recovery bundles even with explain enabled", async () => {
    const pmRoot = await initializedTracker();
    const settings = await readSettings(pmRoot);
    settings.mutation_guard.secret_guard = "block";
    await writeSettings(pmRoot, settings, "test:blocking-secret-guard");
    const credential = GITHUB_TOKEN_SAMPLE;
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
    const created = await runInProcessDistCli(
      [
        "--json",
        "create",
        "--title",
        "Unclaimed work",
        "--type",
        "Task",
        "--status",
        "open",
      ],
      { env: environment, expectJson: true },
    );
    expect(created.status).toBe(0);
    const id = (created.json as { id: string }).id;
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

    const unclaimed = await runInProcessDistCli(
      ["update", id, "--status", "in_progress"],
      { env: environment },
    );
    expect(unclaimed.status).toBe(0);
    expect(unclaimed.stderr).toContain(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}`,
    );

    const assigned = await runInProcessDistCli(
      [
        "update",
        id,
        "--status",
        "in_progress",
        "--assignee",
        "agent",
      ],
      { env: environment },
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

    const stillAssigned = await runInProcessDistCli(
      ["update", id, "--status", "in_progress"],
      { env: environment },
    );
    expect(stillAssigned.status).toBe(0);
    expect(stillAssigned.stderr).not.toContain("in_progress_item_unclaimed");

    const released = await runInProcessDistCli(
      [
        "update",
        id,
        "--status",
        "in_progress",
        "--assignee",
        "none",
      ],
      { env: environment },
    );
    expect(released.status).toBe(0);
    expect(released.stderr).toContain(
      `warning:in_progress_item_unclaimed:${id}:claim_with=pm claim ${id}`,
    );

    const jsonUpdate = await runInProcessDistCli(
      [
        "--json",
        "update",
        id,
        "--status",
        "in_progress",
      ],
      { env: environment, expectJson: true },
    );
    expect(jsonUpdate.status).toBe(0);
    expect(jsonUpdate.stderr).not.toContain("in_progress_item_unclaimed");
    expect(jsonUpdate.json).toBeTypeOf("object");
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
