import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  assertExtensionDeactivated,
  createExtensionTestHarness,
} from "../../../src/sdk/testing.js";
import {
  PmClient,
  RelationshipEventStore,
  planProfileApplication,
  type ProfileCurrentState,
} from "../../../src/sdk/index.js";
import { createExtensionCommandSdk } from "../../../src/sdk/extension-command-context.js";
import {
  resetActiveExtensionRuntimeState,
  setActiveExtensionRegistrations,
} from "../../../src/core/extensions/index.js";
import vcsExtension, {
  VCS_ITEM_FIELDS,
  VCS_ITEM_TYPES,
  VCS_RELATIONSHIP_KIND,
  activate,
  buildVcsCommands,
  deactivate,
  enforceVcsMergePolicy,
  manifest,
  vcsProfile,
} from "../../../packages/pm-vcs/extensions/vcs/index.ts";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** Empty profile state used to prove the VCS archetype stages idempotently. */
function emptyState(): ProfileCurrentState {
  return {
    typesRaw: null,
    statusesRaw: null,
    fieldsRaw: null,
    workflows: [],
    settings: {},
    templates: new Map(),
    installedPackages: new Set(),
  };
}

describe("pm-vcs beyond-PM SDK exemplar", () => {
  it("registers schema, profile, seven domain commands, and the merge hook", async () => {
    const harness = await createExtensionTestHarness(vcsExtension, {
      capabilities: ["commands", "schema", "hooks"],
    });
    expect(manifest.capabilities).toEqual(["commands", "schema", "hooks"]);
    expect(vcsExtension.manifest).toBe(manifest);
    expect(vcsExtension.activate).toBe(activate);
    expect(vcsExtension.deactivate).toBe(deactivate);
    expect(buildVcsCommands().map((command) => command.name)).toEqual([
      "vcs ref-create",
      "vcs create",
      "vcs propose",
      "vcs merge",
      "vcs abandon",
      "vcs show",
      "vcs log",
    ]);
    for (const itemType of VCS_ITEM_TYPES) {
      expect(harness.assertItemType({ itemType: itemType.name }).itemType.name).toBe(itemType.name);
    }
    for (const field of VCS_ITEM_FIELDS) {
      expect(harness.assertItemField({ field: field.name }).field.name).toBe(field.name);
    }
    expect(harness.assertProfile({ profile: "vcs" }).profile.name).toBe("vcs");
    expect(harness.assertHook({ kind: "before_command" }).run).toBe(enforceVcsMergePolicy);
    assertExtensionDeactivated(await harness.deactivate());
  });

  it("stages a complete idempotent foreign-domain profile", () => {
    const plan = planProfileApplication(vcsProfile, emptyState());
    expect(plan.types.changes.map((change) => change.key)).toEqual(["Changeset", "VcsRef"]);
    expect(plan.statuses.changes.map((change) => change.key)).toEqual(["proposed", "merged", "abandoned"]);
    expect(plan.fields.changes.map((change) => change.key)).toEqual([
      "vcs_ref",
      "vcs_tree_hash",
      "vcs_parent",
      "vcs_message",
    ]);
    expect(plan.workflows.changes).toContainEqual({ type: "Changeset", status: "add" });
    expect(VCS_RELATIONSHIP_KIND).toMatchObject({
      kind: "commits_to",
      direction: "directed",
      ordering: true,
      outgoing: "one",
    });

    const reapplied = planProfileApplication(vcsProfile, {
      ...emptyState(),
      typesRaw: JSON.stringify(plan.types.file),
      statusesRaw: JSON.stringify(plan.statuses.file),
      fieldsRaw: JSON.stringify(plan.fields.file),
      workflows: plan.workflows.result,
    });
    expect(reapplied.changed).toBe(false);
  });

  it("enforces reviewed merges while leaving every other command untouched", () => {
    expect(() =>
      enforceVcsMergePolicy({
        command: "vcs merge",
        args: ["change-1"],
        options: {},
        pm_root: "/tmp/pm",
      }),
    ).toThrow(/--reviewed/);
    expect(() =>
      enforceVcsMergePolicy({
        command: "vcs merge",
        args: ["change-1"],
        options: { reviewed: true },
        pm_root: "/tmp/pm",
      }),
    ).not.toThrow();
    expect(() =>
      enforceVcsMergePolicy({
        command: "vcs log",
        args: [],
        pm_root: "/tmp/pm",
      }),
    ).not.toThrow();
  });

  it("runs create, propose, time travel, merge, projection, and rejection through the installed package", async () => {
    await withTempPmPath(async (context) => {
      const packageRoot = path.resolve("packages/pm-vcs");
      const install = await context.runCliInProcess([
        "install",
        packageRoot,
        "--project",
        "--json",
      ]);
      expect(install.code).toBe(0);
      expect(
        (
          await context.runCliInProcess([
            "profile",
            "apply",
            "vcs",
            "--json",
          ])
        ).code,
      ).toBe(0);

      const ref = await context.runCliInProcess([
        "vcs",
        "ref-create",
        "main",
        "--json",
      ], { expectJson: true });
      expect(ref.code).toBe(0);
      const refId = (ref.json as { id: string }).id;

      const created = await context.runCliInProcess([
        "vcs",
        "create",
        "Durable projection",
        "--ref",
        refId,
        "--tree-hash",
        "sha256:abc",
        "--json",
      ], { expectJson: true });
      expect(created.code, created.stderr).toBe(0);
      const changesetId = (created.json as { id: string }).id;

      const missingReview = await context.runCliInProcess([
        "vcs",
        "merge",
        changesetId,
        "--ref",
        refId,
        "--json",
      ], { expectJson: true });
      expect(missingReview.code).not.toBe(0);
      expect(missingReview.stderr).toContain("--reviewed");

      expect(
        (
          await context.runCliInProcess([
            "vcs",
            "propose",
            changesetId,
            "--json",
          ], { expectJson: true })
        ).code,
      ).toBe(0);
      const historical = await context.runCliInProcess([
        "vcs",
        "show",
        changesetId,
        "--at",
        "1",
        "--json",
      ], { expectJson: true });
      expect(historical.code).toBe(0);
      expect(
        (historical.json as { details: { reconstructed: boolean } }).details.reconstructed,
      ).toBe(true);

      const merged = await context.runCliInProcess([
        "vcs",
        "merge",
        changesetId,
        "--ref",
        refId,
        "--reviewed",
        "--json",
      ], { expectJson: true });
      expect(merged.code).toBe(0);
      expect(merged.json).toMatchObject({ id: changesetId, status: "merged" });

      const log = await context.runCliInProcess(["vcs", "log", "--json"], { expectJson: true });
      expect(log.code).toBe(0);
      expect(log.json).toMatchObject({
        action: "vcs-log",
        details: { version: 1, processed: 1 },
      });

      const sdkClient = new PmClient({
        pmRoot: context.pmPath,
        author: "packed-sdk-author",
      });
      const sdkChange = (await sdkClient.run("vcs create", {
        args: ["SDK attributed change"],
        options: { ref: refId, treeHash: "sha256:sdk" },
      })) as { id: string };
      await sdkClient.run("vcs propose", { args: [sdkChange.id] });
      await sdkClient.run("vcs merge", {
        args: [sdkChange.id],
        options: { ref: refId, reviewed: true },
      });
      const durableEvents = (await readFile(
        path.join(context.pmPath, "relationships", "vcs-events.jsonl"),
        "utf8",
      ))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { author: string });
      expect(durableEvents.at(-1)?.author).toBe("packed-sdk-author");

      const abandonedCandidate = await context.runCliInProcess([
        "vcs",
        "create",
        "Discarded change",
        "--ref",
        refId,
        "--tree-hash",
        "sha256:def",
        "--parent",
        changesetId,
        "--json",
      ], { expectJson: true });
      const abandonedId = (abandonedCandidate.json as { id: string }).id;
      const abandoned = await context.runCliInProcess([
        "vcs",
        "abandon",
        abandonedId,
        "--json",
      ], { expectJson: true });
      expect(abandoned.json).toMatchObject({ id: abandonedId, status: "abandoned" });
    });
  });

  it("executes every source command and guarded failure boundary through the host SDK context", async () => {
    await withTempPmPath(async (context) => {
      const packageRoot = path.resolve("packages/pm-vcs");
      expect(
        (await context.runCliInProcess(["install", packageRoot, "--project", "--json"])).code,
      ).toBe(0);
      expect(
        (await context.runCliInProcess(["profile", "apply", "vcs", "--json"])).code,
      ).toBe(0);
      const runtimeClient = new PmClient({
        pmRoot: context.pmPath,
        author: "vcs-runtime-author",
      });
      expect(await runtimeClient.run("vcs log", {})).toMatchObject({
        action: "vcs-log",
      });
      const harness = await createExtensionTestHarness(vcsExtension, {
        capabilities: ["commands", "schema", "hooks"],
      });
      setActiveExtensionRegistrations(harness.activation.registrations);
      onTestFinished(async () => {
        resetActiveExtensionRuntimeState();
        assertExtensionDeactivated(await harness.deactivate());
      });
      const client = PmClient.forActiveExtensionHost({
        pmRoot: context.pmPath,
        author: "vcs-source-test",
      });
      const sdk = createExtensionCommandSdk(context.pmPath, client);
      const commands = new Map(buildVcsCommands().map((command) => [command.name, command]));
      const invoke = async (
        name: string,
        args: string[] = [],
        options: Record<string, unknown> = {},
        author = "vcs-source-test",
      ) =>
        commands.get(name)!.run!({
          command: name,
          args,
          options,
          global: { author },
          pm_root: context.pmPath,
          sdk,
        });

      const ref = (await invoke("vcs ref-create", ["main"])) as { id: string };
      const change = (await invoke(
        "vcs create",
        ["Source covered"],
        { ref: ref.id, treeHash: "sha256:source", parent: "base" },
      )) as { id: string };
      await expect(
        invoke("vcs create", ["Missing ref"], {
          ref: "missing-ref",
          treeHash: "sha256:missing-ref",
        }),
      ).rejects.toThrow();
      await expect(
        invoke("vcs create", ["Wrong ref type"], {
          ref: change.id,
          treeHash: "sha256:wrong-ref-type",
        }),
      ).rejects.toThrow(/VcsRef/);
      const draft = (await invoke("vcs create", ["Abandon me"], {
        ref: ref.id,
        tree_hash: "sha256:draft",
      })) as { id: string };
      expect(await invoke("vcs show", [change.id])).toMatchObject({
        status: "draft",
        details: { reconstructed: false },
      });
      await expect(invoke("vcs merge", [change.id], { ref: ref.id })).rejects.toThrow(
        /proposed/,
      );
      await expect(invoke("vcs merge", [change.id], { ref: change.id })).rejects.toThrow(
        /VcsRef/,
      );
      await invoke("vcs propose", [change.id]);
      await expect(invoke("vcs propose", [change.id])).rejects.toThrow(/cannot move/);
      expect(await invoke("vcs show", [change.id], { at: "1" })).toMatchObject({
        details: { reconstructed: true },
      });
      await expect(invoke("vcs show", [ref.id], { at: "1" })).rejects.toThrow(
        /Changeset/,
      );
      const fallbackChange = (await invoke("vcs create", ["Fallback author"], {
        ref: ref.id,
        treeHash: "sha256:fallback",
      })) as { id: string };
      await invoke("vcs propose", [fallbackChange.id]);
      await Promise.all([
        invoke("vcs merge", [change.id], { ref: ref.id }),
        invoke("vcs merge", [fallbackChange.id], { ref: ref.id }, ""),
      ]);
      expect(await invoke("vcs log")).toMatchObject({
        details: {
          processed: 2,
          relationships: expect.arrayContaining([
            expect.stringContaining(change.id),
            expect.stringContaining(fallbackChange.id),
          ]),
        },
      });
      const store = await sdk.openRelationshipEventStore({
        nodes: [change.id, draft.id, fallbackChange.id, ref.id],
        definitions: [VCS_RELATIONSHIP_KIND],
        relativePath: "relationships/vcs-events.jsonl",
      });
      const defaultPathStore = await sdk.openRelationshipEventStore({
        nodes: [change.id, draft.id, fallbackChange.id, ref.id],
        definitions: [VCS_RELATIONSHIP_KIND],
      });
      expect(defaultPathStore.path).toContain("relationships/events.jsonl");
      await store.append({
        eventId: "second-source-merge",
        relationshipId: `changeset-${draft.id}`,
        action: "add",
        edge: { source: draft.id, target: ref.id, kind: "commits_to" },
        author: "vcs-source-test",
        timestamp: new Date().toISOString(),
        expectedVersion: 2,
      });
      await store.append({
        eventId: "remove-source-merge",
        relationshipId: `changeset-${change.id}`,
        action: "remove",
        author: "vcs-source-test",
        timestamp: new Date().toISOString(),
        expectedVersion: 3,
      });
      expect(await invoke("vcs log")).toMatchObject({
        details: {
          processed: 4,
          relationships: expect.arrayContaining([
            expect.stringContaining(draft.id),
            expect.stringContaining(fallbackChange.id),
          ]),
        },
      });
      await invoke("vcs abandon", [draft.id]);
      await expect(invoke("vcs abandon", [draft.id])).rejects.toThrow(/cannot move/);
      await expect(invoke("vcs create", ["missing"], { ref: ref.id })).rejects.toThrow(
        /--tree-hash/,
      );
      await expect(invoke("vcs ref-create")).rejects.toThrow(/ref name/);
      await expect(
        commands.get("vcs show")!.run!({
          command: "vcs show",
          args: [change.id],
          options: { at: "1" },
          global: {},
          pm_root: context.pmPath,
        }),
      ).rejects.toThrow(/SDK runtime/);
      await expect(
        commands.get("vcs show")!.run!({
          command: "vcs show",
          args: [change.id],
          options: {},
          global: {},
          pm_root: context.pmPath,
        }),
      ).rejects.toThrow(/SDK runtime/);

      const ledgerFirst = (await invoke("vcs create", ["Ledger-first retry"], {
        ref: ref.id,
        treeHash: "sha256:ledger-first",
      })) as { id: string };
      await invoke("vcs propose", [ledgerFirst.id]);
      const itemFirst = (await invoke("vcs create", ["Item-first retry"], {
        ref: ref.id,
        treeHash: "sha256:item-first",
      })) as { id: string };
      await invoke("vcs propose", [itemFirst.id]);
      const conflicting = (await invoke("vcs create", ["Conflicting retry"], {
        ref: ref.id,
        treeHash: "sha256:conflict",
      })) as { id: string };
      await invoke("vcs propose", [conflicting.id]);
      const racing = (await invoke("vcs create", ["Concurrent retry"], {
        ref: ref.id,
        treeHash: "sha256:race",
      })) as { id: string };
      await invoke("vcs propose", [racing.id]);
      const storageFailure = (await invoke("vcs create", ["Storage failure"], {
        ref: ref.id,
        treeHash: "sha256:storage-failure",
      })) as { id: string };
      await invoke("vcs propose", [storageFailure.id]);
      const missingWinner = (await invoke("vcs create", ["Missing winner"], {
        ref: ref.id,
        treeHash: "sha256:missing-winner",
      })) as { id: string };
      await invoke("vcs propose", [missingWinner.id]);
      const conflictingWinner = (await invoke("vcs create", ["Conflicting winner"], {
        ref: ref.id,
        treeHash: "sha256:conflicting-winner",
      })) as { id: string };
      await invoke("vcs propose", [conflictingWinner.id]);
      const reconciliationNodes = [
        change.id,
        draft.id,
        fallbackChange.id,
        ledgerFirst.id,
        itemFirst.id,
        conflicting.id,
        racing.id,
        storageFailure.id,
        missingWinner.id,
        conflictingWinner.id,
        ref.id,
      ];
      const reconciliationStore = await sdk.openRelationshipEventStore({
        nodes: reconciliationNodes,
        definitions: [VCS_RELATIONSHIP_KIND],
        relativePath: "relationships/vcs-events.jsonl",
      });
      const ledgerEvent = await reconciliationStore.append({
        eventId: `merge-${ledgerFirst.id}`,
        relationshipId: `changeset-${ledgerFirst.id}`,
        action: "add",
        edge: { source: ledgerFirst.id, target: ref.id, kind: "commits_to" },
        author: "failure-injection",
        timestamp: new Date().toISOString(),
      });
      expect(
        await invoke("vcs merge", [ledgerFirst.id], { ref: ref.id }),
      ).toMatchObject({ details: { event: ledgerEvent }, status: "merged" });
      expect((await client.get(ledgerFirst.id, { depth: "deep" })).item.status).toBe(
        "merged",
      );
      const retryUpdate = vi.spyOn(client, "update");
      expect(
        await invoke("vcs merge", [ledgerFirst.id], { ref: ref.id }),
      ).toMatchObject({ details: { event: ledgerEvent }, status: "merged" });
      expect(retryUpdate).not.toHaveBeenCalled();
      retryUpdate.mockRestore();
      await client.update(itemFirst.id, {
        status: "merged",
        resolution: `Merged into ${ref.id}`,
        message: "Injected item-first partial merge",
        field: [`vcs_ref=${ref.id}`],
      });
      expect(
        await invoke("vcs merge", [itemFirst.id], { ref: ref.id }),
      ).toMatchObject({
        details: { event: { eventId: `merge-${itemFirst.id}` } },
        status: "merged",
      });
      const append = RelationshipEventStore.prototype.append;
      const appendRace = vi
        .spyOn(RelationshipEventStore.prototype, "append")
        .mockImplementationOnce(async function (input) {
          const competitor = await sdk.openRelationshipEventStore({
            nodes: reconciliationNodes,
            definitions: [VCS_RELATIONSHIP_KIND],
            relativePath: "relationships/vcs-events.jsonl",
          });
          await append.call(competitor, input);
          return append.call(this, input);
        });
      onTestFinished(() => appendRace.mockRestore());
      expect(await invoke("vcs merge", [racing.id], { ref: ref.id })).toMatchObject({
        details: { event: { eventId: `merge-${racing.id}` } },
        status: "merged",
      });
      appendRace.mockRestore();
      const storageFailureRace = vi
        .spyOn(RelationshipEventStore.prototype, "append")
        .mockRejectedValueOnce(new Error("injected relationship storage failure"));
      onTestFinished(() => storageFailureRace.mockRestore());
      await expect(
        invoke("vcs merge", [storageFailure.id], { ref: ref.id }),
      ).rejects.toThrow(/injected relationship storage failure/);
      storageFailureRace.mockRestore();
      const missingWinnerRace = vi
        .spyOn(RelationshipEventStore.prototype, "append")
        .mockRejectedValueOnce(
          new TypeError(
            `Relationship event already exists: merge-${missingWinner.id}`,
          ),
        );
      onTestFinished(() => missingWinnerRace.mockRestore());
      await expect(
        invoke("vcs merge", [missingWinner.id], { ref: ref.id }),
      ).rejects.toThrow(/event conflicts/);
      missingWinnerRace.mockRestore();
      const conflictingWinnerRace = vi
        .spyOn(RelationshipEventStore.prototype, "append")
        .mockImplementationOnce(async function (input) {
          const competitor = await sdk.openRelationshipEventStore({
            nodes: reconciliationNodes,
            definitions: [VCS_RELATIONSHIP_KIND],
            relativePath: "relationships/vcs-events.jsonl",
          });
          await append.call(competitor, {
            ...input,
            relationshipId: `conflict-${conflictingWinner.id}`,
          });
          return append.call(this, input);
        });
      onTestFinished(() => conflictingWinnerRace.mockRestore());
      await expect(
        invoke("vcs merge", [conflictingWinner.id], { ref: ref.id }),
      ).rejects.toThrow(/event conflicts/);
      conflictingWinnerRace.mockRestore();
      await reconciliationStore.append({
        eventId: `merge-${conflicting.id}`,
        relationshipId: `conflict-${conflicting.id}`,
        action: "add",
        edge: { source: conflicting.id, target: ref.id, kind: "commits_to" },
        author: "failure-injection",
        timestamp: new Date().toISOString(),
      });
      await expect(
        invoke("vcs merge", [conflicting.id], { ref: ref.id }),
      ).rejects.toThrow(/event conflicts/);
      await expect(
        invoke("vcs merge", [itemFirst.id], { ref: change.id }),
      ).rejects.toThrow(/VcsRef/);
    });
  });
});
