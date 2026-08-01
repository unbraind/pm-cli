import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  assertRegisteredHook,
  createExtensionTestHarness,
  runRegisteredCommandForTest,
  runRegisteredHookForTest,
  runRegisteredMutationGuardForTest,
} from "../../../src/sdk/testing.js";
import { PmClient } from "../../../src/sdk/runtime.js";
import { createExtensionCommandSdk } from "../../../src/sdk/extension-command-context.js";
import {
  commitItemMutations,
  runWithActiveExtensions,
} from "../../../src/sdk/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { writeTestExtension } from "../../helpers/extensions.js";

describe("extension mutation platform", () => {
  it("injects a real host-bound SDK into command harness dispatch", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await client.create({
        id: "sdk-seed",
        title: "SDK seed",
        type: "Task",
        status: "open",
      });
      const harness = await createExtensionTestHarness(
        {
          activate(api) {
            api.registerCommand({
              name: "sdk probe",
              async run(context) {
                if (context.sdk === undefined) throw new Error("missing sdk");
                return context.sdk.client.list({ status: "all" });
              },
            });
          },
        },
        { capabilities: ["commands"] },
      );

      const result = await harness.runCommand({
        command: "sdk probe",
        pmRoot: pmPath,
      });
      expect(result).toMatchObject({
        handled: true,
        result: { items: [expect.objectContaining({ id: "pm-sdk-seed" })] },
      });

      const factoryResult = await harness.runCommand({
        command: "sdk probe",
        pmRoot: pmPath,
        sdkFactory: ({ pmRoot }) =>
          createExtensionCommandSdk(pmRoot, new PmClient({ pmRoot, noExtensions: true })),
      });
      expect(factoryResult).toMatchObject({ handled: true });

      await expect(
        runRegisteredCommandForTest(harness.activation.commands, {
          command: "sdk probe",
          pmRoot: pmPath,
          sdk: {} as never,
          sdkFactory: () => ({}) as never,
        }),
      ).rejects.toThrow(/sdk or sdkFactory, not both/);
    });
  });

  it("normalizes malformed, denied, and failed guard outcomes through stable diagnostics", async () => {
    const context = {
      pm_root: "/test",
      operation: "update",
      before: null,
      after: null,
      changed_fields: [],
      sdk: {
        get: async () => null,
        list: async () => [],
      },
    } as const;
    const empty = await createExtensionTestHarness({ activate() {} });
    await expect(
      runRegisteredMutationGuardForTest(empty.activation.hooks, { context }),
    ).rejects.toThrow(/registered before_mutation hook/);
    const { beforeMutation: _beforeMutation, ...legacyHooks } = empty.activation.hooks;
    await expect(
      runRegisteredMutationGuardForTest(legacyHooks as never, { context }),
    ).rejects.toThrow(/registered before_mutation hook/);
    await expect(
      runRegisteredHookForTest(legacyHooks as never, {
        kind: "before_mutation",
        context,
      } as never),
    ).rejects.toThrow(/runRegisteredMutationGuardForTest/);
    await expect(
      runRegisteredHookForTest({} as never, {
        kind: "on_read",
        context: { path: "/test/item.toon", scope: "project" },
      }),
    ).rejects.toThrow(/Hook kinds with registrations: \(none\)/);
    expect(() =>
      assertRegisteredHook(legacyHooks as never, { kind: "before_mutation" }),
    ).toThrow(/Available "before_mutation" hooks: \(none\)/);

    const allowing = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => undefined);
          api.hooks.beforeMutation(() => ({ allow: true }));
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(allowing.runMutationGuard({ context })).resolves.toBeUndefined();
    await expect(
      runRegisteredHookForTest(allowing.activation.hooks, {
        kind: "before_mutation",
        context,
      } as never),
    ).rejects.toThrow(/runRegisteredMutationGuardForTest/);

    const invalidDecision = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => null as never);
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(invalidDecision.runMutationGuard({ context })).rejects.toMatchObject({
      code: "extension_mutation_guard_invalid_decision",
    });

    const invalidDenial = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => ({
            allow: false,
            code: " ",
            remediation: " ",
          }));
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(invalidDenial.runMutationGuard({ context })).rejects.toMatchObject({
      code: "extension_mutation_guard_invalid_denial",
    });

    const nonStringDenial = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(
            () => ({ allow: false, code: null, remediation: null }) as never,
          );
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(nonStringDenial.runMutationGuard({ context })).rejects.toMatchObject({
      code: "extension_mutation_guard_invalid_denial",
    });

    const failed = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => {
            throw new Error("boom");
          });
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(failed.runMutationGuard({ context })).rejects.toMatchObject({
      code: "extension_mutation_guard_failed",
    });

    const ownedError = new PmCliError("owned", 4, { code: "guard_owned" });
    const propagating = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => {
            throw ownedError;
          });
        },
      },
      { capabilities: ["hooks"] },
    );
    await expect(propagating.runMutationGuard({ context })).rejects.toBe(ownedError);

    const stalled = await createExtensionTestHarness(
      {
        activate(api) {
          api.hooks.beforeMutation(() => new Promise(() => {}));
        },
      },
      { capabilities: ["hooks"] },
    );
    vi.useFakeTimers();
    try {
      const pending = expect(
        stalled.runMutationGuard({ context }),
      ).rejects.toMatchObject({
        code: "extension_mutation_guard_timed_out",
        exitCode: 4,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("locates extension-registered custom types through atomic, annotation, and lifecycle mutations", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "run-types"),
        name: "run-types",
        manifestOverrides: { capabilities: ["schema"] },
        entrySource:
          "export default { activate(api) { api.registerItemTypes([{ name: 'Run', folder: 'runs', aliases: ['rl-run'] }]); } };\n",
      });
      const client = new PmClient({ pmRoot: pmPath });
      const created = await client.create({
        id: "training-seed-7",
        title: "training-seed-7",
        type: "Run",
        status: "open",
      });
      const id = created.item.id;
      await client.update(id, { description: "updated through active registry" });
      await client.comments(id, { add: "annotation through active registry" });
      const batch = await runWithActiveExtensions({ path: pmPath }, () =>
        commitItemMutations({
          pmRoot: pmPath,
          transactionId: "custom-type-batch",
          author: "sdk-extension-test",
          mutations: [
            {
              op: "update",
              id,
              options: { priority: "2" },
            },
          ],
        }),
      );
      expect(batch.status).toBe("committed");
      await client.close(id, "completed");
      await client.delete(id, { force: true });
      await client.restore(id, "2", { force: true });
      await expect(client.get(id)).resolves.toMatchObject({
        item: { id, type: "Run" },
      });
    });
  });

  it("fails closed before item and history persistence when a package invariant denies a mutation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "immutable-runs"),
        name: "immutable-runs",
        manifestOverrides: { capabilities: ["hooks", "schema"] },
        entrySource: `export default {
  activate(api) {
    api.registerItemFields([{ name: "guard_marker", type: "string" }]);
    api.hooks.beforeMutation(async (context) => {
      if (context.operation === "create" && context.after?.metadata.title === "Forbidden create") {
        if (await context.sdk.get("pm-never-created") !== null) throw new Error("guard get SDK invented an item");
        return { allow: false, code: "forbidden_create", remediation: "Choose an allowed title." };
      }
      if (context.operation === "restore" && context.after?.metadata.id.endsWith("restore-run")) {
        return { allow: false, code: "forbidden_restore", remediation: "Keep this item deleted." };
      }
      if (context.operation === "delete" && context.before?.metadata.id.endsWith("immutable-run")) {
        if (context.before.metadata.guard_marker !== "preserved") throw new Error("delete guard lost its extension field");
        const visible = await context.sdk.list();
        if (!visible.some((item) => item.id === context.before.metadata.id)) throw new Error("guard list SDK lost its host binding");
        return { allow: false, code: "forbidden_delete", remediation: "Retain the immutable item." };
      }
      if (context.operation === "comment_add") {
        return { allow: false, code: "forbidden_comment", remediation: "Record context on a new version." };
      }
      if (context.operation !== "update" || context.before?.body === context.after?.body) return { allow: true };
      const current = await context.sdk.get(context.before.metadata.id);
      if (current === null) throw new Error("guard get SDK lost its host binding");
      return { allow: false, code: "immutable_run_body", message: "Run bodies are immutable", remediation: "Create a new Run version instead." };
    });
  }
};
`,
      });
      const client = new PmClient({ pmRoot: pmPath });
      const created = await client.create({
        id: "immutable-run",
        title: "Immutable run",
        type: "Task",
        status: "open",
        body: "version one",
        field: ["guard_marker=preserved"],
      });
      const id = created.item.id;
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      const beforeHistory = await readFile(historyPath, "utf8");

      await expect(
        client.create({ title: "Forbidden create", type: "Task", status: "open" }),
      ).rejects.toMatchObject({ code: "forbidden_create" });

      await expect(client.update(id, { body: "version two" })).rejects.toMatchObject({
        code: "immutable_run_body",
        exitCode: 4,
        context: { nextSteps: ["Create a new Run version instead."] },
      } satisfies Partial<PmCliError>);
      await expect(client.get(id)).resolves.toMatchObject({ item: { body: "version one" } });
      await expect(readFile(historyPath, "utf8")).resolves.toBe(beforeHistory);

      await expect(client.comments(id, { add: "forbidden context" })).rejects.toMatchObject({
        code: "forbidden_comment",
      });
      await expect(client.delete(id, { force: true })).rejects.toMatchObject({
        code: "forbidden_delete",
      });
      await expect(readFile(historyPath, "utf8")).resolves.toBe(beforeHistory);

      const restoreCandidate = await client.create({
        id: "restore-run",
        title: "Restore run",
        type: "Task",
        status: "open",
      });
      await client.delete(restoreCandidate.item.id, { force: true });
      const restoreHistoryPath = path.join(
        pmPath,
        "history",
        `${restoreCandidate.item.id}.jsonl`,
      );
      const deletedHistory = await readFile(restoreHistoryPath, "utf8");
      await expect(
        client.restore(restoreCandidate.item.id, "1", { force: true }),
      ).rejects.toMatchObject({ code: "forbidden_restore" });
      await expect(readFile(restoreHistoryPath, "utf8")).resolves.toBe(deletedHistory);
    });
  });
});
