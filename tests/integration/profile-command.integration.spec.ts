import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

/**
 * End-to-end coverage for the `pm profile` command and its `pm_profile` MCP tool
 * (pm-v37g / pm-bhmk): list/show/apply with an idempotent diff, plus the staged
 * schema/field/status/config/template surface and a sample item workflow.
 */
describe("pm profile command", () => {
  it("lists and shows built-in profiles", async () => {
    await withTempPmPath(async (context) => {
      const list = context.runCli(["profile", "list", "--json"], { expectJson: true });
      expect(list.code).toBe(0);
      expect((list.json as { profiles: Array<{ name: string }> }).profiles.map((p) => p.name)).toEqual([
        "agile",
        "ops",
        "research",
      ]);

      // Human (non-JSON) render path.
      const listHuman = context.runCli(["profile", "list"]);
      expect(listHuman.code).toBe(0);
      expect(listHuman.stdout).toContain("Project profiles:");

      const show = context.runCli(["profile", "show", "agile", "--json"], { expectJson: true });
      expect(show.json).toMatchObject({ action: "show", name: "agile" });
      expect((show.json as { types: string[] }).types).toEqual(["Story", "Spike"]);

      const showHuman = context.runCli(["profile", "show", "ops"]);
      expect(showHuman.code).toBe(0);
      expect(showHuman.stdout).toContain("ops — Operations");
    });
  });

  it("applies a profile idempotently and stages every dimension", async () => {
    await withTempPmPath(async (context) => {
      const dryRun = context.runCli(["profile", "apply", "agile", "--dry-run", "--json"], { expectJson: true });
      expect(dryRun.json).toMatchObject({ action: "apply", applied: false, dry_run: true, changed: true });
      expect((dryRun.json as { types: { added: string[] } }).types.added).toEqual(["Story", "Spike"]);

      // Dry-run must not have written anything.
      const beforeTypes = context.runCli(["schema", "list", "--json"], { expectJson: true });
      expect((beforeTypes.json as { custom?: unknown[] }).custom ?? []).toHaveLength(0);

      const apply = context.runCli(["profile", "apply", "agile", "--author", "tester", "--json"], { expectJson: true });
      expect(apply.json).toMatchObject({ action: "apply", applied: true, changed: true });
      expect((apply.json as { statuses: { added: string[] } }).statuses.added).toEqual(["review"]);
      expect((apply.json as { fields: { added: string[] } }).fields.added).toEqual(["story_points", "acceptance_owner"]);

      // Re-apply is a no-op (idempotent): nothing changed, human render path.
      const reapply = context.runCli(["profile", "apply", "agile"]);
      expect(reapply.code).toBe(0);
      expect(reapply.stdout).toContain("no changes");
      expect(reapply.stdout).toContain("already up to date");

      // Staged schema/fields/status/config/template are all present.
      const types = context.runCli(["schema", "list", "--json"], { expectJson: true });
      const customTypeNames = (types.json as { custom: Array<{ name: string }> }).custom.map((type) => type.name);
      expect(customTypeNames).toEqual(expect.arrayContaining(["Story", "Spike"]));

      const fields = context.runCli(["schema", "list-fields", "--json"], { expectJson: true });
      const fieldKeys = (fields.json as { fields: Array<{ key: string }> }).fields.map((f) => f.key);
      expect(fieldKeys).toEqual(expect.arrayContaining(["story_points", "acceptance_owner"]));

      const status = context.runCli(["schema", "show-status", "review", "--json"], { expectJson: true });
      expect(status.json).toMatchObject({ status: { id: "review", source: "custom", roles: ["active"] } });

      const config = context.runCli(["config", "get", "search-provider", "--json"], { expectJson: true });
      expect(JSON.stringify(config.json)).toContain("bm25");

      const templateRaw = await readFile(path.join(context.pmPath, "templates", "story.json"), "utf8");
      expect(JSON.parse(templateRaw)).toMatchObject({ name: "story", options: { type: "Story" } });

      // Sample item using a staged type + custom field.
      const created = context.runCli(
        ["create", "Story: profile-staged", "--type", "Story", "--story-points", "5", "--json"],
        { expectJson: true },
      );
      expect((created.json as { item: { type: string; story_points: number } }).item).toMatchObject({
        type: "Story",
        story_points: 5,
      });
    });
  });

  it("enforces the staged per-type workflow under strict enforcement", async () => {
    await withTempPmPath(async (context) => {
      context.runCli(["profile", "apply", "agile", "--json"], { expectJson: true });
      context.runCli(["config", "set", "governance-workflow-enforcement", "strict", "--json"], { expectJson: true });
      const create = context.runCli(["create", "Story: wf", "--type", "Story", "--json"], { expectJson: true });
      const id = (create.json as { item: { id: string } }).item.id;

      // The agile Story workflow forbids open -> closed (must go through in_progress/review).
      const disallowed = context.runCli(["update", id, "--status", "closed", "--json"]);
      expect(disallowed.code).toBe(2);
      expect(disallowed.stderr).toContain("Disallowed transition");

      const allowed = context.runCli(["update", id, "--status", "in_progress", "--json"], { expectJson: true });
      expect((allowed.json as { item: { status: string } }).item.status).toBe("in_progress");
    });
  });

  it("reports usage errors for a missing or unknown subcommand and unknown profile", async () => {
    await withTempPmPath(async (context) => {
      const missing = context.runCli(["profile"]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("requires a subcommand");

      const unknownSub = context.runCli(["profile", "frobnicate"]);
      expect(unknownSub.code).toBe(2);
      expect(unknownSub.stderr).toContain("Unknown pm profile subcommand");

      const unknownProfile = context.runCli(["profile", "show", "waterfall"]);
      expect(unknownProfile.code).toBe(2);
      expect(unknownProfile.stderr).toContain("Invalid profile");

      // --profile timing diagnostics + --quiet render suppression paths.
      const quiet = context.runCli(["profile", "apply", "ops", "--quiet", "--profile"]);
      expect(quiet.code).toBe(0);
      expect(quiet.stdout).toBe("");
    });
  });

  it("routes the pm_profile MCP tool for list, show, apply, and rejects unknown subcommands", async () => {
    await withTempPmPath(async (context) => {
      const callProfile = (args: Record<string, unknown>) =>
        handleRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "pm_profile", arguments: { path: context.pmPath, ...args } },
        });

      const list = await callProfile({ subcommand: "list" });
      expect(list?.isError).not.toBe(true);
      const listContent = list?.structuredContent as { result?: { profiles?: unknown[] } } | undefined;
      expect(listContent?.result?.profiles).toHaveLength(3);

      const show = await callProfile({ subcommand: "show", name: "research" });
      const showContent = show?.structuredContent as { result?: { name?: string } } | undefined;
      expect(showContent?.result?.name).toBe("research");

      const apply = await callProfile({ subcommand: "apply", name: "ops", dryRun: true, author: "mcp", force: false });
      const applyContent = apply?.structuredContent as
        | { result?: { applied?: boolean; changed?: boolean } }
        | undefined;
      expect(applyContent?.result).toMatchObject({
        applied: false,
        changed: true,
      });

      // Nested-options path: subcommand/name/flags supplied under `options`.
      const listViaOptions = await callProfile({ options: { subcommand: "list" } });
      const listViaOptionsContent = listViaOptions?.structuredContent as
        | { result?: { profiles?: unknown[] } }
        | undefined;
      expect(listViaOptionsContent?.result?.profiles).toHaveLength(3);

      const applyViaOptions = await callProfile({
        subcommand: "apply",
        options: { name: "agile", dryRun: true, author: "x", force: true },
      });
      const applyViaOptionsContent = applyViaOptions?.structuredContent as { result?: { name?: string } } | undefined;
      expect(applyViaOptionsContent?.result?.name).toBe("agile");

      await expect(callProfile({ subcommand: "frobnicate" })).rejects.toThrow(/Unknown pm profile subcommand/);
    });
  });
});
