import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PmClient, commitItemMutations, runAction, runInActiveExtensionScope, runWithActiveExtensions } from "../../../../src/sdk/index.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const author = "scope-test";
const probe = globalThis as { pmScopeActivations?: string[]; pmScopeNested?: () => Promise<unknown> };

/** Install an extension that records each activation, refuses a marked write and exposes a nesting command. */
async function installScopeExtension(pmPath: string, name: string): Promise<void> {
  await writeTestExtension({
    root: path.join(pmPath, "extensions", name),
    name,
    manifestOverrides: { capabilities: ["hooks", "commands"] },
    entrySource: `export default { activate(api) {
      (globalThis.pmScopeActivations ??= []).push(${JSON.stringify(name)});
      api.hooks.beforeMutation((context) => context.after?.metadata.sprint === ${JSON.stringify(`refused-by-${name}`)}
        ? { allow: false, code: ${JSON.stringify(`${name}_denied`)}, remediation: "Use another sprint." } : { allow: true });
      api.registerCommand({ name: "scope nest", action: "scope-nest", run: () => globalThis.pmScopeNested() });
    } };`,
  });
}

async function seed(pmPath: string): Promise<string> {
  return (await new PmClient({ pmRoot: pmPath, noExtensions: true }).create({ title: "Seed", type: "Task" })).item.id;
}

/** Run with two independent trackers; only the second has the named extension unless `both` is set. */
async function withTwoTrackers(run: (first: { pmPath: string; id: string }, second: { pmPath: string; id: string }) => Promise<void>): Promise<void> {
  await withTempPmPath(async ({ pmPath: firstPath }) => {
    await withTempPmPath(async ({ pmPath: secondPath }) => {
      await run({ pmPath: firstPath, id: await seed(firstPath) }, { pmPath: secondPath, id: await seed(secondPath) });
    });
  });
}

afterEach(() => {
  delete probe.pmScopeActivations;
  delete probe.pmScopeNested;
});

