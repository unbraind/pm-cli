import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTest } from "../../src/sdk/test/execution.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { overwriteTaskTests } from "../helpers/pmWorkspace.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface TestEnvelope {
  warnings?: string[];
  tests: Array<Record<string, unknown>>;
  execution_context?: {
    requested_workspace_context_mode: string;
    workspace_context_mode: string;
    working_directory: string;
    source_workspace_root: string;
    trust: { trusted: boolean; reason: string };
  };
  run_results: Array<{
    status: string;
    failure_category?: string;
    stdout?: string;
    error?: string;
    execution_context?: {
      requested_workspace_context_mode: string;
      workspace_context_mode: string;
      working_directory: string;
      source_workspace_root: string;
      trust: { trusted: boolean; reason: string };
    };
  }>;
}

describe("linked-test workspace and trust contracts", () => {
  it("preserves independent nested installations without hoisting or source writeback", async () => {
    await withTempPmPath(async (context) => {
      const sourceRoot = path.join(context.tempRoot, "monorepo");
      const packageRoot = path.join(sourceRoot, "apps", "site");
      const dependencyRoot = path.join(context.tempRoot, "installed-dependencies");
      for (const [root, version] of [
        [path.join(sourceRoot, "node_modules"), "1.0.0"],
        [dependencyRoot, "2.0.0"],
      ]) {
        const moduleRoot = path.join(root, "snapshot-dependency");
        await mkdir(moduleRoot, { recursive: true });
        await writeFile(path.join(moduleRoot, "package.json"), JSON.stringify({
          name: "snapshot-dependency", version, type: "module", exports: "./index.js",
        }));
        await writeFile(path.join(moduleRoot, "index.js"), `export const version = ${JSON.stringify(version)};\n`);
      }
      await mkdir(packageRoot, { recursive: true });
      await symlink(dependencyRoot, path.join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await symlink("node_modules/snapshot-dependency/index.js", path.join(packageRoot, "dependency-alias.js"), "file");
      await writeFile(path.join(sourceRoot, "root.js"), "export { version } from 'snapshot-dependency';\n");
      const testPath = path.join(packageRoot, "dependency.test.mjs");
      await writeFile(testPath, [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { writeFileSync } from 'node:fs';",
        "import { version as rootVersion } from '../../root.js';",
        "import { version } from 'snapshot-dependency';",
        "import { version as aliasVersion } from './dependency-alias.js';",
        "test('independent dependency identities', () => {",
        "  assert.equal(rootVersion, '1.0.0');",
        "  assert.equal(version, '2.0.0');",
        "  assert.equal(aliasVersion, '2.0.0');",
        "  assert.ok(process.env.PM_GLOBAL_PATH);",
        "  assert.equal(process.env.PM_PATH, undefined);",
        "  writeFileSync('snapshot-only.txt', version);",
        "});",
      ].join("\n"));
      const before = await readFile(testPath, "utf8");
      const direct = spawnSync(process.execPath, ["--test", testPath], {
        cwd: sourceRoot, env: { ...context.env, PM_PATH: undefined }, encoding: "utf8",
      });
      expect(direct.status, direct.stderr).toBe(0);
      expect(await readFile(path.join(sourceRoot, "snapshot-only.txt"), "utf8")).toBe("2.0.0");
      await rm(path.join(sourceRoot, "snapshot-only.txt"));
      context.env.PM_SOURCE_WORKSPACE_ROOT = sourceRoot;
      const id = createTestItemId(context, { title: "nested dependency snapshot", createMode: "progressive" });
      expect(context.runCli(["test", id, "--add-json", JSON.stringify({
        command: "node --test apps/site/dependency.test.mjs",
        pm_context_mode: "none", workspace_context_mode: "snapshot",
      }), "--json"], { cwd: sourceRoot }).code).toBe(0);
      const snapshot = context.runCli(["test", id, "--run", "--json"], { cwd: sourceRoot, expectJson: true });
      const result = (snapshot.json as TestEnvelope).run_results[0];
      expect(snapshot.code, JSON.stringify(result)).toBe(0);
      expect(result).toMatchObject({ status: "passed" });
      expect((snapshot.json as TestEnvelope).execution_context).toMatchObject({ workspace_context_mode: "snapshot" });
      expect(result.stdout).toContain("independent dependency identities");
      expect(await readFile(testPath, "utf8")).toBe(before);
      await expect(access(path.join(sourceRoot, "snapshot-only.txt"))).rejects.toThrow();
      expect(await readFile(path.join(dependencyRoot, "snapshot-dependency", "index.js"), "utf8")).toBe('export const version = "2.0.0";\n');
    });
  });

  it("persists provenance and requires policy plus a per-run flag for foreign commands", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "linked trust integration",
        createMode: "progressive",
      });
      const added = context.runCli(
        [
          "test",
          id,
          "--add",
          "command=node --version,workspace_context_mode=isolated",
          "--json",
        ],
        { expectJson: true },
      );
      expect(added.code).toBe(0);
      expect((added.json as TestEnvelope).tests[0]).toMatchObject({
        workspace_context_mode: "isolated",
        provenance: {
          author: expect.any(String),
          created_at: expect.any(String),
          source_kind: "local_mutation",
        },
      });

      await overwriteTaskTests(context, id, [
        {
          command: "node -e \"process.stdout.write('EXECUTED')\"",
          scope: "project",
          provenance: {
            author: "foreign-agent",
            created_at: "2026-08-22T12:00:00.000Z",
            source_kind: "merge_union",
            source_ref: "foreign/branch",
          },
        },
      ]);

      const refused = context.runCli(["test", id, "--run", "--json"], {
        expectJson: true,
      });
      expect(refused.code).toBe(5);
      const refusedEnvelope = refused.json as TestEnvelope;
      expect(refusedEnvelope.run_results[0]).toMatchObject({
        status: "failed",
        failure_category: "trust_refusal",
      });
      expect(refusedEnvelope.execution_context?.trust).toMatchObject({
        trusted: false,
        reason: "foreign_source_ref",
      });
      expect(refusedEnvelope.run_results[0]?.error).toContain(
        "not trusted by this clone",
      );

      const flagWithoutPolicy = context.runCli(
        ["test", id, "--run", "--allow-untrusted-linked-tests", "--json"],
        { expectJson: true },
      );
      expect(flagWithoutPolicy.code).toBe(5);

      const validation = context.runCli(
        ["validate", "--check-command-references", "--json"],
        { expectJson: true },
      );
      expect((validation.json as { warnings: string[] }).warnings).toContain(
        "validate_linked_test_trust_unacknowledged:1",
      );

      expect(
        context.runCli([
          "config",
          "project",
          "set",
          "untrusted-linked-test-execution",
          "enabled",
          "--json",
        ]).code,
      ).toBe(0);
      const optedIn = context.runCli(
        ["test", id, "--run", "--allow-untrusted-linked-tests", "--json"],
        { expectJson: true },
      );
      expect(optedIn.code).toBe(0);
      expect((optedIn.json as TestEnvelope).run_results[0]).toMatchObject({
        status: "passed",
        stdout: "EXECUTED",
      });

      const acknowledged = context.runCli(
        ["test", id, "--acknowledge-linked-tests", "--json"],
        { expectJson: true },
      );
      expect(acknowledged.code).toBe(0);
      expect((acknowledged.json as TestEnvelope).warnings).toContain(
        "linked_test_trust_acknowledged:1",
      );
      expect(
        context.runCli([
          "config",
          "project",
          "set",
          "untrusted-linked-test-execution",
          "disabled",
          "--json",
        ]).code,
      ).toBe(0);
      const trusted = context.runCli(["test", id, "--run", "--json"], {
        expectJson: true,
      });
      expect(trusted.code).toBe(0);
      expect(
        (trusted.json as TestEnvelope).execution_context?.trust,
      ).toMatchObject({ trusted: true, reason: "acknowledged" });
    });
  });

  it("runs source, isolated, and snapshot workspace modes with explicit context", async () => {
    await withTempPmPath(async (context) => {
      const sourceRoot = path.join(context.tempRoot, "source-workspace");
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "marker.txt"), "source\n");
      await mkdir(path.join(sourceRoot, "nested", ".git"), {
        recursive: true,
      });
      await mkdir(path.join(sourceRoot, "nested", "coverage"), {
        recursive: true,
      });
      await writeFile(
        path.join(sourceRoot, "nested", ".git", "secret"),
        "hidden\n",
      );
      await writeFile(
        path.join(sourceRoot, "nested", "coverage", "result.json"),
        "{}\n",
      );
      context.env.PM_SOURCE_WORKSPACE_ROOT = sourceRoot;
      const id = createTestItemId(context, {
        title: "workspace context integration",
        createMode: "progressive",
      });
      const command =
        "node -e \"const fs=require('fs');fs.writeFileSync('snapshot-only.txt','ok');process.stdout.write(String(fs.existsSync('marker.txt'))+':'+String(fs.existsSync('nested/.git/secret'))+':'+String(fs.existsSync('nested/coverage/result.json')))\"";
      expect(
        context.runCli(
          [
            "test",
            id,
            "--add",
            `command=${command},workspace_context_mode=snapshot`,
            "--json",
          ],
          { cwd: sourceRoot, expectJson: true },
        ).code,
      ).toBe(0);

      const snapshot = context.runCli(["test", id, "--run", "--json"], {
        cwd: sourceRoot,
        expectJson: true,
      });
      expect(snapshot.code).toBe(0);
      const snapshotResult = (snapshot.json as TestEnvelope).run_results[0];
      expect(snapshotResult).toMatchObject({
        status: "passed",
        stdout: "true:false:false",
      });
      const snapshotContext = (snapshot.json as TestEnvelope).execution_context;
      expect(snapshotContext).toMatchObject({
        requested_workspace_context_mode: "source",
        workspace_context_mode: "snapshot",
        trust: { trusted: true },
      });
      expect(["local_mutation", "local_source_ref"]).toContain(
        snapshotContext?.trust.reason,
      );
      expect(snapshotContext?.working_directory).not.toBe(sourceRoot);
      expect(snapshotContext?.source_workspace_root).toBe(
        snapshotContext?.working_directory,
      );
      await expect(
        access(path.join(sourceRoot, "snapshot-only.txt")),
      ).rejects.toThrow();

      const isolated = context.runCli(
        [
          "test",
          id,
          "--run",
          "--workspace-context",
          "isolated",
          "--override-linked-workspace-context",
          "--json",
        ],
        { cwd: sourceRoot, expectJson: true },
      );
      expect(isolated.code).toBe(0);
      expect((isolated.json as TestEnvelope).run_results[0]).toMatchObject({
        status: "passed",
        stdout: "false:false:false",
      });
      expect((isolated.json as TestEnvelope).execution_context).toMatchObject({
        requested_workspace_context_mode: "isolated",
        workspace_context_mode: "isolated",
        source_workspace_root: "",
      });
      expect(
        (isolated.json as TestEnvelope).execution_context?.working_directory,
      ).not.toBe(sourceRoot);
      await expect(
        access(path.join(sourceRoot, "snapshot-only.txt")),
      ).rejects.toThrow();

      await overwriteTaskTests(context, id, [
        {
          command: "node --version",
          scope: "project",
          workspace_context_mode: "snapshot",
        },
      ]);
      const directOverride = await runTest(
        id,
        {
          run: true,
          workspaceContext: "source",
          overrideLinkedWorkspaceContext: true,
        },
        { path: context.pmPath },
      );
      expect(directOverride.run_results[0]?.execution_context).toMatchObject({
        workspace_context_mode: "source",
      });
    });
  });

  it("allows SDK-style tests to manage their own PM roots only in isolated workspaces", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "self-isolating linked test",
        createMode: "progressive",
      });
      const command =
        "node -e \"process.stdout.write(String(process.env.PM_PATH)+':'+String(Boolean(process.env.PM_GLOBAL_PATH)))\"";
      const added = context.runCli(
        [
          "test",
          id,
          "--add",
          `command=${command},pm_context_mode=none,workspace_context_mode=isolated`,
          "--json",
        ],
        { expectJson: true },
      );
      expect(added.code).toBe(0);
      expect((added.json as TestEnvelope).tests[0]).toMatchObject({
        pm_context_mode: "none",
        workspace_context_mode: "isolated",
      });
      const isolated = context.runCli(["test", id, "--run", "--json"], {
        expectJson: true,
      });
      expect(isolated.code).toBe(0);
      expect((isolated.json as TestEnvelope).run_results[0]).toMatchObject({
        status: "passed",
        stdout: "undefined:true",
      });

      await overwriteTaskTests(context, id, [
        { command: "node --version", pm_context_mode: "none" },
      ]);
      const source = context.runCli(["test", id, "--run", "--json"], {
        expectJson: true,
      });
      expect(source.code).toBe(5);
      expect((source.json as TestEnvelope).run_results[0]).toMatchObject({
        status: "failed",
        failure_category: "assertion_failure",
        error: expect.stringContaining("workspace_context_mode"),
      });

      await overwriteTaskTests(context, id, [
        {
          command: "pm --version",
          pm_context_mode: "none",
          workspace_context_mode: "isolated",
        },
      ]);
      const directPm = context.runCli(["test", id, "--run", "--json"], {
        expectJson: true,
      });
      expect(directPm.code).toBe(5);
      expect((directPm.json as TestEnvelope).run_results[0]).toMatchObject({
        status: "failed",
        failure_category: "assertion_failure",
        error: expect.stringContaining("direct PM commands"),
      });
    });
  });
});
