import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createAssuranceWorkspaceContext } from "../../../src/sdk/governance/assurance-runtime.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const execFileAsync = promisify(execFile);

describe("assurance workspace runtime", () => {
  it("binds built-in and contributed measurement adapters to live workspace data", async () => {
    await withTempPmPath(async (fixture) => {
      const previousCodexCi = process.env.CODEX_CI;
      const previousCodexModel = process.env.CODEX_MODEL;
      process.env.CODEX_CI = "1";
      process.env.CODEX_MODEL = "assurance-test-model";
      const created = await fixture.runCliInProcess(
        ["create", "--title", "Assurance runtime fixture", "--type", "Task", "--json"],
        { expectJson: true },
      );
      process.env.CODEX_CI = previousCodexCi;
      process.env.CODEX_MODEL = previousCodexModel;
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
      expect(plainCreated.code).toBe(0);
      expect(created.code).toBe(0);
      const brokenExtension = path.join(fixture.pmPath, "extensions", "broken");
      await mkdir(brokenExtension, { recursive: true });
      await writeFile(path.join(brokenExtension, "manifest.json"), "{", "utf8");

      const context = await createAssuranceWorkspaceContext(fixture.pmPath, {
        tree_id: "fixture-tree",
        providers: {
          coverage: async (source) => ({
            value: source.key === "labels" ? ["lines", "branches"] : 100,
            population_size: 1,
            cost: 1,
          }),
        },
      });
      expect(context.tree_id).toBe("fixture-tree");
      expect(context.items).toHaveLength(2);
      expect(context.history.length).toBeGreaterThan(0);
      expect(context.terminal_statuses).toEqual(
        expect.arrayContaining(["closed", "canceled"]),
      );

      await expect(
        context.external({
          kind: "graph",
          operation: "audit",
          field: "profile.nodes",
        }),
      ).resolves.toMatchObject({ value: 2, population_size: 2 });
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
          kind: "graph",
          operation: "audit",
          field: "findings",
        }),
      ).rejects.toThrow("finite number or string array");
      await expect(
        context.external({ kind: "provider", provider: "coverage", key: "labels" }),
      ).resolves.toMatchObject({ value: ["lines", "branches"] });
      await expect(
        context.external({ kind: "provider", provider: "missing", key: "lines" }),
      ).rejects.toThrow("is not registered");
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

      await execFileAsync("git", ["init", fixture.tempRoot]);
      await execFileAsync("git", ["-C", fixture.tempRoot, "config", "user.name", "Assurance Test"]);
      await execFileAsync("git", ["-C", fixture.tempRoot, "config", "user.email", "assurance@example.invalid"]);
      await execFileAsync("git", ["-C", fixture.tempRoot, "commit", "--allow-empty", "-m", "fixture"]);
      const gitContext = await createAssuranceWorkspaceContext(fixture.pmPath);
      expect(gitContext.tree_id.length).toBeGreaterThan(0);
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const inferredTree = await createAssuranceWorkspaceContext(fixture.pmPath);
        expect(inferredTree.tree_id).toBe("working-copy");
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});
