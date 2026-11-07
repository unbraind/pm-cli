import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { formatPmCliErrorForJson } from "../../../src/cli/error-guidance.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { getGlobalOptions } from "../../../src/sdk/cli-contracts/registration-helpers.js";
import {
  assertGuardedDispatchUnchanged,
  bindInvocationExpectedRevisions,
  enrichInvocationRevisionError,
  invocationRevisionRecovery,
  invocationRewritten,
  parseWithInvocationRevisionScope,
  refuseInventoryExpectHash,
  reportInvocationRevisionScope,
} from "../../../src/cli/expected-revisions.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { bindItemRevisionScope, createItemRevisionScope } from "../../../src/sdk/lifecycle/item-revision.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const HASH = "c".repeat(64);

function itemHash(context: TempPmContext, id: string): string {
  return (context.runCli(["get", id, "--json"], { expectJson: true }).json as { item_hash: string }).item_hash;
}

function commandWithArgument(name: string): Command {
  return new Command("update").argument(`<${name}>`);
}

/** Run `body` as the parse of one CLI invocation and return that invocation's stderr warnings. */
async function inInvocation(body: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  try {
    await parseWithInvocationRevisionScope((parse) => parse(body));
  } finally {
    spy.mockRestore();
  }
  return writes.join("");
}