describe("active extension scope is bound to its tracker (pm-zi34i1)", () => {
  it("judges a nested write to another tracker with that tracker's guards on every direct call path", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await installScopeExtension(second.pmPath, "beta");
      const finalize = (pmRoot: string, id: string, sprint: string, transactionId: string) =>
        commitItemMutations({ pmRoot, author, transactionId, mutations: [{ op: "finalize", id, set: { sprint } }] });
      await runWithActiveExtensions({ path: first.pmPath }, async () => {
        // Each tracker's own guard refuses; the other tracker's marker is an ordinary value there.
        await expect(finalize(second.pmPath, second.id, "refused-by-beta", "nested-direct")).rejects.toMatchObject({ context: { code: "beta_denied" } });
        await expect(new PmClient({ pmRoot: second.pmPath, author }).commitItemMutations({ transactionId: "nested-client", mutations: [{ op: "finalize", id: second.id, set: { sprint: "refused-by-beta" } }] }))
          .rejects.toMatchObject({ context: { code: "beta_denied" } });
        await expect(runAction({ action: "update", path: second.pmPath, id: second.id, author, options: { sprint: "refused-by-beta" } })).rejects.toMatchObject({ context: { code: "beta_denied" } });
        await expect(runInActiveExtensionScope(second.pmPath, () => finalize(second.pmPath, second.id, "refused-by-beta", "nested-scope"))).rejects.toMatchObject({ context: { code: "beta_denied" } });
        await expect(runWithActiveExtensions({ path: second.pmPath }, () => finalize(second.pmPath, second.id, "refused-by-beta", "nested-open"))).rejects.toMatchObject({ context: { code: "beta_denied" } });
        await expect(finalize(second.pmPath, second.id, "refused-by-alpha", "nested-foreign-marker")).resolves.toMatchObject({ status: "committed" });
        // The caller's own registrations are restored after each nested activation.
        await expect(finalize(first.pmPath, first.id, "refused-by-alpha", "outer-after-nested")).rejects.toMatchObject({ context: { code: "alpha_denied" } });
        await expect(finalize(first.pmPath, first.id, "refused-by-beta", "outer-foreign-marker")).resolves.toMatchObject({ status: "committed" });
      });
      expect(probe.pmScopeActivations?.filter((name) => name === "alpha")).toHaveLength(1);
      const reader = new PmClient({ pmRoot: second.pmPath, noExtensions: true });
      expect((await reader.get(second.id)).item).toMatchObject({ sprint: "refused-by-alpha" });
    });
  });

  it("reuses the open scope for the same tracker under any spelling, without a second activation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await installScopeExtension(pmPath, "alpha");
      const id = await seed(pmPath);
      const alias = path.join(await mkdtemp(path.join(os.tmpdir(), "pm-scope-alias-")), "tracker");
      await symlink(pmPath, alias, "junction");
      await runWithActiveExtensions({ path: pmPath }, async () => {
        await runAction({ action: "get", path: alias, id });
        await runInActiveExtensionScope(alias, async () => undefined);
        await runWithActiveExtensions({ path: alias }, async () => undefined);
        await new PmClient({ pmRoot: alias, author }).commitItemMutations({ transactionId: "same-root", mutations: [{ op: "finalize", id, set: { sprint: "kept" } }] });
        // The reused scope carries the activated runtime, so an extension action dispatches inside it.
        probe.pmScopeNested = async () => "nested";
        await expect(runAction({ action: "scope-nest", path: alias })).resolves.toBe("nested");
      });
      expect(probe.pmScopeActivations).toEqual(["alpha"]);
    });
  });

  it("publishes the scope a dispatch holds, so a command with an explicit cwd can nest work for its tracker", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      await installScopeExtension(pmPath, "alpha");
      const id = await seed(pmPath);
      probe.pmScopeNested = async () => {
        const viaScope = await runInActiveExtensionScope(pmPath, async () => "scope");
        const viaOpen = await runWithActiveExtensions({ path: pmPath }, async () => "open");
        const viaAction = (await runAction({ action: "get", path: pmPath, id })) as { item: { id: string } };
        return [viaScope, viaOpen, viaAction.item.id];
      };
      await expect(runAction({ action: "scope-nest", path: pmPath, cwd: tempRoot })).resolves.toEqual(["scope", "open", id]);
      await expect(runAction({ action: "scope-nest", path: pmPath })).resolves.toEqual(["scope", "open", id]);
      expect(probe.pmScopeActivations).toEqual(["alpha", "alpha"]);
    });
  });

  it("gives a nested call that disables extensions empty registries, and refuses a nested cwd change", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      await installScopeExtension(pmPath, "alpha");
      const id = await seed(pmPath);
      const marked = { sprint: "refused-by-alpha" };
      probe.pmScopeNested = async () => {
        await expect(runAction({ action: "update", path: pmPath, id, author, options: marked })).rejects.toMatchObject({ context: { code: "alpha_denied" } });
        // The per-call override is honored under the caller's live scope.
        await runAction({ action: "update", path: pmPath, id, author, noExtensions: true, options: marked });
        await expect(runAction({ action: "scope-nest", path: pmPath, noExtensions: true })).rejects.toThrow("Unsupported native pm action");
        // A cwd naming the current directory is a no-op; another directory cannot be entered from inside the scope.
        await runAction({ action: "get", path: pmPath, id, cwd: process.cwd() });
        await expect(runAction({ action: "get", path: pmPath, id, cwd: tempRoot })).rejects.toMatchObject({ context: { reason: "nested_cwd_unavailable", field: "cwd" } });
        await expect(runWithActiveExtensions({ path: pmPath, cwd: tempRoot }, async () => undefined)).rejects.toMatchObject({ context: { reason: "nested_cwd_unavailable" } });
        await expect(new PmClient({ pmRoot: pmPath, cwd: tempRoot, author }).commitItemMutations({ transactionId: "nested-cwd", mutations: [{ op: "finalize", id, set: { sprint: "x" } }] })).rejects.toMatchObject({ context: { reason: "nested_cwd_unavailable" } });
        return "done";
      };
      await expect(runAction({ action: "scope-nest", path: pmPath })).resolves.toBe("done");
      expect((await new PmClient({ pmRoot: pmPath, noExtensions: true }).get(id)).item).toMatchObject(marked);
    });
  });

  it("expires a scope when its callback settles, so deferred work activates for itself", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await installScopeExtension(pmPath, "alpha");
      let deferred: (() => Promise<unknown>) | undefined;
      await runWithActiveExtensions({ path: pmPath }, async () => {
        // Captured inside the scope: the async context still carries the scope record after it ends.
        deferred = AsyncLocalStorage.bind(() => runWithActiveExtensions({ path: pmPath }, async () => "late"));
      });
      await expect(deferred!()).resolves.toBe("late");
      expect(probe.pmScopeActivations).toEqual(["alpha", "alpha"]);
    });
  });

  it("runs work resumed from a settled nested scope under the live ancestor's slot, with fresh registries", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await installScopeExtension(second.pmPath, "beta");
      // The outer scope holds the exclusive slot (explicit cwd); queueing behind it from inside would never finish.
      await runWithActiveExtensions({ path: first.pmPath, cwd: process.cwd() }, async () => {
        let resumed: (() => Promise<unknown>) | undefined;
        await runWithActiveExtensions({ path: second.pmPath }, async () => {
          resumed = AsyncLocalStorage.bind(() => commitItemMutations({ pmRoot: first.pmPath, author, transactionId: "resumed", mutations: [{ op: "finalize", id: first.id, set: { sprint: "refused-by-alpha" } }] }));
        });
        // The settled scope's registries are gone, so the caller's tracker is activated again instead of being judged by nothing.
        await expect(resumed!()).rejects.toMatchObject({ context: { code: "alpha_denied" } });
      });
      // Each store write of the resumed commit activates the caller's tracker for itself, as it would with no scope.
      expect(probe.pmScopeActivations?.slice(0, 3)).toEqual(["alpha", "beta", "alpha"]);
      expect(probe.pmScopeActivations?.slice(2).every((name) => name === "alpha")).toBe(true);
    });
  });

  it("judges a write an extension makes to the caller's tracker while another tracker activates", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await writeTestExtension({
        root: path.join(second.pmPath, "extensions", "writer"),
        name: "writer",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: "export default { async activate() { globalThis.pmScopeLifecycle = await globalThis.pmScopeNested().then(() => 'written', (error) => error.context?.code); } };",
      });
      probe.pmScopeNested = () => runInActiveExtensionScope(first.pmPath, () => commitItemMutations({ pmRoot: first.pmPath, author, transactionId: "lifecycle", mutations: [{ op: "finalize", id: first.id, set: { sprint: "refused-by-alpha" } }] }));
      await runWithActiveExtensions({ path: first.pmPath }, () => runWithActiveExtensions({ path: second.pmPath }, async () => undefined));
      expect((globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle).toBe("alpha_denied");
      delete (globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle;
      // The same callback addressing its own, still activating tracker is refused: its guards are not in place yet.
      probe.pmScopeNested = () => runInActiveExtensionScope(second.pmPath, async () => "unguarded");
      await runWithActiveExtensions({ path: first.pmPath }, () => runWithActiveExtensions({ path: second.pmPath }, async () => undefined));
      expect((globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle).toBe("invalid_argument_value");
      delete (globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle;
      // An injected host client takes the same refusal: sharing registrations needs a tracker that finished activating.
      const host = PmClient.forActiveExtensionHost({ pmRoot: second.pmPath, author });
      probe.pmScopeNested = () => host.update(second.id, { sprint: "unguarded" } as never);
      await runWithActiveExtensions({ path: first.pmPath }, () => runWithActiveExtensions({ path: second.pmPath }, async () => undefined));
      expect((globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle).toBe("invalid_argument_value");
      delete (globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle;
    });
  });

  it("records the tracker a relative cwd and path actually activate", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      await installScopeExtension(pmPath, "alpha");
      const id = await seed(pmPath);
      const previous = process.cwd();
      process.chdir(path.dirname(tempRoot));
      try {
        const relativeCwd = path.basename(tempRoot);
        await runWithActiveExtensions({ cwd: relativeCwd, path: path.relative(tempRoot, pmPath) }, async () => {
          probe.pmScopeNested = async () => "same tracker";
          await expect(runAction({ action: "scope-nest", path: pmPath })).resolves.toBe("same tracker");
          await expect(runAction({ action: "update", path: pmPath, id, author, options: { sprint: "refused-by-alpha" } })).rejects.toMatchObject({ context: { code: "alpha_denied" } });
        });
      } finally {
        process.chdir(previous);
      }
      expect(probe.pmScopeActivations).toEqual(["alpha"]);
    });
  });

  it("judges an injected host client's write to another tracker with that tracker's guards", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await installScopeExtension(second.pmPath, "beta");
      const host = PmClient.forActiveExtensionHost({ pmRoot: first.pmPath, author });
      probe.pmScopeNested = async () => {
        await expect(host.run("update", { path: second.pmPath, id: second.id, options: { sprint: "refused-by-beta" } })).rejects.toMatchObject({ context: { code: "beta_denied" } });
        await host.run("update", { path: second.pmPath, id: second.id, options: { sprint: "refused-by-alpha" } });
        // A host client cannot change the working directory under the live scope either.
        await expect(host.run("update", { cwd: os.tmpdir(), id: first.id, options: { sprint: "elsewhere" } })).rejects.toMatchObject({ context: { reason: "nested_cwd_unavailable" } });
        // For its own tracker the host client keeps sharing the host's registrations.
        await expect(host.update(first.id, { sprint: "refused-by-alpha" } as never)).rejects.toMatchObject({ context: { code: "alpha_denied" } });
        return "done";
      };
      await expect(runAction({ action: "scope-nest", path: first.pmPath })).resolves.toBe("done");
    });
  });

  it("judges a host client's write resumed from a settled nested scope with a fresh activation of its tracker", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await installScopeExtension(second.pmPath, "beta");
      const host = PmClient.forActiveExtensionHost({ pmRoot: first.pmPath, author });
      await runWithActiveExtensions({ path: first.pmPath, cwd: process.cwd() }, async () => {
        let resumed: (() => Promise<unknown>) | undefined;
        await runWithActiveExtensions({ path: second.pmPath }, async () => {
          resumed = AsyncLocalStorage.bind(() => host.update(first.id, { sprint: "refused-by-alpha" } as never));
        });
        // The callback carries the settled scope's cleared registries; the live ancestor's root matching is not enough to share them.
        await expect(resumed!()).rejects.toMatchObject({ context: { code: "alpha_denied" } });
      });
      expect(probe.pmScopeActivations).toEqual(["alpha", "beta", "alpha"]);
    });
  });

  it("activates a host client's tracker through the gate once every scope its context carried has settled", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await installScopeExtension(pmPath, "alpha");
      const id = await seed(pmPath);
      const host = PmClient.forActiveExtensionHost({ pmRoot: pmPath, author });
      let deferred: (() => Promise<unknown>) | undefined;
      await runWithActiveExtensions({ path: pmPath }, async () => {
        deferred = AsyncLocalStorage.bind(() => host.update(id, { sprint: "refused-by-alpha" } as never));
      });
      // The context still carries the expired scope; that is no CLI host with registrations in place.
      await expect(deferred!()).rejects.toMatchObject({ context: { code: "alpha_denied" } });
      expect(probe.pmScopeActivations).toEqual(["alpha", "alpha"]);
      // With an explicit cwd the activation takes the gate's exclusive slot, as any top-level call does.
      await runWithActiveExtensions({ path: pmPath }, async () => {
        deferred = AsyncLocalStorage.bind(() => host.run("update", { cwd: process.cwd(), id, options: { sprint: "refused-by-alpha" } }));
      });
      await expect(deferred!()).rejects.toMatchObject({ context: { code: "alpha_denied" } });
    });
  });

  it("refuses a lifecycle callback's host call while a deferred host call reactivates the tracker, instead of waiting on its own slot", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTestExtension({
        root: path.join(pmPath, "extensions", "writer"),
        name: "writer",
        manifestOverrides: { capabilities: ["hooks"] },
        entrySource: "export default { async activate() { globalThis.pmScopeLifecycle = await (globalThis.pmScopeNested?.() ?? Promise.resolve()).then(() => 'ran', (error) => error.context?.reason); } };",
      });
      const id = await seed(pmPath);
      const host = PmClient.forActiveExtensionHost({ pmRoot: pmPath, author });
      let deferred: (() => Promise<unknown>) | undefined;
      await runWithActiveExtensions({ path: pmPath }, async () => {
        deferred = AsyncLocalStorage.bind(() => host.run("update", { cwd: process.cwd(), id, options: { sprint: "deferred" } }));
      });
      probe.pmScopeNested = () => host.update(id, { sprint: "from-activate" } as never);
      await expect(deferred!()).resolves.toBeDefined();
      expect((globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle).toBe("extension_scope_not_ready");
      delete (globalThis as { pmScopeLifecycle?: unknown }).pmScopeLifecycle;
    });
  });

  it("judges a host client's direct transaction by its own tracker when another tracker's scope is open", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(first.pmPath, "alpha");
      await installScopeExtension(second.pmPath, "beta");
      const host = PmClient.forActiveExtensionHost({ pmRoot: first.pmPath, author });
      await runWithActiveExtensions({ path: second.pmPath }, async () => {
        await expect(host.commitItemMutations({ transactionId: "host-foreign-scope", mutations: [{ op: "finalize", id: first.id, set: { sprint: "refused-by-alpha" } }] }))
          .rejects.toMatchObject({ context: { code: "alpha_denied" } });
        // The open scope's marker is an ordinary value for the host's tracker.
        await host.commitItemMutations({ transactionId: "host-foreign-scope-ok", mutations: [{ op: "finalize", id: first.id, set: { sprint: "refused-by-beta" } }] });
      });
    });
  });

  it("keeps a nested disabled scope bound to the tracker it was opened for", async () => {
    await withTwoTrackers(async (first, second) => {
      await installScopeExtension(second.pmPath, "beta");
      await runWithActiveExtensions({ path: first.pmPath }, () =>
        runWithActiveExtensions({ path: first.pmPath, noExtensions: true }, async () => {
          await expect(commitItemMutations({ pmRoot: second.pmPath, author, transactionId: "under-disabled", mutations: [{ op: "finalize", id: second.id, set: { sprint: "refused-by-beta" } }] }))
            .rejects.toMatchObject({ context: { code: "beta_denied" } });
        }));
    });
  });
});
