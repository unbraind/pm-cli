import { describe, expect, it } from "vitest";
import { runPlan } from "../../../src/cli/commands/plan.js";
import { _testOnlyTestCommand } from "../../../src/sdk/test/execution.js";
import { createRelationshipKindRegistry } from "../../../src/sdk/relationships.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("agent contract correctness", () => {
  it("forwards strict Plan create metadata through CLI and SDK contracts", async () => {
    await withTempPmPath(async (context) => {
      const strict = context.runCli([
        "config",
        "project",
        "set",
        "governance-preset",
        "--policy",
        "strict",
        "--json",
      ]);
      expect(strict.code).toBe(0);
      const target = context.runCli(
        [
          "create",
          "Task",
          "Strict Plan dependency",
          "--create-mode",
          "progressive",
          "--author",
          "test-author",
          "--json",
        ],
        { expectJson: true },
      );
      const targetId = (target.json as { item: { id: string } }).item.id;

      const created = context.runCli(
        [
          "plan",
          "create",
          "--title",
          "Strict contract plan",
          "--description",
          "Exercise the governed Plan create path",
          "--scope",
          "CLI SDK and MCP parity",
          "--body",
          "Strict governed Plan body",
          "--tags",
          "sdk,contracts",
          "--related",
          targetId,
          "--status",
          "open",
          "--priority",
          "1",
          "--assignee",
          "test-author",
          "--acceptance-criteria",
          "All strict metadata survives",
          "--deadline",
          "2026-08-01",
          "--estimate",
          "60",
          "--comment",
          "text=creation evidence",
          "--note",
          "text=creation note",
          "--learning",
          "text=creation learning",
          "--file",
          "path=src/cli/commands/plan.ts,scope=project",
          "--doc",
          "path=docs/SDK.md,scope=project",
          "--test",
          "command=pnpm build,scope=project,timeout_seconds=300",
          "--author",
          "test-author",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const planId = (created.json as { plan: { id: string } }).plan.id;
      const item = context.runCli(["get", planId, "--full", "--json"], {
        expectJson: true,
      });
      expect(item.code).toBe(0);
      expect(
        (
          item.json as {
            item: {
              acceptance_criteria?: string;
              assignee?: string;
              comments?: unknown[];
              notes?: unknown[];
              learnings?: unknown[];
              files?: unknown[];
              docs?: unknown[];
              tests?: unknown[];
            };
          }
        ).item,
      ).toMatchObject({
        acceptance_criteria: "All strict metadata survives",
        assignee: "test-author",
        comments: expect.any(Array),
        notes: expect.any(Array),
        learnings: expect.any(Array),
        files: expect.any(Array),
        docs: expect.any(Array),
        tests: expect.any(Array),
      });
    });
  });

  it("persists advertised Plan promotion kinds as semantic dependency edges", async () => {
    await withTempPmPath(async (context) => {
      const target = context.runCli(
        [
          "create",
          "Task",
          "Promotion target",
          "--create-mode",
          "progressive",
          "--author",
          "test-author",
          "--json",
        ],
        { expectJson: true },
      );
      const targetId = (target.json as { item: { id: string } }).item.id;
      const created = await runPlan({
        subcommand: "create",
        options: {
          title: "Promotion plan",
          description: "Preserve graph semantics",
          step: "Implement target",
          author: "test-author",
        },
        global: { path: context.pmPath, json: true },
      });

      const linked = await runPlan({
        subcommand: "link",
        id: created.plan.id,
        stepRef: "plan-step-001",
        options: {
          link: targetId,
          linkKind: "implements",
          promoteToItemDep: true,
          author: "test-author",
        },
        global: { path: context.pmPath, json: true },
      });
      expect(linked.plan.linked_items).toContainEqual({
        id: targetId,
        kind: "implements",
      });
      expect(
        createRelationshipKindRegistry().require("implements"),
      ).toMatchObject({
        direction: "directed",
        ordering: false,
        hierarchy: false,
      });
      expect(
        createRelationshipKindRegistry().require("verifies"),
      ).toMatchObject({
        direction: "directed",
        ordering: false,
        hierarchy: false,
      });
    });
  });

  it("initializes every linked-test sandbox with explicit non-interactive defaults", async () => {
    const calls: Array<{
      path?: string;
      defaults?: boolean;
      agentGuidance?: string;
    }> = [];
    await _testOnlyTestCommand.initializeLinkedTestSandboxes(
      {
        root: "/tmp/linked-test-contract",
        schemaProjectPmPath:
          "/tmp/linked-test-contract/schema/project/.agents/pm",
        schemaGlobalPmPath: "/tmp/linked-test-contract/schema/global",
        trackerProjectPmPath:
          "/tmp/linked-test-contract/tracker/project/.agents/pm",
        trackerGlobalPmPath: "/tmp/linked-test-contract/tracker/global",
      },
      async (_prefix, global, options) => {
        calls.push({
          path: global.path,
          defaults: options?.defaults,
          agentGuidance: options?.agentGuidance,
        });
        return undefined;
      },
    );
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.defaults === true)).toBe(true);
    expect(calls.every((call) => call.agentGuidance === "skip")).toBe(true);
  });
});
