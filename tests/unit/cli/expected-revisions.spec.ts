import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { formatPmCliErrorForJson } from "../../../src/cli/error-guidance.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { getGlobalOptions } from "../../../src/sdk/cli-contracts/registration-helpers.js";
import {
  bindInvocationExpectedRevisions,
  enrichInvocationRevisionError,
  openInvocationRevisionScope,
  parseWithInvocationRevisionScope,
  reportInvocationRevisionScope,
} from "../../../src/cli/expected-revisions.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { bindItemRevisionScope, itemRevisionScopeReceipt } from "../../../src/sdk/lifecycle/item-revision.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const HASH = "c".repeat(64);

function itemHash(context: TempPmContext, id: string): string {
  return (context.runCli(["get", id, "--json"], { expectJson: true }).json as { item_hash: string }).item_hash;
}

function commandWithArgument(name: string): Command {
  return new Command("update").argument(`<${name}>`);
}

describe("pm-gh1576 --expect-hash invocation binding", () => {
  it("binds a bare hash to the command's <id> argument and requires a target otherwise", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Bind target" });
      const scope = openInvocationRevisionScope();
      await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath });
      expect(itemRevisionScopeReceipt(scope)).toEqual({ checked: [], unchecked: [id] });
      openInvocationRevisionScope();
      await expect(bindInvocationExpectedRevisions({ command: commandWithArgument("query"), commandPath: "update", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath }))
        .rejects.toMatchObject({ context: { code: "expect_hash_target_required" } });
      await expect(bindInvocationExpectedRevisions({ command: new Command("update"), commandPath: "update", commandArgs: [], expectHash: [HASH], pmRoot: context.pmPath }))
        .rejects.toMatchObject({ context: { code: "expect_hash_target_required" } });
      await expect(bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "Get", commandArgs: [id], expectHash: [HASH], pmRoot: context.pmPath }))
        .rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE, context: { code: "expect_hash_requires_mutation" } });
    });
  });

  it("is inert without tokens or an open scope, and closes only its own scope", async () => {
    const scope = openInvocationRevisionScope();
    await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: [], expectHash: undefined, pmRoot: "/tracker" });
    reportInvocationRevisionScope(scope);
    // The scope is closed, so later tokens have nothing to bind into.
    await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "update", commandArgs: ["pm-a"], expectHash: [HASH], pmRoot: "/tracker" });
    const other = openInvocationRevisionScope();
    reportInvocationRevisionScope(scope);
    const plain = new Error("plain");
    expect(await enrichInvocationRevisionError(scope, plain)).toBe(plain);
    expect(await enrichInvocationRevisionError(other, plain)).toBe(plain);
  });

  it("enriches a bound scope's conflict with change evidence", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Enrich" });
      const scope = openInvocationRevisionScope();
      await bindInvocationExpectedRevisions({ command: commandWithArgument("id"), commandPath: "close", commandArgs: [id], expectHash: [itemHash(context, id)], pmRoot: context.pmPath });
      const conflict = new PmCliError("stale", EXIT_CODE.CONFLICT, { code: "item_revision_conflict", item_id: id, expected_revision: HASH });
      expect(await enrichInvocationRevisionError(scope, conflict)).toMatchObject({ context: { details: { expected_revision_recorded: false } } });
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
      const scope = openInvocationRevisionScope();
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
