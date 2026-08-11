import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createAssuranceWorkspaceContext,
  type AssuranceProviderResolver,
} from "../../../src/sdk/governance/assurance-runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const execFileAsync = promisify(execFile);

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function withSeededWorkspace(
  test: (fixture: {
    pmPath: string;
    tempRoot: string;
    providers: Readonly<Record<string, AssuranceProviderResolver>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempPmPath(async (fixture) => {
    const previousCodexCi = process.env.CODEX_CI;
    const previousCodexModel = process.env.CODEX_MODEL;
    process.env.CODEX_CI = "1";
    process.env.CODEX_MODEL = "assurance-test-model";
    let created;
    try {
      created = await fixture.runCliInProcess(
        [
          "create",
          "--title",
          "Assurance runtime fixture",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
    } finally {
      restoreEnv("CODEX_CI", previousCodexCi);
      restoreEnv("CODEX_MODEL", previousCodexModel);
    }
    const plainCreated = await fixture.runCliInProcess(
      [
        "create",
        "--title",
        "Plain assurance history fixture",
        "--type",
        "Task",
        "--author",
        "runtime-test",
        "--json",
      ],
      { expectJson: true },
    );
    expect(created.code).toBe(0);
    expect(plainCreated.code).toBe(0);
    await test({
      pmPath: fixture.pmPath,
      tempRoot: fixture.tempRoot,
      providers: {
        coverage: async (source) => ({
          value: source.key === "labels" ? ["lines", "branches"] : 100,
          population_size: 1,
          cost: 1,
        }),
      },
    });
  });
}

describe("assurance workspace runtime", () => {
  it("builds authoritative item, history, status, and explicit-tree context", async () => {
    await withSeededWorkspace(async ({ pmPath, providers }) => {
      const context = await createAssuranceWorkspaceContext(pmPath, {
        tree_id: "fixture-tree",
        providers,
      });
      expect(context.tree_id).toBe("fixture-tree");
      expect(context.items).toHaveLength(2);
      expect(context.history.length).toBeGreaterThan(0);
      expect(context.history).toContainEqual(
        expect.objectContaining({ author: "runtime-test" }),
      );
      expect(context.terminal_statuses).toEqual(
        expect.arrayContaining(["closed", "canceled"]),
      );

      const itemOnly = await createAssuranceWorkspaceContext(pmPath, {
        include_history: false,
        resolve_tree: false,
      });
      expect(itemOnly).toMatchObject({ tree_id: "working-copy", history: [] });
    });
  });

  it("binds graph measurements to the shared graph SDK", async () => {
    await withSeededWorkspace(async ({ pmPath }) => {
      const context = await createAssuranceWorkspaceContext(pmPath);
      await expect(
        context.external({
          kind: "graph",
          operation: "audit",
          field: "profile.nodes",
        }),
      ).resolves.toMatchObject({ value: 2, population_size: 2 });
      await expect(
        context.external({
          kind: "graph",
          operation: "audit",
          field: "findings",
        }),
      ).rejects.toThrow("finite number or string array");
      await expect(
        context.external({
          kind: "graph",
          operation: "audit",
          field: "profile.missing",
        }),
      ).rejects.toThrow("finite number or string array");
      await expect(
        context.external({
          kind: "graph",
          operation: "audit",
          field: "missing.value",
        }),
      ).rejects.toThrow("is not present");
    });
  });

  it("binds validate and health measurements to shared SDK checks", async () => {
    await withSeededWorkspace(async ({ pmPath }) => {
      const brokenExtension = path.join(pmPath, "extensions", "broken");
      await mkdir(brokenExtension, { recursive: true });
      await writeFile(path.join(brokenExtension, "manifest.json"), "{", "utf8");
      const context = await createAssuranceWorkspaceContext(pmPath);
      await expect(
        context.external({
          kind: "validate",
          check: "metadata",
          field: "checked_items",
        }),
      ).resolves.toMatchObject({ value: 2, population_size: 1 });
      await expect(
        context.external({
          kind: "validate",
          check: "lifecycle",
          field: "status",
        }),
      ).resolves.toMatchObject({ value: 0 });
      await expect(
        context.external({
          kind: "health",
          check: "settings",
          field: "warnings",
        }),
      ).resolves.toMatchObject({ value: [] });
      await expect(
        context.external({
          kind: "health",
          check: "directories",
          field: "required",
        }),
      ).resolves.toMatchObject({ value: expect.arrayContaining(["history"]) });
      await expect(
        context.external({
          kind: "health",
          check: "extensions",
          field: "status",
        }),
      ).resolves.toMatchObject({ value: 1 });
      await expect(
        context.external({
          kind: "health",
          check: "missing",
          field: "status",
        }),
      ).rejects.toThrow("is not present");
      await expect(
        context.external({
          kind: "health",
          check: "settings",
          field: "path",
        }),
      ).rejects.toThrow("finite number or string array");
    });
  });

  it("routes contributed providers and rejects missing registrations", async () => {
    await withSeededWorkspace(async ({ pmPath, providers }) => {
      const context = await createAssuranceWorkspaceContext(pmPath, {
        providers,
      });
      await expect(
        context.external({
          kind: "provider",
          provider: "coverage",
          key: "labels",
        }),
      ).resolves.toMatchObject({ value: ["lines", "branches"] });
      await expect(
        context.external({
          kind: "provider",
          provider: "missing",
          key: "lines",
        }),
      ).rejects.toThrow("is not registered");
    });
  });

  it("resolves the exact commit from the fixture repository", async () => {
    await withSeededWorkspace(async ({ pmPath, tempRoot }) => {
      await execFileAsync("git", ["init", tempRoot]);
      await execFileAsync("git", [
        "-C",
        tempRoot,
        "config",
        "user.name",
        "Assurance Test",
      ]);
      await execFileAsync("git", [
        "-C",
        tempRoot,
        "config",
        "user.email",
        "assurance@example.invalid",
      ]);
      await execFileAsync("git", [
        "-C",
        tempRoot,
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      const { stdout } = await execFileAsync("git", [
        "-C",
        tempRoot,
        "rev-parse",
        "HEAD^{commit}",
      ]);
      const gitContext = await createAssuranceWorkspaceContext(pmPath);
      expect(gitContext.tree_id).toBe(stdout.trim());
    });
  });

  it("falls back when Git identity resolution is unavailable", async () => {
    await withSeededWorkspace(async ({ pmPath }) => {
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const inferredTree = await createAssuranceWorkspaceContext(pmPath);
        expect(inferredTree.tree_id).toBe("working-copy");
      } finally {
        restoreEnv("PATH", originalPath);
      }
    });
  });
});
