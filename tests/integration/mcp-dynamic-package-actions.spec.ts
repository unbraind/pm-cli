import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { assertPmContextDepthProjection } from "../helpers/mcp-context-depth.js";
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

  it("routes close-many through pm_run with nested list filters", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP close-many target",
        "--description",
        "MCP close-many target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp-close-many",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const dryRun = await handleRequest({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "close-many",
            options: {
              filterTag: "mcp-close-many",
              reason: "mcp close-many dry-run",
              dryRun: true,
            },
          },
        },
      });

      expect(dryRun?.isError).not.toBe(true);
      const dryRunResult = (dryRun?.structuredContent as {
        result?: { mode?: string; matched_count?: number; item_plans?: Array<{ id: string; action: string }> };
      } | undefined)?.result;
      expect(dryRunResult?.mode).toBe("dry_run");
      expect(dryRunResult?.matched_count).toBe(1);
      expect(dryRunResult?.item_plans).toEqual([
        expect.objectContaining({ id, action: "close" }),
      ]);

      const apply = await handleRequest({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "close-many",
            options: {
              filterTag: "mcp-close-many",
              reason: "mcp close-many apply",
              checkpoint: false,
            },
          },
        },
      });

      expect(apply?.isError).not.toBe(true);
      const applyResult = (apply?.structuredContent as {
        result?: { mode?: string; closed_count?: number; ids?: string[]; rows?: Array<{ id: string; status: string }> };
      } | undefined)?.result;
      expect(applyResult?.mode).toBe("apply");
      expect(applyResult?.closed_count).toBe(1);
      expect(applyResult?.ids).toEqual([id]);
      expect(applyResult?.rows).toEqual([
        expect.objectContaining({ id, status: "closed" }),
      ]);
    });
  });

  it("routes close-many through pm_run with top-level reason and force", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP close-many top-level reason target",
        "--description",
        "MCP close-many top-level reason target description",
        "--type",
        "Task",
        "--status",
        "closed",
        "--priority",
        "1",
        "--tags",
        "mcp-close-many-top-reason",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "close-many",
            reason: "mcp close-many top-level reason",
            force: true,
            options: {
              filterTag: "mcp-close-many-top-reason",
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const closeResult = (result?.structuredContent as {
        result?: { closed_count?: number; ids?: string[] };
      } | undefined)?.result;
      expect(closeResult?.closed_count).toBe(1);
      expect(closeResult?.ids).toEqual([id]);
    });
  });

  it("routes update-many through pm_run with nested list and update options", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP update-many target",
        "--description",
        "MCP update-many target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp-update-many",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "update-many",
            options: {
              list: {
                tag: "mcp-update-many",
                priority: 1,
                includeBody: true,
              },
              update: {
                description: "MCP update-many applied description",
              },
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const updateResult = (result?.structuredContent as {
        result?: { mode?: string; updated_count?: number; ids?: string[]; rows?: Array<{ id: string; status: string }> };
      } | undefined)?.result;
      expect(updateResult?.mode).toBe("apply");
      expect(updateResult?.updated_count).toBe(1);
      expect(updateResult?.ids).toEqual([id]);
      expect(updateResult?.rows).toEqual([
        expect.objectContaining({ id, status: "updated" }),
      ]);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((get.json as { item: { description: string } }).item.description).toBe("MCP update-many applied description");
    });
  });

  it("routes update-many through pm_run with nested list and flat update options", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP mixed update-many target",
        "--description",
        "MCP mixed update-many target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp-mixed-update-many",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "update-many",
            options: {
              list: { tag: "mcp-mixed-update-many" },
              description: "MCP mixed update-many applied description",
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const updateResult = (result?.structuredContent as {
        result?: { updated_count?: number; ids?: string[] };
      } | undefined)?.result;
      expect(updateResult?.updated_count).toBe(1);
      expect(updateResult?.ids).toEqual([id]);

      const get = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((get.json as { item: { description: string } }).item.description).toBe("MCP mixed update-many applied description");
    });
  });

  it("normalizes nested scalar update-many repeatable fields through pm_run", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP nested scalar update-many target",
        "--description",
        "MCP nested scalar update-many target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp-nested-scalar-update-many",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "update-many",
            options: {
              list: { tag: "mcp-nested-scalar-update-many" },
              update: {
                comment: "text=nested scalar comment from MCP update-many",
              },
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const get = context.runCli(["get", id, "--full", "--json"], { expectJson: true });
      const item = (get.json as { item: { comments?: Array<{ text: string }> } }).item;
      expect(item.comments?.some((entry) => entry.text === "nested scalar comment from MCP update-many")).toBe(true);
    });
  });

  it("preserves numeric MCP bulk filters and normalizes update-many aliases", async () => {
    await withTempPmPath(async (context) => {
      const createOne = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP numeric update target",
        "--description",
        "MCP numeric update target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "1",
        "--tags",
        "mcp-numeric-bulk",
        "--estimate",
        "30",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(createOne.code).toBe(0);
      const targetId = (createOne.json as { item: { id: string } }).item.id;

      const createTwo = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP numeric update non-target",
        "--description",
        "MCP numeric update non-target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        "2",
        "--tags",
        "mcp-numeric-bulk",
        "--estimate",
        "30",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(createTwo.code).toBe(0);
      const otherId = (createTwo.json as { item: { id: string } }).item.id;

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "update-many",
            options: {
              filterTag: "mcp-numeric-bulk",
              filterPriority: 1,
              estimate: 45,
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const updateResult = (result?.structuredContent as {
        result?: { updated_count?: number; ids?: string[] };
      } | undefined)?.result;
      expect(updateResult?.updated_count).toBe(1);
      expect(updateResult?.ids).toEqual([targetId]);

      const target = context.runCli(["get", targetId, "--json"], { expectJson: true });
      const other = context.runCli(["get", otherId, "--json"], { expectJson: true });
      expect((target.json as { item: { estimated_minutes: number } }).item.estimated_minutes).toBe(45);
      expect((other.json as { item: { estimated_minutes: number } }).item.estimated_minutes).toBe(30);
    });
  });

  it("preserves numeric MCP close-many limits", async () => {
    await withTempPmPath(async (context) => {
      for (const title of ["MCP numeric close target one", "MCP numeric close target two"]) {
        const create = context.runCli([
          "create",
          "--json",
          "--title",
          title,
          "--description",
          `${title} description`,
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "mcp-close-limit",
          "--author",
          "mcp-test",
        ], { expectJson: true });
        expect(create.code).toBe(0);
      }

      const result = await handleRequest({
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "close-many",
            options: {
              list: {
                tag: "mcp-close-limit",
                limit: 1,
              },
              reason: "mcp close numeric limit",
              checkpoint: false,
            },
          },
        },
      });

      expect(result?.isError).not.toBe(true);
      const closeResult = (result?.structuredContent as {
        result?: { closed_count?: number; ids?: string[] };
      } | undefined)?.result;
      expect(closeResult?.closed_count).toBe(1);
      expect(closeResult?.ids).toHaveLength(1);
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
          items?: Array<Record<string, unknown>>;
          filters?: { status?: unknown };
          now?: unknown;
        };
      } | undefined)?.result;
      expect(listResult?.now).toBeUndefined();
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

  it("compacts mutation changed_fields by default and restores them with options.full", async () => {
    await withTempPmPath(async (context) => {
      const compactCreate = await handleRequest({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "pm_create",
          arguments: {
            path: context.pmPath,
            options: {
              title: "MCP mutation compaction target",
              description: "MCP mutation compaction description",
              type: "Task",
              author: "mcp-agent",
            },
          },
        },
      });
      expect(compactCreate?.isError).not.toBe(true);
      const compactResult = (compactCreate?.structuredContent as {
        result?: { item?: { id?: string }; changed_fields?: unknown; changed_field_count?: number };
      } | undefined)?.result;
      expect(compactResult?.changed_fields).toBeUndefined();
      expect(typeof compactResult?.changed_field_count).toBe("number");
      expect(compactResult?.changed_field_count ?? 0).toBeGreaterThan(0);
      const id = compactResult?.item?.id as string;
      expect(id).toBeTruthy();

      const fullUpdate = await handleRequest({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "pm_update",
          arguments: {
            path: context.pmPath,
            id,
            author: "mcp-agent",
            fullChangedFields: true,
            options: { status: "in_progress", message: "advance status" },
          },
        },
      });
      expect(fullUpdate?.isError).not.toBe(true);
      const fullResult = (fullUpdate?.structuredContent as {
        result?: { changed_fields?: string[]; changed_field_count?: number };
      } | undefined)?.result;
      expect(Array.isArray(fullResult?.changed_fields)).toBe(true);
      expect(fullResult?.changed_fields).toContain("status");
      expect(fullResult?.changed_field_count).toBeUndefined();

      const compactUpdateWithFullOption = await handleRequest({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "pm_update",
          arguments: {
            path: context.pmPath,
            id,
            author: "mcp-agent",
            options: { priority: "1", message: "priority update keeps options.full available", full: true },
          },
        },
      });
      expect(compactUpdateWithFullOption?.isError).not.toBe(true);
      const compactUpdateResult = (compactUpdateWithFullOption?.structuredContent as {
        result?: { changed_fields?: string[]; changed_field_count?: number };
      } | undefined)?.result;
      expect(compactUpdateResult?.changed_fields).toBeUndefined();
      expect(compactUpdateResult?.changed_field_count).toBeGreaterThan(0);
    });
  });

  it("forwards top-level allowMissingParent through pm_create", async () => {
    await withTempPmPath(async (context) => {
      const created = await handleRequest({
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: {
          name: "pm_create",
          arguments: {
            path: context.pmPath,
            allowMissingParent: true,
            options: {
              title: "MCP allow missing parent target",
              description: "MCP allow missing parent description",
              type: "Task",
              parent: "pm-missing-parent-mcp",
              author: "mcp-agent",
            },
          },
        },
      });

      expect(created?.isError).not.toBe(true);
      const result = (created?.structuredContent as {
        result?: { item?: { parent?: string }; warnings?: string[] };
      } | undefined)?.result;
      expect(result?.item?.parent).toBe("pm-missing-parent-mcp");
      expect(result?.warnings).toEqual(expect.arrayContaining(["validation_warning:parent_reference_missing:pm-missing-parent-mcp"]));
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
          items?: Array<Record<string, unknown>>;
          now?: unknown;
        };
      } | undefined)?.result;
      expect(searchResult?.now).toBeUndefined();
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

  it("defaults pm_context to brief depth and supports explicit deeper projections", async () => {
    await withTempPmPath((context) => assertPmContextDepthProjection(context, "Context projection probe"));
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
      const createdResult = (created?.structuredContent as {
        result?: { plan?: { id?: string; steps?: unknown } };
      } | undefined)?.result;
      const planId = createdResult?.plan?.id;
      expect(planId).toMatch(/^pm-/);
      expect(createdResult?.plan).not.toHaveProperty("steps");

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

      const shownDefault = await handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "pm_plan",
          arguments: {
            path: context.pmPath,
            id: planId,
            options: {
              subcommand: "show",
            },
          },
        },
      });
      expect(shownDefault?.isError).not.toBe(true);
      const shownDefaultResult = (shownDefault?.structuredContent as {
        result?: { plan?: Record<string, unknown> };
      } | undefined)?.result;
      expect(shownDefaultResult?.plan).not.toHaveProperty("steps");

      const shownDeep = await handleRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "pm_plan",
          arguments: {
            path: context.pmPath,
            id: planId,
            options: {
              subcommand: "show",
              depth: "deep",
            },
          },
        },
      });
      expect(shownDeep?.isError).not.toBe(true);
      const shownDeepResult = (shownDeep?.structuredContent as {
        result?: { plan?: { steps?: Array<Record<string, unknown>> } };
      } | undefined)?.result;
      expect(Array.isArray(shownDeepResult?.plan?.steps)).toBe(true);
      expect(shownDeepResult?.plan?.steps?.[0]).toMatchObject({ title: "Read code" });
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

  it("supports pm_contracts flags-only projection for compact command contract reads", async () => {
    await withTempPmPath(async (context) => {
      const fullContracts = await handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "pm_contracts",
          arguments: {
            path: context.pmPath,
            options: {
              command: "health",
            },
          },
        },
      });
      expect(fullContracts?.isError).not.toBe(true);
      const fullResult = (fullContracts?.structuredContent as {
        result?: Record<string, unknown>;
      } | undefined)?.result;
      expect(fullResult).toHaveProperty("runtime_schema");
      expect(fullResult).toHaveProperty("command_flags");

      const flagsOnlyContracts = await handleRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "pm_contracts",
          arguments: {
            path: context.pmPath,
            options: {
              command: "health",
              flagsOnly: true,
            },
          },
        },
      });
      expect(flagsOnlyContracts?.isError).not.toBe(true);
      const flagsOnlyResult = (flagsOnlyContracts?.structuredContent as {
        result?: {
          selected?: { command?: string; flags_only?: boolean };
          command_flags?: Array<{ command?: string; flags?: Array<{ flag?: string }>; provider?: string }>;
          runtime_schema?: unknown;
        };
      } | undefined)?.result;
      expect(flagsOnlyResult?.selected).toMatchObject({ command: "health", flags_only: true });
      expect(flagsOnlyResult?.runtime_schema).toBeUndefined();
      expect(flagsOnlyResult?.command_flags?.[0]).toMatchObject({ command: "health", provider: "core" });
      expect(flagsOnlyResult?.command_flags?.[0]?.flags?.some((entry) => entry.flag === "--summary")).toBe(true);
    });
  });

  it("serializes concurrent native extension actions so registries cannot cross-corrupt (pm-bl6m)", async () => {
    await withTempPmPath(async (context) => {
      const logPath = path.join(context.tempRoot, "registry-concurrency.log");
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "concurrency-probe",
        name: "concurrency-probe",
        entrySource: [
          "import fs from 'node:fs';",
          "import { setTimeout as delay } from 'node:timers/promises';",
          `const logPath = ${JSON.stringify(logPath)};`,
          "export default {",
          "  activate(api) {",
          "    for (const probe of [{ name: 'probe-slow', wait: 120 }, { name: 'probe-fast', wait: 10 }]) {",
          "      api.registerCommand({",
          "        name: probe.name,",
          "        description: 'Registry concurrency probe command.',",
          "        run: async () => {",
          "          fs.appendFileSync(logPath, 'start:' + probe.name + '\\n', 'utf8');",
          "          await delay(probe.wait);",
          "          fs.appendFileSync(logPath, 'end:' + probe.name + '\\n', 'utf8');",
          "          return { ok: true, marker: probe.name };",
          "        },",
          "      });",
          "    }",
          "  },",
          "};",
          "",
        ].join("\n"),
      });

      const invoke = (id: number, action: string) =>
        handleRequest({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: { path: context.pmPath, action },
          },
        });

      // Fire both dynamic extension actions WITHOUT awaiting the first: the slow
      // handler is still mid-await when the fast request arrives. Pre-serialization
      // the fast request would overwrite the process-global registries mid-flight
      // and clear them before the slow handler finished (interleaved log below).
      const [slow, fast] = await Promise.all([invoke(40, "probe-slow"), invoke(41, "probe-fast")]);

      expect(slow?.isError).not.toBe(true);
      expect(fast?.isError).not.toBe(true);
      const slowResult = (slow?.structuredContent as { result?: { ok?: boolean; marker?: string } } | undefined)?.result;
      const fastResult = (fast?.structuredContent as { result?: { ok?: boolean; marker?: string } } | undefined)?.result;
      expect(slowResult).toMatchObject({ ok: true, marker: "probe-slow" });
      expect(fastResult).toMatchObject({ ok: true, marker: "probe-fast" });

      // Each set-globals -> run handler -> clear-globals cycle must be atomic:
      // one probe's start/end pair fully precedes the other's, in either order.
      const log = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(log).toHaveLength(4);
      expect([
        "start:probe-slow,end:probe-slow,start:probe-fast,end:probe-fast",
        "start:probe-fast,end:probe-fast,start:probe-slow,end:probe-slow",
      ]).toContain(log.join(","));
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

  it("routes additional built-in pm_run actions and cwd-scoped calls", async () => {
    await withTempPmPath(async (context) => {
      const stats = await handleRequest({
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            cwd: context.tempRoot,
            action: "stats",
            options: { storage: true },
          },
        },
      });
      expect(stats?.isError).not.toBe(true);
      const statsResult = (stats?.structuredContent as { result?: { totals?: { items?: number }; storage?: unknown } } | undefined)?.result;
      expect(statsResult?.totals?.items).toBeGreaterThanOrEqual(0);
      expect(statsResult).toHaveProperty("storage");
      expect(process.cwd()).not.toBe(context.tempRoot);

      const aggregate = await handleRequest({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "aggregate", options: { groupBy: "status" } },
        },
      });
      expect(aggregate?.isError).not.toBe(true);

      const gc = await handleRequest({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "gc", options: { dryRun: true } },
        },
      });
      expect(gc?.isError).not.toBe(true);

      const telemetryStatus = await handleRequest({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "telemetry", subcommand: "status", limit: 1 },
        },
      });
      expect(telemetryStatus?.isError).not.toBe(true);

      const packageCatalog = await handleRequest({
        jsonrpc: "2.0",
        id: 104,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "package-catalog", options: { json: true } },
        },
      });
      expect(packageCatalog?.isError).not.toBe(true);

      const extensionReload = await handleRequest({
        jsonrpc: "2.0",
        id: 105,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "extension-reload", options: { project: true } },
        },
      });
      expect(extensionReload?.isError).not.toBe(true);

      const packageExplore = await handleRequest({
        jsonrpc: "2.0",
        id: 106,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "package", options: { project: true } },
        },
      });
      expect(packageExplore?.isError).not.toBe(true);

      const extensionExplore = await handleRequest({
        jsonrpc: "2.0",
        id: 107,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: { path: context.pmPath, action: "extension", options: { project: true } },
        },
      });
      expect(extensionExplore?.isError).not.toBe(true);
    });
  });

  it("normalizes linked-resource add/remove fields for files and docs", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP linked resource target",
        "--description",
        "MCP linked resource target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const files = await handleRequest({
        jsonrpc: "2.0",
        id: 110,
        method: "tools/call",
        params: {
          name: "pm_files",
          arguments: {
            path: context.pmPath,
            id,
            options: {
              add: "path=src/mcp/server.ts,scope=project",
              addNote: "server coverage target",
            },
          },
        },
      });
      expect(files?.isError).not.toBe(true);
      const filesResult = (files?.structuredContent as {
        result?: { files?: Array<{ path?: string; note?: string }>; changed?: boolean };
      } | undefined)?.result;
      expect(filesResult?.changed).toBe(true);
      expect(filesResult?.files).toContainEqual(expect.objectContaining({ path: "src/mcp/server.ts", note: "server coverage target" }));

      const docs = await handleRequest({
        jsonrpc: "2.0",
        id: 111,
        method: "tools/call",
        params: {
          name: "pm_docs",
          arguments: {
            path: context.pmPath,
            id,
            options: {
              add: "path=docs/AGENT_GUIDE.md,scope=project",
              addNote: "agent guide reference",
            },
          },
        },
      });
      expect(docs?.isError).not.toBe(true);
      const docsResult = (docs?.structuredContent as {
        result?: { docs?: Array<{ path?: string; note?: string }>; changed?: boolean };
      } | undefined)?.result;
      expect(docsResult?.changed).toBe(true);
      expect(docsResult?.docs).toContainEqual(expect.objectContaining({ path: "docs/AGENT_GUIDE.md", note: "agent guide reference" }));
    });
  });

  it("routes copy, claim, release, close, deps, history, test, and validate actions", async () => {
    await withTempPmPath(async (context) => {
      const create = context.runCli([
        "create",
        "--json",
        "--title",
        "MCP lifecycle target",
        "--description",
        "MCP lifecycle target description",
        "--type",
        "Task",
        "--status",
        "open",
        "--author",
        "mcp-test",
      ], { expectJson: true });
      expect(create.code).toBe(0);
      const id = (create.json as { item: { id: string } }).item.id;

      const copy = await handleRequest({
        jsonrpc: "2.0",
        id: 120,
        method: "tools/call",
        params: {
          name: "pm_copy",
          arguments: {
            path: context.pmPath,
            id,
            title: "MCP copied lifecycle target",
            author: "mcp-agent",
            message: "copy through MCP",
            idOnly: true,
          },
        },
      });
      expect(copy?.isError).not.toBe(true);
      const copyResult = (copy?.structuredContent as { result?: { id?: string; item?: unknown } } | undefined)?.result;
      expect(copyResult?.id).toMatch(/^pm-/);
      expect(copyResult?.item).toBeUndefined();

      const claim = await handleRequest({
        jsonrpc: "2.0",
        id: 121,
        method: "tools/call",
        params: { name: "pm_claim", arguments: { path: context.pmPath, id, author: "mcp-agent" } },
      });
      expect(claim?.isError).not.toBe(true);

      const release = await handleRequest({
        jsonrpc: "2.0",
        id: 122,
        method: "tools/call",
        params: { name: "pm_release", arguments: { path: context.pmPath, id, author: "mcp-agent" } },
      });
      expect(release?.isError).not.toBe(true);

      const deps = await handleRequest({
        jsonrpc: "2.0",
        id: 123,
        method: "tools/call",
        params: {
          name: "pm_deps",
          arguments: {
            path: context.pmPath,
            id,
            options: { dep: `id=${copyResult?.id},kind=related` },
          },
        },
      });
      expect(deps?.isError).not.toBe(true);

      const history = await handleRequest({
        jsonrpc: "2.0",
        id: 124,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "history", id, options: { limit: "2" } } },
      });
      expect(history?.isError).not.toBe(true);

      const filesDiscover = await handleRequest({
        jsonrpc: "2.0",
        id: 1241,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "files-discover", id } },
      });
      expect(filesDiscover?.isError).not.toBe(true);

      const historyRepair = await handleRequest({
        jsonrpc: "2.0",
        id: 1242,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "history-repair", options: { all: true, dryRun: true } } },
      });
      expect(historyRepair?.isError).not.toBe(true);

      const historyCompact = await handleRequest({
        jsonrpc: "2.0",
        id: 1243,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "history-compact", id, options: { dryRun: true } } },
      });
      expect(historyCompact?.isError).not.toBe(true);

      const validate = await handleRequest({
        jsonrpc: "2.0",
        id: 125,
        method: "tools/call",
        params: { name: "pm_validate", arguments: { path: context.pmPath, options: { checkResolution: false } } },
      });
      expect(validate?.isError).not.toBe(true);

      const testAll = await handleRequest({
        jsonrpc: "2.0",
        id: 126,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "test-all", options: { dryRun: true } } },
      });
      expect(testAll?.isError).not.toBe(true);

      const test = await handleRequest({
        jsonrpc: "2.0",
        id: 127,
        method: "tools/call",
        params: {
          name: "pm_test",
          arguments: {
            path: context.pmPath,
            id,
            options: { add: "command=node --version,scope=project,timeout_seconds=30" },
          },
        },
      });
      expect(test?.isError).not.toBe(true);

      const close = await handleRequest({
        jsonrpc: "2.0",
        id: 128,
        method: "tools/call",
        params: {
          name: "pm_close",
          arguments: { path: context.pmPath, id, text: "MCP close reason", author: "mcp-agent", options: { validateClose: "warn" } },
        },
      });
      expect(close?.isError).not.toBe(true);
    });
  });

  it("surfaces MCP error paths for required args, config, schema, and extension actions", async () => {
    await withTempPmPath(async (context) => {
      const missingAction = await handleRequest({
        jsonrpc: "2.0",
        id: 130,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(missingAction).toBeInstanceOf(Error);
      expect((missingAction as Error).message).toBe("Missing required argument: action");

      const missingConfigAction = await handleRequest({
        jsonrpc: "2.0",
        id: 131,
        method: "tools/call",
        params: { name: "pm_config", arguments: { path: context.pmPath } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((missingConfigAction as Error).message).toBe("Missing required argument: configAction");

      const badSchemaOrder = await handleRequest({
        jsonrpc: "2.0",
        id: 132,
        method: "tools/call",
        params: {
          name: "pm_schema",
          arguments: { path: context.pmPath, subcommand: "add-status", name: "blocked", order: 1.5 },
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((badSchemaOrder as Error).message).toBe("schema add-status order must be a finite integer.");

      const unknownSchema = await handleRequest({
        jsonrpc: "2.0",
        id: 133,
        method: "tools/call",
        params: { name: "pm_schema", arguments: { path: context.pmPath, subcommand: "rename-type" } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((unknownSchema as Error).message).toContain("Unknown pm schema subcommand");

      const unsupportedExtension = await handleRequest({
        jsonrpc: "2.0",
        id: 134,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "not-a-native-action" } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((unsupportedExtension as Error).message).toBe("Unsupported native pm action: not-a-native-action");

      const missingPackageInstallTarget = await handleRequest({
        jsonrpc: "2.0",
        id: 135,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "package-install" } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((missingPackageInstallTarget as Error).message).toContain("requires an extension name");

      const upgrade = await handleRequest({
        jsonrpc: "2.0",
        id: 136,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "upgrade" } },
      });
      expect(upgrade?.isError).not.toBe(true);

      const missingDeleteId = await handleRequest({
        jsonrpc: "2.0",
        id: 137,
        method: "tools/call",
        params: { name: "pm_run", arguments: { path: context.pmPath, action: "delete" } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((missingDeleteId as Error).message).toBe("Missing required argument: id");
    });
  });
});
