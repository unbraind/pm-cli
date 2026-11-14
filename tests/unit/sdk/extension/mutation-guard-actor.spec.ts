/**
 * GH-1719 (pm-gh1719): transactional mutation guards receive a read-only actor
 * resolved from the mutation's own author, identical across the SDK client,
 * the CLI, MCP, previews and the commits they preview, plus a dry_run flag.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../../src/mcp/server.js";
import { PmClient } from "../../../../src/sdk/runtime.js";
import {
  commitImportedItem,
  runWithActiveExtensions,
} from "../../../../src/sdk/index.js";
import {
  activateExtensionForTest,
  runRegisteredMutationGuardForTest,
} from "../../../../src/sdk/testing.js";
import { resolveMutationActor } from "../../../../src/core/extensions/mutation-actor.js";
import { createEmptyExtensionHookRegistry, runWithPreviewMutationGuards } from "../../../../src/core/extensions/index.js";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { getItemPath } from "../../../../src/core/store/paths.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import type { BeforeMutationHookContext } from "../../../../src/core/extensions/extension-types.js";

interface GuardLogEntry {
  operation: string;
  dry_run: boolean;
  actor: BeforeMutationHookContext["actor"];
  frozen: boolean;
  changed_fields: string[];
  tags: string[];
}

const GUARD_LOG_KEY = "__pmGh1719GuardLog";

function guardLog(): GuardLogEntry[] {
  const store = globalThis as unknown as Record<string, GuardLogEntry[] | undefined>;
  store[GUARD_LOG_KEY] ??= [];
  return store[GUARD_LOG_KEY];
}

const CLAIMANT_GUARD_SOURCE = `export default {
  activate(api) {
    api.hooks.beforeMutation((context) => {
      const log = (globalThis.${GUARD_LOG_KEY} ??= []);
      log.push({ operation: context.operation, dry_run: context.dry_run, actor: context.actor, frozen: Object.isFrozen(context.actor), changed_fields: [...context.changed_fields], tags: context.after?.metadata.tags ?? [] });
      const title = context.after?.metadata.title ?? "";
      if ((context.operation === "create" || context.operation === "import") && title.startsWith("Forbidden")) {
        return { allow: false, code: "forbidden_by_actor_policy", remediation: "Use an allowed title." };
      }
      if (context.operation !== "close") return { allow: true };
      const holder = context.before?.metadata.claim_principal ?? context.before?.metadata.assignee;
      if (!holder || holder === context.actor.principal) return { allow: true };
      return { allow: false, code: "close_requires_claimant", remediation: "Ask " + holder + " to close it, or claim it first." };
    });
  }
};
`;

describe("mutation guard actor (GH-1719)", () => {
  it("lets a guard refuse a close by anyone but the claimant through the SDK client, CLI and MCP", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "claimant-close"),
        name: "claimant-close",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: CLAIMANT_GUARD_SOURCE,
      });
      guardLog().length = 0;
      const owner = new PmClient({ pmRoot: context.pmPath, author: "agent-owner" });
      const other = new PmClient({ pmRoot: context.pmPath, author: "agent-other" });
      const created = await owner.create({ id: "claimed", title: "Claimed work", type: "Task", status: "open" });
      const id = created.item.id;
      await owner.claim(id);

      await expect(other.close(id, "Not mine")).rejects.toMatchObject({
        code: "close_requires_claimant",
        exitCode: 4,
      });
      const refused = guardLog().filter((entry) => entry.operation === "close");
      expect(refused.at(-1)).toMatchObject({
        dry_run: false,
        frozen: true,
        actor: { author: "agent-other", author_source: "asserted", principal: "agent-other" },
      });

      const cli = context.runCli(["close", id, "Not mine either", "--author", "agent-other", "--json"]);
      expect(cli.code).toBe(4);
      expect(`${cli.stdout}${cli.stderr}`).toContain("close_requires_claimant");

      await expect(
        handleRequest({
          jsonrpc: "2.0",
          id: "mcp-close",
          method: "tools/call",
          params: { name: "pm_close", arguments: { path: context.pmPath, id, reason: "Via MCP", author: "agent-other" } },
        }),
      ).rejects.toMatchObject({ code: "close_requires_claimant" });

      await expect(owner.get(id)).resolves.toMatchObject({ item: { status: "open", assignee: "agent-owner" } });
      await expect(owner.close(id, "Delivered by the claimant")).resolves.toMatchObject({ item: { status: "closed" } });
      // The guard judged exactly the identity the close's history entry records.
      const closeActor = guardLog().filter((entry) => entry.operation === "close").at(-1)!.actor;
      const closeEntry = (await readHistoryEntries(path.join(context.pmPath, "history", `${id}.jsonl`), id)).at(-1)!;
      expect(closeEntry.op).toBe("close");
      expect(closeActor).toMatchObject({ author: closeEntry.author, author_source: closeEntry.author_source, principal: "agent-owner" });
      expect(closeActor.agent?.harness).toBe(closeEntry.agent_harness);
      expect(closeActor.agent?.instance).toBe(closeEntry.agent_instance);
    });
  });

  it("presents the commit's actor to the guard during a preview, as a dry run", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "claimant-close"),
        name: "claimant-close",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: CLAIMANT_GUARD_SOURCE,
      });
      const importer = new PmClient({ pmRoot: context.pmPath, author: "agent-importer" });
      const mutations = [
        { op: "create" as const, id: "pm-imported", options: { title: "Imported work", type: "Task" } },
        { op: "update" as const, id: "pm-imported", options: { risk: "low" } },
      ];
      guardLog().length = 0;
      await importer.previewItemMutations({ transactionId: "gh1719-preview", mutations });
      const previewed = guardLog().splice(0);
      await importer.commitItemMutations({ transactionId: "gh1719-preview", mutations });
      const committed = guardLog().splice(0);

      expect(previewed.length).toBeGreaterThan(0);
      expect(previewed.every((entry) => entry.dry_run)).toBe(true);
      expect(committed.every((entry) => !entry.dry_run)).toBe(true);
      const shape = (entries: GuardLogEntry[]) => entries.map(({ operation, actor }) => ({ operation, actor }));
      expect(shape(committed)).toEqual(shape(previewed));
      expect(committed[0]?.actor).toMatchObject({ author: "agent-importer", principal: "agent-importer" });

      await expect(
        importer.previewItemMutations({
          transactionId: "gh1719-denied",
          mutations: [{ op: "create", id: "pm-forbidden", options: { title: "Forbidden import", type: "Task" } }],
        }),
      ).rejects.toMatchObject({ code: "forbidden_by_actor_policy", context: { transaction_operation: { index: 0, op: "create" } } });
    });
  });

  it("judges delete dry runs, copies and package imports with the acting author", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "claimant-close"),
        name: "claimant-close",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: CLAIMANT_GUARD_SOURCE,
      });
      const client = new PmClient({ pmRoot: context.pmPath, author: "agent-curator" });
      const created = await client.create({ id: "source", title: "Source work", type: "Task", status: "open" });
      guardLog().length = 0;
      await client.delete(created.item.id, { dryRun: true });
      expect(guardLog().at(-1)).toMatchObject({ operation: "delete", dry_run: true, actor: { author: "agent-curator" } });

      guardLog().length = 0;
      await client.update(created.item.id, { body: "Copied body text" });
      guardLog().length = 0;
      await client.copy(created.item.id, { title: "Copied work" });
      expect(guardLog().at(-1)).toMatchObject({ operation: "create", dry_run: false, actor: { author: "agent-curator" } });
      expect(guardLog().at(-1)?.changed_fields).toContain("body");
      await expect(client.copy(created.item.id, { title: "Forbidden copy" })).rejects.toMatchObject({
        code: "forbidden_by_actor_policy",
      });

      const settings = await readSettings(context.pmPath);
      const importDocument = (id: string, title: string) => ({
        metadata: {
          id,
          title,
          description: "",
          type: "Task",
          status: "open",
          priority: 2,
          tags: [" Mirrored "],
          created_at: "2026-11-14T00:00:00.000Z",
          updated_at: "2026-11-14T00:00:00.000Z",
        },
        body: "Imported body",
      });
      const importOne = (id: string, title: string) =>
        runWithActiveExtensions({ path: context.pmPath }, () =>
          commitImportedItem({
            pmRoot: context.pmPath,
            id,
            itemPath: getItemPath(context.pmPath, "Task", id, "toon"),
            document: importDocument(id, title) as never,
            author: "agent-importer",
            message: "Import from an external tracker",
            settings,
            conflictWarningPrefix: "gh1719_import_lock_conflict",
          }),
        );
      guardLog().length = 0;
      await expect(importOne("pm-allowed-import", "Allowed import")).resolves.toMatchObject({ committed: true });
      // The guard judges the canonical document that is persisted, body included.
      expect(guardLog().at(-1)).toMatchObject({ operation: "import", dry_run: false, actor: { author: "agent-importer" }, tags: ["mirrored"] });
      expect(guardLog().at(-1)?.changed_fields).toEqual(expect.arrayContaining(["body", "tags", "title"]));
      await expect(client.get("pm-allowed-import")).resolves.toMatchObject({ item: { tags: ["mirrored"] } });
      // An imported value resolves that field's deferral before guards and persistence (GH-1713).
      const resolvedImport = { ...importDocument("pm-resolved-import", "Resolved import"), body: "", metadata: { ...importDocument("pm-resolved-import", "Resolved import").metadata, deadline: "2026-12-31T00:00:00.000Z", deferred_fields: [{ field: "deadline", reason: "Imported" }, { field: "assignee", reason: "Imported" }] } };
      await expect(runWithActiveExtensions({ path: context.pmPath }, () => commitImportedItem({
        pmRoot: context.pmPath, id: "pm-resolved-import", itemPath: getItemPath(context.pmPath, "Task", "pm-resolved-import", "toon"),
        document: resolvedImport as never, author: "agent-importer", message: "Import", settings, conflictWarningPrefix: "gh1719_import_lock_conflict",
      }))).resolves.toMatchObject({ committed: true });
      expect(guardLog().at(-1)?.changed_fields).not.toContain("body");
      await expect(client.get("pm-resolved-import")).resolves.toMatchObject({ item: { deferred_fields: [{ field: "assignee", reason: "Imported" }], pm_format_version: 4 } });
      // A guard denial is a refusal, never a skippable lock-conflict warning.
      await expect(importOne("pm-forbidden-import", "Forbidden import")).rejects.toMatchObject({
        code: "forbidden_by_actor_policy",
      });
      await expect(client.get("pm-forbidden-import")).rejects.toMatchObject({ exitCode: 3 });
    });
  });

  it("runs a staged preview unchanged when no guard is registered", async () => {
    const run = async () => "ran";
    await expect(runWithPreviewMutationGuards(null, run)).resolves.toBe("ran");
    await expect(runWithPreviewMutationGuards(createEmptyExtensionHookRegistry(), run)).resolves.toBe("ran");
    const { beforeMutation: _omitted, ...legacy } = createEmptyExtensionHookRegistry();
    await expect(runWithPreviewMutationGuards(legacy as never, run)).resolves.toBe("ran");
  });

  it("skips a held import lock as a conflict warning but propagates any other lock failure", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      const params = (id: string) => ({
        pmRoot: context.pmPath,
        id,
        itemPath: getItemPath(context.pmPath, "Task", id, "toon"),
        document: { metadata: { id, title: "Locked import", description: "", type: "Task", status: "open", priority: 2, tags: [], created_at: "2026-11-14T00:00:00.000Z", updated_at: "2026-11-14T00:00:00.000Z" }, body: "" } as never,
        author: "agent-importer",
        message: "Import",
        settings,
        conflictWarningPrefix: "gh1719_import_lock_conflict",
      });
      const release = await acquireLock(context.pmPath, "pm-held", 60, "another-importer");
      try {
        await expect(commitImportedItem({ ...params("pm-held"), settings: { ...settings, locks: { ...settings.locks, wait_ms: 0 } } })).resolves.toEqual({ committed: false, conflictWarning: "gh1719_import_lock_conflict:pm-held" });
      } finally {
        await release();
      }
      const blocked = path.join(context.tempRoot, "not-a-tracker");
      await writeFile(blocked, "a file where the tracker root should be");
      await expect(commitImportedItem({ ...params("pm-blocked"), pmRoot: blocked })).rejects.not.toHaveProperty("conflictWarning");
    });
  });

  it("resolves an omitted test actor from the author, and an unattributed one to the unknown actor", async () => {
    const seen: Array<BeforeMutationHookContext["actor"] & { dry_run: boolean }> = [];
    const activation = await activateExtensionForTest({
      activate(api) {
        api.hooks.beforeMutation((guard) => {
          seen.push({ ...guard.actor, dry_run: guard.dry_run });
        });
      },
    }, { capabilities: ["hooks"] });
    const base = {
      pm_root: "/tracker",
      operation: "update",
      before: null,
      after: null,
      changed_fields: [],
      sdk: { get: async () => null, list: async () => [] },
    };
    await runRegisteredMutationGuardForTest(activation.hooks, { context: base });
    await runRegisteredMutationGuardForTest(activation.hooks, { context: { ...base, author: "agent-test", dry_run: true } });
    const explicit = resolveMutationActor("harness:codex");
    await runRegisteredMutationGuardForTest(activation.hooks, { context: { ...base, actor: explicit } });
    expect(seen).toEqual([
      { author: "unknown", author_source: "unknown", principal: "unknown", dry_run: false },
      { author: "agent-test", author_source: "asserted", principal: "agent-test", dry_run: true },
      { author: "harness:codex", author_source: "detected", principal: "harness:codex", agent: { harness: "codex" }, dry_run: false },
    ]);
  });
});