describe("pm-gh1576 --expect-hash invocation binding", () => {
  it("binds a bare hash to the command's <id> argument and requires a target otherwise", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Bind target" });
      const bind = (command: Command, commandPath: string, commandArgs: string[]) =>
        bindInvocationExpectedRevisions({ command, commandPath, commandArgs, expectHash: [HASH], pmRoot: context.pmPath });
      const warnings = await inInvocation(async () => {
        await bind(commandWithArgument("id"), "update", [id]);
        await expect(bind(commandWithArgument("query"), "update", [id])).rejects.toMatchObject({ context: { code: "expect_hash_target_required" } });
        await expect(bind(new Command("update"), "update", [])).rejects.toMatchObject({ context: { code: "expect_hash_target_required" } });
        await expect(bind(commandWithArgument("id"), "Get", [id])).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE, context: { code: "expect_hash_requires_mutation" } });
        // Space-separated CLI subcommand paths classify as their native action.
        await expect(bind(commandWithArgument("id"), "package catalog", [id])).rejects.toMatchObject({ context: { code: "expect_hash_requires_mutation" } });
        // deps is a conditional mutation in the history-scope inventory, but it only reads.
        await expect(bind(commandWithArgument("id"), "deps", [id])).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE, context: { code: "expect_hash_requires_mutation" } });
      });
      expect(warnings).toContain(`expect_hash_unchecked:${id}:no_locked_write_reached_this_item`);
    });
  });

  it("detects extension overrides that rewrote the tracker or arguments, and refuses a guard on them", async () => {
    const initial = { args: ["pm-a"], path: "/tracker" };
    expect(invocationRewritten(initial, [{ args: ["pm-a"], path: "/tracker" }])).toBe(false);
    expect(invocationRewritten(initial, [{ args: ["pm-a"], path: "/other" }])).toBe(true);
    expect(invocationRewritten(initial, [{ args: ["pm-b"], path: "/tracker" }])).toBe(true);
    expect(invocationRewritten(initial, [{ args: ["pm-a", "extra"], path: "/tracker" }])).toBe(true);
    await inInvocation(async () => {
      await expect(bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: ["pm-a"], expectHash: [HASH], pmRoot: "/tracker", rewritten: true }))
        .rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE, context: { code: "expect_hash_invocation_rewritten" } });
      await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: ["pm-a"], expectHash: undefined, pmRoot: "/tracker", rewritten: true });
    });
  });

  it("refuses a final-dispatch parser pass that rewrites a guarded invocation, and only a guarded one", async () => {
    const typed = { args: ["pm-a"], path: undefined };
    assertGuardedDispatchUnchanged(typed, { args: ["pm-b"], path: undefined }, {});
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Dispatch target" });
      await inInvocation(async () => {
        assertGuardedDispatchUnchanged({ args: [id], path: undefined }, { args: ["pm-b"], path: undefined }, {});
        await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "Test-All", commandArgs: [id], expectHash: [itemHash(context, id)], pmRoot: context.pmPath });
        assertGuardedDispatchUnchanged({ args: [id], path: undefined }, { args: [id], path: undefined }, {});
        expect(() => assertGuardedDispatchUnchanged({ args: [id], path: undefined }, { args: ["pm-b"], path: undefined }, {}))
          .toThrow(expect.objectContaining({ exitCode: EXIT_CODE.USAGE, context: expect.objectContaining({ code: "expect_hash_invocation_rewritten" }) }));
        // A late --background would hand the run to a worker the guard cannot reach.
        expect(() => assertGuardedDispatchUnchanged({ args: [id], path: undefined }, { args: [id], path: undefined }, { background: true }))
          .toThrow(expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_background_unsupported" }) }));
      });
    });
  });

  it("refuses a guarded update an extension parser redirects only on its final-dispatch pass", async () => {
    await withTempPmPath(async (context) => {
      const guarded = createTestItemId(context, { title: "Guarded target" });
      const other = createTestItemId(context, { title: "Redirect target" });
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "late-redirect"),
        name: "late-redirect",
        manifestOverrides: { capabilities: ["parser"] },
        entrySource: `let calls = 0;\nexport default { activate(api) { api.registerParser("update", (context) => { calls += 1; return calls === 1 ? {} : { args: [${JSON.stringify(other)}] }; }); } };\n`,
      });
      const before = itemHash(context, other);
      const result = await context.runCliInProcess(["update", guarded, "--priority", "1", "--expect-hash", itemHash(context, guarded), "--json"]);
      expect(result.code, result.stdout).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("expect_hash_invocation_rewritten");
      expect(itemHash(context, other)).toBe(before);
    });
  });

  it("refuses a guarded test-all an extension parser moves to the background on its final-dispatch pass", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Foreground guard" });
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions", "late-background"),
        name: "late-background",
        manifestOverrides: { capabilities: ["parser"] },
        entrySource: "let calls = 0;\nexport default { activate(api) { api.registerParser(\"test-all\", (context) => { calls += 1; return calls === 1 ? {} : { options: { ...context.options, background: true } }; }); } };\n",
      });
      const result = await context.runCliInProcess(["test-all", "--expect-hash", `${id}=${itemHash(context, id)}`, "--json"]);
      expect(result.code, result.stdout).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("expect_hash_background_unsupported");
    });
  });

  it("validates and refuses a guard on inventory commands, which never write items", async () => {
    expect(() => refuseInventoryExpectHash("package inventory", undefined)).not.toThrow();
    expect(() => refuseInventoryExpectHash("package inventory", ["invalid"])).toThrow(expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_invalid" }) }));
    expect(() => refuseInventoryExpectHash("package inventory", [HASH])).toThrow(expect.objectContaining({ context: expect.objectContaining({ code: "expect_hash_requires_mutation" }) }));
    await withTempPmPath(async (context) => {
      const result = await context.runCliInProcess(["package", "inventory", "--no-extensions", "--expect-hash", "invalid", "--json"]);
      expect(result.code, result.stdout).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("expect_hash_invalid");
    });
  });

  it("refuses a stale guard on validate auto-fix with the typed conflict instead of reporting success", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(["create", "--title", "Missing estimate", "--type", "Task", "--description", "d", "--json"], { expectJson: true });
      const id = String((created.json as { item: { id: string } }).item.id);
      const stale = itemHash(context, id);
      context.runCli(["update", "--json", id, "--title", "Missing estimate, edited by a peer"], { expectJson: true });
      const fixed = await context.runCliInProcess(["validate", "--auto-fix", "--check-metadata", "--fix-scope", "estimates", "--expect-hash", `${id}=${stale}`, "--json"]);
      expect(fixed.code, fixed.stdout).toBe(EXIT_CODE.CONFLICT);
      expect(fixed.stderr).toContain("item_revision_conflict");
    });
  });

  it("binds a bare hash to the registered id argument at its actual index", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Plan-shaped target" });
      const plan = new Command("plan").argument("[subcommand]").argument("[id]").argument("[step]");
      const bind = (commandArgs: string[]) =>
        bindInvocationExpectedRevisions({ command: plan, commandPath: "plan", commandArgs, expectHash: [HASH], pmRoot: context.pmPath });
      const warnings = await inInvocation(async () => {
        await bind(["add-step", id]);
        // plan create takes its title at the id position, so it has no item to bind.
        await expect(bind(["create", "A new plan title"])).rejects.toMatchObject({ context: { code: "expect_hash_target_required" } });
      });
      expect(warnings).toContain(`expect_hash_unchecked:${id}:no_locked_write_reached_this_item`);
    });
  });

  it("is inert without tokens and leaves unrelated failures untouched", async () => {
    expect(await inInvocation(() => bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [], expectHash: undefined, pmRoot: "/tracker" }))).toBe("");
    const plain = new Error("plain");
    await expect(parseWithInvocationRevisionScope((parse) => parse(() => Promise.reject(plain)))).rejects.toBe(plain);
  });

  it("enriches a bound scope's conflict with change evidence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Enrich" });
      const scope = createItemRevisionScope();
      bindItemRevisionScope(scope, context.pmPath, [{ id, itemHash: itemHash(context, id) }]);
      const conflict = new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: HASH });
      expect(await enrichInvocationRevisionError(scope, conflict)).toMatchObject({ context: { details: { expected_revision_recorded: false } } });
      const plain = new Error("plain");
      expect(await enrichInvocationRevisionError(createItemRevisionScope(), plain)).toBe(plain);
    });
  });
});

