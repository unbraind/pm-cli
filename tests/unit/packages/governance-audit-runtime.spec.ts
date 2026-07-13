import { describe, expect, it } from "vitest";
import type { CommandDefinition, ExtensionApi, ServiceOverride } from "@unbrained/pm-cli/sdk";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import {
  runCommentsAuditPackage,
  runDedupeAuditPackage,
  runDedupeMergePackage,
  runNormalizePackage,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts";
import { activate } from "../../../packages/pm-governance-audit/extensions/governance-audit/index.ts";
import {
  jaccardSimilarity,
  splitCommaList,
  toErrorMessage,
  toNonEmptyStringOrUndefined,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/runtime-utils.ts";

describe("packages/pm-governance-audit runtime", () => {
  it("owns and executes all four audit workflows without core audit runners", async () => {
    await withTempPmPath(async (sandbox) => {
    const global = { path: sandbox.pmPath, json: true };

    const dedupe = await runDedupeAuditPackage({ mode: "title_exact" }, global);
    expect(dedupe).toMatchObject({ mode: "title_exact" });

    const comments = await runCommentsAuditPackage({ latest: "0" }, global);
    expect(comments).toHaveProperty("items");

    const normalize = await runNormalizePackage({ dry_run: true }, global);
    expect(normalize).toHaveProperty("dry_run", true);

    await expect(
      runDedupeMergePackage({ keep: "pm-missing", close: "pm-other" }, global),
    ).rejects.toThrow();
    });
  });

  it("normalizes package flag aliases before executing", async () => {
    await withTempPmPath(async (sandbox) => {
    const global = { path: sandbox.pmPath, json: true };
    const result = await runNormalizePackage(
      {
        filter_status: "open",
        include_body: true,
        compact: true,
        apply: true,
        force: true,
        allow_audit_update: true,
      },
      global,
    );
    expect(result).toMatchObject({ dry_run: false });
    const comments = await runCommentsAuditPackage({ full_history: true }, global);
    expect(comments).toHaveProperty("items");
    await expect(
      runDedupeMergePackage(
        { keep: "pm-missing", close: "pm-other", apply: true, dry_run: true, skip_children: true },
        global,
      ),
    ).rejects.toThrow();
    expect(toErrorMessage("package failure")).toBe("package failure");
    expect(toErrorMessage(new Error("runtime failure"))).toBe("runtime failure");
    expect(toErrorMessage(new Error())).toBe("Error");
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity([], ["audit"])).toBe(0);
    expect(splitCommaList(null)).toEqual([]);
    expect(splitCommaList(" audit, ,governance ")).toEqual(["audit", "governance"]);
    expect(toNonEmptyStringOrUndefined(1)).toBeUndefined();
    expect(toNonEmptyStringOrUndefined("  ")).toBeUndefined();
    expect(toNonEmptyStringOrUndefined(" audit ")).toBe("audit");
    });
  });

  it("dispatches every package-owned command definition", async () => {
    await withTempPmPath(async (sandbox) => {
      const commands: CommandDefinition[] = [];
      let auditService: ServiceOverride | undefined;
      activate({
        registerCommand(definition) {
          commands.push(definition);
        },
        registerFlags() {},
        registerService(_service, override) {
          auditService = override;
        },
        hooks: { onRead() {}, onWrite() {} },
      } as unknown as ExtensionApi);
      const global = { path: sandbox.pmPath, json: true };
      const byName = new Map(commands.map((command) => [command.name, command]));
      expect(auditService?.({ payload: {} } as never)).toEqual([]);
      expect(auditService?.({
        payload: {
          paths: ["docs/a.md"],
          items: [{ id: "pm-one" }, { id: "pm-two", artifacts: [{ path: "docs/a.md" }] }],
        },
      } as never)).toEqual([
        { path: "docs/a.md", linked_by_count: 1, linked_item_ids: ["pm-two"] },
      ]);
      await expect(byName.get("dedupe-audit")?.run?.({ options: {}, global } as never)).resolves.toHaveProperty("clusters");
      await expect(byName.get("comments-audit")?.run?.({ options: {}, global } as never)).resolves.toHaveProperty("items");
      await expect(byName.get("normalize")?.run?.({ options: { dryRun: true }, global } as never)).resolves.toHaveProperty("dry_run");
      await expect(
        byName.get("dedupe-merge")?.run?.({ options: { keep: "pm-missing", close: "pm-other" }, global } as never),
      ).rejects.toThrow();
    });
  });
});
