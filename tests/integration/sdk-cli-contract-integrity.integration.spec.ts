import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/mcp/tool-definitions.js";
import { resolveWorkspaceRoot } from "../../src/core/store/paths.js";
import { anchorLinkedPath } from "../../src/sdk/linked-artifacts.js";
import { runAction } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface JsonErrorEnvelope {
  code: string;
  detail: string;
}

function itemId(payload: unknown): string {
  return (payload as { item: { id: string } }).item.id;
}

function schemaProperties(toolName: string): Record<string, unknown> {
  const tool = TOOLS.find(({ name }) => name === toolName);
  expect(tool).toBeDefined();
  return (tool?.inputSchema.properties ?? {}) as Record<string, unknown>;
}

describe("SDK and CLI contract integrity", () => {
  it("resolves standard and root-layout workspaces with stable path forms", () => {
    expect(resolveWorkspaceRoot("/repo/.agents/pm")).toBe(path.resolve("/repo"));
    expect(resolveWorkspaceRoot("/tracker-root")).toBe(path.resolve("/tracker-root"));
    expect(anchorLinkedPath("https://example.test/design", "/repo", "/repo/pkg")).toBe(
      "https://example.test/design",
    );
    expect(anchorLinkedPath("/shared/design.md", "/repo", "/repo/pkg")).toBe("/shared/design.md");
    expect(anchorLinkedPath("src/design.md", "/repo", "/repo/pkg")).toBe("pkg/src/design.md");
    expect(anchorLinkedPath("src/design.md", "/repo", "/external/pkg")).toBe("src/design.md");
  });

  it("anchors linked paths to the workspace when invoked from a nested directory", async () => {
    await withTempPmPath(async (context) => {
      const nestedDirectory = path.join(context.tempRoot, "packages", "app");
      await mkdir(path.join(nestedDirectory, "src"), { recursive: true });
      await writeFile(path.join(nestedDirectory, "src", "entry.ts"), "export {};\n", "utf8");
      await writeFile(path.join(nestedDirectory, "src", "discovered.ts"), "export {};\n", "utf8");

      const created = context.runCli(["create", "Linked path owner", "--type", "Task", "--json"], {
        expectJson: true,
      });
      const id = itemId(created.json);
      const added = context.runCli(
        ["files", id, "--add", "path=src/entry.ts,scope=project", "--validate-paths", "--json"],
        { cwd: nestedDirectory, expectJson: true },
      );

      expect(added.code).toBe(0);
      expect(added.json).toMatchObject({
        files: [{ path: "packages/app/src/entry.ts", scope: "project" }],
        validation: { existing_files: ["packages/app/src/entry.ts"], missing_paths: [] },
      });
      const independentValidation = context.runCli(
        ["validate", "--check-files", "--json"],
        { expectJson: true },
      );
      expect(independentValidation.code).toBe(0);
      expect(
        (independentValidation.json as { warnings: string[] }).warnings,
      ).not.toContain("validate_files_missing_linked_paths:1");

      expect(
        context.runCli(["update", id, "--body", "See src/discovered.ts", "--json"], {
          cwd: nestedDirectory,
          expectJson: true,
        }).code,
      ).toBe(0);
      const discovered = context.runCli(["files", "discover", id, "--apply", "--json"], {
        cwd: nestedDirectory,
        expectJson: true,
      });
      expect(discovered.code).toBe(0);
      expect(discovered.json).toMatchObject({
        added: [{ path: "packages/app/src/discovered.ts", scope: "project" }],
      });
    });
  });

  it("surfaces dangling parent references through every dependency projection", async () => {
    await withTempPmPath(async (context) => {
      const parent = context.runCli(["create", "Parent", "--type", "Task", "--json"], { expectJson: true });
      const parentId = itemId(parent.json);
      const child = context.runCli(
        ["create", "Child", "--type", "Task", "--parent", parentId, "--json"],
        { expectJson: true },
      );
      const childId = itemId(child.json);
      expect(context.runCli(["delete", parentId, "--force", "--json"], { expectJson: true }).code).toBe(0);

      const summary = context.runCli(["deps", childId, "--summary", "--json"], { expectJson: true });
      const tree = context.runCli(["deps", childId, "--json"], { expectJson: true });
      const graph = context.runCli(["deps", childId, "--format", "graph", "--json"], { expectJson: true });

      expect(summary.json).toMatchObject({ missing_count: 1 });
      expect(JSON.stringify(tree.json)).toContain(parentId);
      expect(JSON.stringify(tree.json)).toContain("parent");
      expect(JSON.stringify(graph.json)).toContain(parentId);
      expect(JSON.stringify(graph.json)).toContain("parent");

      const duplicateChild = context.runCli(
        [
          "create",
          "Child with explicit parent edge",
          "--type",
          "Task",
          "--parent",
          childId,
          "--dep",
          `id=${childId},kind=parent,author=test-author,created_at=now`,
          "--json",
        ],
        { expectJson: true },
      );
      const duplicateChildId = itemId(duplicateChild.json);
      expect(context.runCli(["delete", childId, "--force", "--json"], { expectJson: true }).code).toBe(0);
      expect(
        context.runCli(["deps", duplicateChildId, "--summary", "--json"], { expectJson: true }).json,
      ).toMatchObject({ missing_count: 1 });
    });
  });

  it("reports no-op mutation truthfully and rejects invalid core values before writes", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "Stable title", "--type", "Task", "--json"], { expectJson: true });
      const id = itemId(created.json);
      const noOp = context.runCli(
        ["update", id, "--title", "Stable title", "--no-changed-fields", "--json"],
        { expectJson: true },
      );
      expect(noOp.json).toMatchObject({ changed_field_count: 0 });

      const blankUpdate = context.runCli(["update", id, "--title", "   ", "--json"]);
      expect(blankUpdate.code).toBe(2);
      expect((JSON.parse(blankUpdate.stderr) as JsonErrorEnvelope).detail).toContain(
        "pass a non-empty title with --title",
      );
      expect(blankUpdate.stderr).not.toContain("pm create");

      for (const args of [
        ["create", "--title", "   ", "--type", "Task", "--json"],
        ["create", "Estimate", "--type", "Task", "--estimated-minutes", "-1", "--json"],
        ["update", id, "--estimated-minutes", "1.5", "--json"],
        ["update-many", "--ids", id, "--estimated-minutes", "nope", "--dry-run", "--json"],
        ["list", "--status", "not-a-status", "--json"],
        ["aggregate", "--sum", "estimated_minutez", "--json"],
      ]) {
        const result = context.runCli(args);
        expect(result.code, args.join(" ")).toBe(2);
        expect((JSON.parse(result.stderr) as JsonErrorEnvelope).detail.length).toBeGreaterThan(0);
      }

      const unchanged = context.runCli(["get", id, "--json"], { expectJson: true });
      expect((unchanged.json as { item: { title: string; estimated_minutes?: number } }).item).toMatchObject({
        title: "Stable title",
      });
      expect((unchanged.json as { item: { estimated_minutes?: number } }).item.estimated_minutes).toBeUndefined();
    });
  });

  it("declares every supported narrow-copy mutation option at the MCP top level", () => {
    expect(Object.keys(schemaProperties("pm_copy"))).toEqual(
      expect.arrayContaining(["id", "title", "author", "message", "fullChangedFields", "idOnly", "options"]),
    );
  });

  it("forwards declared top-level copy options through the native MCP action bridge", async () => {
    await withTempPmPath(async (context) => {
      const source = context.runCli(["create", "Copy source", "--type", "Task", "--json"], {
        expectJson: true,
      });
      const copied = (await runAction({
        action: "copy",
        id: itemId(source.json),
        title: "Top-level copy title",
        author: "mcp-copy-author",
        message: "top-level copy message",
        path: context.pmPath,
      })) as { item: { id: string; title: string } };

      expect(copied.item.title).toBe("Top-level copy title");
      const history = context.runCli(["history", copied.item.id, "--full", "--json"], { expectJson: true });
      expect(
        (history.json as { history: Array<{ author: string; message?: string }> }).history.at(-1),
      ).toMatchObject({ author: "mcp-copy-author" });
      expect(
        (history.json as { history: Array<{ message?: string }> }).history.at(-1)?.message,
      ).toContain("top-level copy message");

      const optionAuthorCopy = (await runAction({
        action: "copy",
        id: itemId(source.json),
        author: "top-level-author",
        options: { author: "nested-option-author" },
        path: context.pmPath,
      })) as { item: { id: string } };
      const optionAuthorHistory = context.runCli(
        ["history", optionAuthorCopy.item.id, "--full", "--json"],
        { expectJson: true },
      );
      expect(
        (optionAuthorHistory.json as { history: Array<{ author: string }> }).history.at(-1),
      ).toMatchObject({ author: "nested-option-author" });
    });
  });
});