describe("pm-gh1677 invocation-scoped revision recovery", () => {
  it("derives the tracker scope and output mode recovery reads replay", () => {
    expect(invocationRevisionRecovery({ path: "../target/.agents/pm", noExtensions: true, json: true })).toEqual({ scopeArgs: ["--pm-path", "../target/.agents/pm", "--no-extensions"], outputArgs: ["--json"] });
    expect(invocationRevisionRecovery({ path: "t", outputFormat: "json" }).outputArgs).toEqual(["--output-format", "json"]);
    // The canonical encoding wins over the legacy --json, and an explicit TOON choice is kept.
    expect(invocationRevisionRecovery({ path: "t", json: true, outputFormat: "toon" }).outputArgs).toEqual(["--output-format", "toon"]);
    expect(invocationRevisionRecovery({ path: "t" }).outputArgs).toEqual([]);
  });

  it("rescopes a bound invocation's conflict, and leaves an invocation bound without options unscoped", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Scoped enrich" });
      const conflict = () => new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: HASH, reason: "revision_changed" });
      const refusal = async (globalOptions?: Parameters<typeof invocationRevisionRecovery>[0]) => {
        let error: unknown;
        await inInvocation(async () => {
          await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath, globalOptions });
          throw conflict();
        }).catch((caught: unknown) => { error = caught; });
        return error as PmCliError;
      };
      expect((await refusal({ path: "elsewhere/.agents/pm" })).context.nextSteps).toEqual([`pm --pm-path elsewhere/.agents/pm get ${id}`, `pm --pm-path elsewhere/.agents/pm history ${id} --limit 5`]);
      // Without global options the producer's guidance is kept as it was raised.
      expect((await refusal()).context.nextSteps).toBeUndefined();
    });
  });
});

describe("pm-gh1576 --expect-hash host surfaces", () => {
  it("collects repeated root tokens into the resolved global options", async () => {
    let resolved: ReturnType<typeof getGlobalOptions> | undefined;
    const program = createPmCliProgram("0.0.0-test");
    program.command("update").argument("<id>").action((_id: string, _options: unknown, command: Command) => {
      resolved = getGlobalOptions(command);
    });
    await program.parseAsync(["node", "pm", "update", "pm-a", "--expect-hash", HASH, "--expect-hash", `pm-b=${HASH}`]);
    expect(resolved?.expectHash).toEqual([HASH, `pm-b=${HASH}`]);
    const plain = createPmCliProgram("0.0.0-test");
    plain.command("update").argument("<id>").action((_id: string, _options: unknown, command: Command) => {
      resolved = getGlobalOptions(command);
    });
    await plain.parseAsync(["node", "pm", "update", "pm-a"]);
    expect(resolved).not.toHaveProperty("expectHash");
  });

  it("renders both revisions of any compare-and-set refusal in the JSON envelope", () => {
    expect(formatPmCliErrorForJson("stale", EXIT_CODE.CONFLICT, {
      code: "item_revision_conflict",
      item_id: "pm-a",
      expected_revision: HASH,
      current_revision: "d".repeat(64),
    })).toMatchObject({ item_id: "pm-a", expected_revision: HASH, current_revision: "d".repeat(64) });
    const absent = formatPmCliErrorForJson("absent", EXIT_CODE.CONFLICT, { code: "settings_section_conflict", current_revision: null });
    expect(absent).toMatchObject({ expected_revision: null, current_revision: null });
    expect(absent).not.toHaveProperty("item_id");
    expect(formatPmCliErrorForJson("plain", EXIT_CODE.CONFLICT, { code: "stale_revision" })).not.toHaveProperty("current_revision");
  });

  it("warns once per expectation that no write evaluated", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const scope = createItemRevisionScope();
      bindItemRevisionScope(scope, "/tracker", [{ id: "pm-a", itemHash: HASH }, { id: "pm-b", itemHash: HASH }]);
      reportInvocationRevisionScope(scope);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("expect_hash_unchecked:pm-a:no_locked_write_reached_this_item");
    expect(writes.join("")).toContain("expect_hash_unchecked:pm-b:no_locked_write_reached_this_item");
  });
});

