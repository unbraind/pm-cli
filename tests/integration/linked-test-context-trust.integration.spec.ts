import { access, mkdir, writeFile } from "node:fs/promises";
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
    workspace_context_mode: string;
    working_directory: string;
    source_workspace_root: string;
    trust: { trusted: boolean; reason: string };
  };
  run_results: Array<{
    status: string;
    stdout?: string;
    error?: string;
    execution_context?: {
      workspace_context_mode: string;
      working_directory: string;
      source_workspace_root: string;
      trust: { trusted: boolean; reason: string };
    };
  }>;
}

describe("linked-test workspace and trust contracts", () => {
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
      context.env.PM_SOURCE_WORKSPACE_ROOT = sourceRoot;
      const id = createTestItemId(context, {
        title: "workspace context integration",
        createMode: "progressive",
      });
      const command =
        "node -e \"const fs=require('fs');fs.writeFileSync('snapshot-only.txt','ok');process.stdout.write(String(fs.existsSync('marker.txt')))\"";
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
        stdout: "true",
      });
      const snapshotContext = (snapshot.json as TestEnvelope).execution_context;
      expect(snapshotContext).toMatchObject({
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
      expect((isolated.json as TestEnvelope).execution_context).toMatchObject({
        workspace_context_mode: "isolated",
        working_directory: sourceRoot,
        source_workspace_root: "",
      });

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
});
