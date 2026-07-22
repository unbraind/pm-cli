import { describe, expect, it } from "vitest";
import { runPlan } from "../../../src/cli/commands/plan.js";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS } from "../../../src/sdk/cli-contracts.js";
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
              status?: string;
              priority?: number;
              deadline?: string;
              estimated_minutes?: number;
              tags?: string[];
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
        status: "open",
        priority: 1,
        deadline: "2026-08-01T00:00:00.000Z",
        estimated_minutes: 60,
        tags: ["contracts", "sdk"],
        comments: expect.arrayContaining([
          expect.objectContaining({ text: "creation evidence" }),
        ]),
        notes: expect.arrayContaining([
          expect.objectContaining({ text: "creation note" }),
        ]),
        learnings: expect.arrayContaining([
          expect.objectContaining({ text: "creation learning" }),
        ]),
        files: [{ path: "src/cli/commands/plan.ts", scope: "project" }],
        docs: [{ path: "docs/SDK.md", scope: "project" }],
        tests: [
          {
            command: "pnpm build",
            scope: "project",
            timeout_seconds: 300,
          },
        ],
      });
      expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.create.required).toEqual([
        "title",
        "description",
        "type",
        "status",
        "priority",
        "message",
      ]);
      expect(PM_TOOL_ACTION_PARAMETER_CONTRACTS.plan.optional).toEqual(
        expect.arrayContaining([
          "status",
          "createMode",
          "deadline",
          "estimate",
          "acceptanceCriteria",
          "definitionOfReady",
          "order",
          "rank",
          "goal",
          "objective",
          "value",
          "impact",
          "outcome",
          "whyNow",
          "assignee",
          "comment",
          "note",
          "learning",
          "reminder",
          "event",
          "typeOption",
        ]),
      );
    });
  });

  it("persists advertised Plan promotion kinds as semantic dependency edges", async () => {
    await withTempPmPath(async (context) => {
      const targetIds = ["implements", "verifies", "depends_on"].map((kind) => {
        const target = context.runCli(
          [
            "create",
            "Task",
            `Promotion target ${kind}`,
            "--create-mode",
            "progressive",
            "--author",
            "test-author",
            "--json",
          ],
          { expectJson: true },
        );
        return (target.json as { item: { id: string } }).item.id;
      });
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

      for (const [index, kind] of (
        ["implements", "verifies", "depends_on"] as const
      ).entries()) {
        await runPlan({
          subcommand: "link",
          id: created.plan.id,
          stepRef: "plan-step-001",
          options: {
            link: targetIds[index],
            linkKind: kind,
            promoteToItemDep: true,
            author: "test-author",
          },
          global: { path: context.pmPath, json: true },
        });
      }
      const reloaded = context.runCli(
        ["get", created.plan.id, "--full", "--json"],
        { expectJson: true },
      );
      expect(
        (
          reloaded.json as {
            item: { dependencies?: Array<{ id: string; kind: string }> };
          }
        ).item.dependencies,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: targetIds[0], kind: "implements" }),
          expect.objectContaining({ id: targetIds[1], kind: "verifies" }),
          expect.objectContaining({ id: targetIds[2], kind: "blocked_by" }),
        ]),
      );
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