describe("pm-gh1576 invocation parse scope", () => {
  it("refuses tokens outside an invocation scope and isolates overlapping invocations", async () => {
    await withTempPmPath(async (context) => {
      const first = createTestItemId(context, { title: "Overlap A" });
      const second = createTestItemId(context, { title: "Overlap B" });
      const bind = (id: string) => bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath });
      await expect(bind(first)).rejects.toThrow("outside an invocation revision scope");
      const receipts: string[][] = [];
      let releaseFirst: () => void = () => {};
      const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const runInvocation = (id: string, hold: Promise<void>) => parseWithInvocationRevisionScope((parse) => parse(async () => {
        await hold;
        await bind(id);
      })).then(() => receipts.push([id]));
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
      try {
        const a = runInvocation(first, firstHeld);
        await runInvocation(second, Promise.resolve());
        releaseFirst();
        await a;
      } finally {
        spy.mockRestore();
      }
      // Each invocation reports only its own unchecked expectation.
      expect(writes.filter((line) => line.includes(`expect_hash_unchecked:${first}`))).toHaveLength(1);
      expect(writes.filter((line) => line.includes(`expect_hash_unchecked:${second}`))).toHaveLength(1);
      expect(receipts).toHaveLength(2);
    });
  });

  it("runs the parse inside a fresh scope and rethrows refusals with change evidence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Parse scope" });
      let parsed = false;
      await parseWithInvocationRevisionScope((parse) => parse(async () => {
        parsed = true;
      }));
      expect(parsed).toBe(true);
      const refusal = parseWithInvocationRevisionScope((parse) => parse(async () => {
        await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath });
        throw new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: HASH });
      }));
      await expect(refusal).rejects.toMatchObject({ context: { details: { expected_revision_recorded: false } } });
    });
  });
});

describe("pm-gh1576 --expect-hash through the CLI", () => {
  it("refuses a stale close with both revisions in the JSON envelope and closes on the fresh one", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "CLI close guard" });
      const decided = itemHash(context, id);
      context.runCli(["update", id, "--tags", "delivery-pr:2", "--json"], { expectJson: true });
      const stale = await context.runCliInProcess(["close", id, "Delivered by PR 1", "--expect-hash", decided, "--json"]);
      expect(stale.code).toBe(EXIT_CODE.CONFLICT);
      const envelope = JSON.parse(stale.stderr) as Record<string, unknown>;
      expect(envelope).toMatchObject({
        code: "item_revision_conflict",
        item_id: id,
        expected_revision: decided,
        current_revision: itemHash(context, id),
        details: { expected_revision_recorded: true, changes_since: [expect.objectContaining({ op: "update" })] },
      });
      const fresh = await context.runCliInProcess(["close", id, "Delivered by PR 2", "--expect-hash", `${id}=${itemHash(context, id)}`, "--json"]);
      expect(fresh.code, fresh.stderr).toBe(0);
      expect(JSON.parse(fresh.stdout)).toMatchObject({ item: { id, status: "closed" } });
    });
  });

  it("warns when no write reached the expected item and refuses read commands", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "CLI receipts" });
      const hash = itemHash(context, id);
      const listing = await context.runCliInProcess(["comments", id, "--expect-hash", hash]);
      expect(listing.code, listing.stderr).toBe(0);
      expect(listing.stderr).toContain(`expect_hash_unchecked:${id}:no_locked_write_reached_this_item`);
      const read = await context.runCliInProcess(["get", id, "--expect-hash", hash, "--json"]);
      expect(read.code).toBe(EXIT_CODE.USAGE);
      expect(read.stderr).toContain("expect_hash_requires_mutation");
      const malformed = await context.runCliInProcess(["update", id, "--priority", "2", "--expect-hash", "nope", "--json"]);
      expect(malformed.code).toBe(EXIT_CODE.USAGE);
      expect(malformed.stderr).toContain("expect_hash_invalid");
    });
  });
});
