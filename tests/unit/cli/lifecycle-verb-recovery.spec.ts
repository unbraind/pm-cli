import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import * as flagContracts from "../../../src/sdk/cli-contracts/flag-contracts.js";
import { resolveLifecycleVerbRecovery } from "../../../src/sdk/agent/command-recovery.js";
import { buildUnknownCommandGuidanceFromRuntime } from "../../../src/cli/commander-usage.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { runHistory } from "../../../src/sdk/query/history.js";
import { runGet } from "../../../src/sdk/query/get.js";

describe("unsupported lifecycle verb recovery", () => {
  it("teaches block and unblock through the supported mutation without changing the item", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Lifecycle recovery" });
      const before = await runHistory(id, {}, { path: context.pmPath });
      for (const [verb, flag] of [["block", "--blocked-by"], ["unblock", "--unset"]]) {
        const refusal = context.runCli([verb, id, "--json"]);
        expect(refusal.code).toBe(2);
        expect(refusal.stderr).toContain("pm update");
        expect(refusal.stderr).toContain(flag);
        expect(refusal.stderr).toContain("blocked-reason");
        if (verb === "unblock") expect(refusal.stderr).toContain("--unblock-note");
      }
      expect(await runHistory(id, {}, { path: context.pmPath })).toEqual(before);
      const blocker = createTestItemId(context, { title: "Actual blocker" });
      const otherBlocker = createTestItemId(context, { title: "Second blocker" });
      const block = resolveLifecycleVerbRecovery("block", ["update"])!;
      const unblock = resolveLifecycleVerbRecovery("unblock", ["update"])!;
      const fill = (args: string[], blockerId = blocker) => args.map((arg) => ({
        "<item-id>": id, "<blocker-id>": blockerId, "<reason>": "waiting", "<note>": "ready",
      })[arg] ?? arg);
      expect(context.runCli(fill(block.examples[0]!)).code).toBe(0);
      expect(context.runCli(fill(block.examples[0]!, otherBlocker)).code).toBe(0);
      expect(context.runCli(["update", id, "--dep", `id=${blocker},kind=related`]).code).toBe(0);
      const blocked = await runGet(id, { path: context.pmPath }, { full: true });
      expect(blocked.item.dependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: blocker, kind: "blocked_by" }),
        expect.objectContaining({ id: otherBlocker, kind: "blocked_by" }),
      ]));
      expect(context.runCli(fill(unblock.examples[0]!)).code).toBe(0);
      const recovered = await runGet(id, { path: context.pmPath }, { full: true });
      expect(recovered.item.blocked_by).toBeUndefined();
      expect(recovered.item.blocked_reason).toBeUndefined();
      expect(recovered.item.unblock_note).toBe("ready");
      expect(recovered.item.dependencies).toEqual([expect.objectContaining({ id: blocker, kind: "related" })]);
    });
  });

  it("preserves tracker scope in inspection retries and declines installed verbs or ambiguous paths", () => {
    const root = new Command("pm");
    root.command("update");
    const pmRoot = path.join(os.tmpdir(), "recovery-tracker");
    const recovery = buildUnknownCommandGuidanceFromRuntime("unknown command 'block'", root, new Map(), ["--pm-path", pmRoot, "--no-extensions", "block", "pm-example"]);
    expect(recovery?.suggestedRetryArgs).toEqual(["--pm-path", pmRoot, "--no-extensions", "update", "--help"]);
    for (const [verb, paths] of [["block", ["block", "update"]], ["unblock", []], ["item block", ["update"]]] as const) {
      expect(resolveLifecycleVerbRecovery(verb, paths)).toBeUndefined();
    }
    const contracts = vi.spyOn(flagContracts, "resolveSubcommandFlagContractsForCommand").mockReturnValueOnce([]);
    try { expect(resolveLifecycleVerbRecovery("unblock", ["update"])).toBeUndefined(); }
    finally { contracts.mockRestore(); }
  });
});
