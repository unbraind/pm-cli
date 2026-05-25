import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("MCP dynamic package actions", () => {
  it("routes config positional value through the MCP action runner", async () => {
    await withTempPmPath(async (context) => {
      const telemetry = await handleRequest({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "config",
            configAction: "set",
            key: "telemetry-tracking",
            value: "off",
            options: {},
          },
        },
      });

      expect(telemetry?.isError).not.toBe(true);
      const telemetryResult = (telemetry?.structuredContent as {
        result?: { policy?: string; changed?: boolean };
      } | undefined)?.result;
      expect(telemetryResult?.policy).toBe("disabled");
      expect(telemetryResult?.changed).toBe(true);
    });
  });

  it("normalizes scalar update log fields and defaults list output to compact", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP compact target",
        "--description",
        "MCP compact target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp,projection",
        "--body",
        "large body that should not appear in compact list output",
        "--deadline",
        "+1d",
        "--estimate",
        "15",
        "--acceptance-criteria",
        "MCP compact target acceptance",
        "--author",
        "test-author",
        "--message",
        "Create MCP compact target",
        "--dep",
        "id=pm-seed-related,kind=related,author=seed-author,created_at=now",
        "--comment",
        "author=seed-author,created_at=now,text=seed comment",
        "--note",
        "author=seed-author,created_at=now,text=seed note",
        "--learning",
        "author=seed-author,created_at=now,text=seed learning",
        "--file",
        "path=README.md,scope=project,note=seed file",
        "--test",
        "command=node dist/cli.js --version,scope=project,note=seed test",
        "--doc",
        "path=README.md,scope=project,note=seed doc",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const update = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_update",
          arguments: {
            path: context.pmPath,
            id,
            author: "mcp-agent",
            options: {
              comment: "scalar comment from MCP",
              note: "scalar note from MCP",
              learning: "scalar learning from MCP",
            },
          },
        },
      });
      expect(update?.isError).not.toBe(true);
      const updateResult = (update?.structuredContent as {
        result?: {
          item?: {
            comments?: Array<{ text: string }>;
            notes?: Array<{ text: string }>;
            learnings?: Array<{ text: string }>;
          };
        };
      } | undefined)?.result;
      expect(updateResult?.item?.comments?.some((entry) => entry.text === "scalar comment from MCP")).toBe(true);
      expect(updateResult?.item?.notes?.some((entry) => entry.text === "scalar note from MCP")).toBe(true);
      expect(updateResult?.item?.learnings?.some((entry) => entry.text === "scalar learning from MCP")).toBe(true);

      const list = await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_list",
          arguments: {
            path: context.pmPath,
            options: {
              status: "open,in_progress",
              tag: "mcp",
            },
          },
        },
      });

      expect(list?.isError).not.toBe(true);
      const listResult = (list?.structuredContent as {
        result?: {
          projection?: { mode: string; fields: string[] | null };
          items?: Array<Record<string, unknown>>;
          filters?: { status?: unknown };
        };
      } | undefined)?.result;
      expect(listResult?.projection).toEqual({
        mode: "compact",
        fields: ["id", "title", "status", "type", "priority", "parent", "updated_at"],
      });
      expect(listResult?.filters?.status).toEqual(["open", "in_progress"]);
      expect(listResult?.items?.[0]).toMatchObject({ id, title: "MCP compact target" });
      expect(listResult?.items?.[0]).not.toHaveProperty("body");
      expect(listResult?.items?.[0]).not.toHaveProperty("comments");

      const getBrief = await handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "pm_get",
          arguments: {
            path: context.pmPath,
            id,
            options: {
              fields: "id,title,status",
            },
          },
        },
      });
      expect(getBrief?.isError).not.toBe(true);
      const getResult = (getBrief?.structuredContent as {
        result?: { item?: Record<string, unknown>; body?: string; linked?: { files?: unknown[] } };
      } | undefined)?.result;
      expect(getResult?.item).toEqual({ id, title: "MCP compact target", status: "open" });
      expect(getResult?.body).toBeUndefined();
      expect(getResult?.linked).toBeUndefined();

      for (let index = 0; index < 25; index += 1) {
        const comment = context.runCli(["comments", id, "--add", `mcp comment ${index}`, "--json"], { expectJson: true });
        expect(comment.code).toBe(0);
      }
      const comments = await handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "pm_comments",
          arguments: {
            path: context.pmPath,
            id,
          },
        },
      });
      expect(comments?.isError).not.toBe(true);
      const commentsResult = (comments?.structuredContent as {
        result?: {
          comments?: Array<{ text: string }>;
          count?: number;
          total_count?: number;
          returned_count?: number;
          has_more?: boolean;
          limit?: number;
        };
      } | undefined)?.result;
      expect(commentsResult?.count).toBe(20);
      expect(commentsResult?.returned_count).toBe(20);
      expect(commentsResult?.total_count).toBe(27);
      expect(commentsResult?.has_more).toBe(true);
      expect(commentsResult?.limit).toBe(20);
      expect(commentsResult?.comments?.[0]?.text).toBe("mcp comment 5");
    });
  });

  it("defaults pm_search output to a compact projection for token efficiency", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "Searchable telemetry beacon item",
        "--description",
        "Searchable telemetry beacon description",
        "--type",
        "Task",
        "--status",
        "open",
        "--body",
        "huge searchable telemetry body that must never appear in a compact search projection",
        "--author",
        "test-author",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const search = await handleRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "pm_search",
          arguments: {
            path: context.pmPath,
            query: "telemetry beacon",
          },
        },
      });

      expect(search?.isError).not.toBe(true);
      const searchResult = (search?.structuredContent as {
        result?: {
          projection?: { mode: string; fields: string[] | null };
          items?: Array<Record<string, unknown>>;
        };
      } | undefined)?.result;
      expect(searchResult?.projection?.mode).toBe("compact");
      const hit = searchResult?.items?.find((entry) => entry.id === id);
      expect(hit).toBeTruthy();
      expect(hit).not.toHaveProperty("body");
      expect(hit).not.toHaveProperty("item");
      expect(hit).toMatchObject({ id, title: "Searchable telemetry beacon item" });

      const fullSearch = await handleRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "pm_search",
          arguments: {
            path: context.pmPath,
            query: "telemetry beacon",
            options: { full: true },
          },
        },
      });
      const fullResult = (fullSearch?.structuredContent as {
        result?: { projection?: { mode: string }; items?: Array<Record<string, unknown>> };
      } | undefined)?.result;
      expect(fullResult?.projection?.mode).toBe("full");
      expect(fullResult?.items?.[0]).toHaveProperty("item");
    });
  });

  it("accepts top-level Plan step references through the narrow MCP tool", async () => {
    await withTempPmPath(async (context) => {
      const created = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_plan",
          arguments: {
            path: context.pmPath,
            options: {
              subcommand: "create",
              title: "MCP plan",
              scope: "MCP stepRef coverage",
              harness: "codex",
              author: "mcp-agent",
            },
          },
        },
      });
      const planId = (created?.structuredContent as { result?: { plan?: { id?: string } } } | undefined)?.result?.plan?.id;
      expect(planId).toMatch(/^pm-/);

      await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_plan",
          arguments: {
            path: context.pmPath,
            id: planId,
            options: {
              subcommand: "add-step",
              stepTitle: "Read code",
              author: "mcp-agent",
            },
          },
        },
      });

      const updated = await handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "pm_plan",
          arguments: {
            path: context.pmPath,
            id: planId,
            stepRef: "plan-step-001",
            options: {
              subcommand: "complete-step",
              stepEvidence: "done",
              author: "mcp-agent",
            },
          },
        },
      });
      const result = (updated?.structuredContent as { result?: { step?: { status?: string; evidence?: string } } } | undefined)?.result;
      expect(result?.step).toMatchObject({ status: "completed", evidence: "done" });
    });
  });

  it("invokes installed package actions discovered through runtime contracts", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["--json", "install", "all", "--project"], { expectJson: true });
      expect(install.code).toBe(0);

      const contracts = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_contracts",
          arguments: {
            path: context.pmPath,
            options: {
              runtimeOnly: true,
              availabilityOnly: true,
            },
          },
        },
      });
      const contractResult = (contracts?.structuredContent as { result?: { actions?: string[] } } | undefined)?.result;
      expect(contractResult?.actions).toEqual(expect.arrayContaining(["todos-export"]));

      const exportResult = await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "todos-export",
            folder: path.join(context.tempRoot, "todos-out"),
          },
        },
      });

      expect(exportResult?.isError).not.toBe(true);
      const result = (exportResult?.structuredContent as { result?: { ok?: boolean; exported?: number } } | undefined)?.result;
      expect(result).toMatchObject({
        ok: true,
        exported: expect.any(Number),
      });
    });
  });

  it("defaults pm_run activity output to compact for token efficiency", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli(["create", "--json", "--title", "Activity seed", "--description", "d", "--type", "Task", "--author", "a"], {
        expectJson: true,
      });
      expect(create.code).toBe(0);

      const activity = await handleRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "activity" },
        },
      });
      expect(activity?.isError).not.toBe(true);
      const activityResult = (activity?.structuredContent as {
        result?: { compact?: boolean; activity?: unknown[]; compact_activity?: unknown[] };
      } | undefined)?.result;
      expect(activityResult?.compact).toBe(true);
      expect(activityResult?.activity).toEqual([]);
      expect(Array.isArray(activityResult?.compact_activity)).toBe(true);

      const verbose = await handleRequest({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "activity", options: { compact: false } },
        },
      });
      const verboseResult = (verbose?.structuredContent as { result?: { compact?: boolean } } | undefined)?.result;
      expect(verboseResult?.compact).toBe(false);

      const full = await handleRequest({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "activity", options: { full: true } },
        },
      });
      const fullResult = (full?.structuredContent as { result?: { compact?: boolean } } | undefined)?.result;
      expect(fullResult?.compact).toBe(false);
    });
  });
});
