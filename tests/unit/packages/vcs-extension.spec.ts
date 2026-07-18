import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExtensionDeactivated,
  createExtensionTestHarness,
} from "../../../src/sdk/testing.js";
import {
  PmClient,
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
      await invoke("vcs merge", [change.id], { ref: ref.id });
      const fallbackChange = (await invoke("vcs create", ["Fallback author"], {
        ref: ref.id,
        treeHash: "sha256:fallback",
      })) as { id: string };
      await invoke("vcs propose", [fallbackChange.id]);
      await invoke("vcs merge", [fallbackChange.id], { ref: ref.id }, "");
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
      resetActiveExtensionRuntimeState();
      assertExtensionDeactivated(await harness.deactivate());
    });
  });
});
