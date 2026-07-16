import { describe, expect, it, vi } from "vitest";
import type {
  CommandDefinition,
  ExtensionApi,
  ServiceOverride,
} from "@unbrained/pm-cli/sdk";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import {
  runCommentsAuditPackage,
  runDedupeAuditPackage,
  runDedupeMergePackage,
  runNormalizePackage,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/runtime.ts";
import {
  activate,
  withOwnershipBypassOptions,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/index.ts";
import {
  buildLinkedArtifactAudit,
  decorateGovernanceCommandResult,
  jaccardSimilarity,
  normalizeLowercaseWhitespace,
  parseIntegerLimit,
  splitCommaList,
  tokenizeAlphaNumeric,
  toErrorMessage,
  toNonEmptyStringOrUndefined,
} from "../../../packages/pm-governance-audit/extensions/governance-audit/runtime-utils.ts";
import { PmClient } from "../../../packages/pm-governance-audit/extensions/governance-audit/sdk.ts";

describe("packages/pm-governance-audit runtime", () => {
  it("owns and executes all four audit workflows without core audit runners", async () => {
    await withTempPmPath(async (sandbox) => {
      const global = { path: sandbox.pmPath, json: true };

      const dedupe = await runDedupeAuditPackage(
        { mode: "title_exact" },
        global,
      );
      expect(dedupe).toMatchObject({ mode: "title_exact" });

      const comments = await runCommentsAuditPackage({ latest: "0" }, global);
      expect(comments).toHaveProperty("items");

      const normalize = await runNormalizePackage({ dry_run: true }, global);
      expect(normalize).toHaveProperty("dry_run", true);

      await expect(
        runDedupeMergePackage(
          { keep: "pm-missing", close: "pm-other" },
          global,
        ),
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
      const comments = await runCommentsAuditPackage(
        { full_history: true },
        global,
      );
      expect(comments).toHaveProperty("items");
      await expect(
        runDedupeMergePackage(
          {
            keep: "pm-missing",
            close: "pm-other",
            apply: true,
            dry_run: true,
            skip_children: true,
          },
          global,
        ),
      ).rejects.toThrow();
      expect(toErrorMessage("package failure")).toBe("package failure");
      expect(toErrorMessage(new Error("runtime failure"))).toBe(
        "runtime failure",
      );
      expect(toErrorMessage(new Error())).toBe("Error");
      expect(jaccardSimilarity([], [])).toBe(1);
      expect(jaccardSimilarity([], ["audit"])).toBe(0);
      expect(splitCommaList(null)).toEqual([]);
      expect(splitCommaList(" audit, ,governance ")).toEqual([
        "audit",
        "governance",
      ]);
      expect(toNonEmptyStringOrUndefined(1)).toBeUndefined();
      expect(toNonEmptyStringOrUndefined("  ")).toBeUndefined();
      expect(toNonEmptyStringOrUndefined(" audit ")).toBe("audit");
      expect(normalizeLowercaseWhitespace("  Mixed   CASE ")).toBe(
        "mixed case",
      );
      expect(tokenizeAlphaNumeric("Audit-ready: Item 42")).toEqual([
        "audit",
        "ready",
        "item",
        "42",
      ]);
      expect(parseIntegerLimit(undefined)).toBeUndefined();
      expect(parseIntegerLimit("2")).toBe(2);
      expect(() => parseIntegerLimit("-1", "--latest")).toThrow(
        "--latest must be a non-negative integer",
      );
      expect(buildLinkedArtifactAudit({})).toEqual([]);
    });
  });

  it("maps every package bypass flag without exposing it in core contracts", () => {
    expect(
      withOwnershipBypassOptions("update", {
        allowAuditUpdate: true,
        allowAuditDepUpdate: false,
      }),
    ).toMatchObject({
      ownershipMetadataBypass: true,
      ownershipDependencyBypass: false,
    });
    expect(
      withOwnershipBypassOptions("update-many", {
        allow_audit_update: true,
        allow_audit_dep_update: true,
      }),
    ).toMatchObject({
      ownershipMetadataBypass: true,
      ownershipDependencyBypass: true,
    });
    expect(
      withOwnershipBypassOptions("comments", { allowAuditComment: true }),
    ).toMatchObject({ ownershipAppendBypass: true });
    expect(
      withOwnershipBypassOptions("notes", { allowAuditNote: true }),
    ).toMatchObject({ ownershipAppendBypass: true });
    expect(
      withOwnershipBypassOptions("notes", { allowAuditComment: true }),
    ).toMatchObject({ ownershipAppendBypass: true });
    expect(
      withOwnershipBypassOptions("learnings", { allowAuditLearning: true }),
    ).toMatchObject({ ownershipAppendBypass: true });
    expect(
      withOwnershipBypassOptions("learnings", { allowAuditComment: true }),
    ).toMatchObject({ ownershipAppendBypass: true });
    expect(
      withOwnershipBypassOptions("release", { allowAuditRelease: true }),
    ).toMatchObject({ ownershipReleaseBypass: true });
    expect(withOwnershipBypassOptions("files", { audit: true })).toEqual({
      audit: true,
    });
  });

  it("decorates package results across aliases and fallback branches", async () => {
    expect(await decorateGovernanceCommandResult(null)).toBeUndefined();
    expect(
      await decorateGovernanceCommandResult({ result: "not-an-object" }),
    ).toBe("not-an-object");
    for (const options of [
      { allowAuditUpdate: true },
      { allow_audit_update: true },
      { allowAuditDepUpdate: true },
      { allow_audit_dep_update: true },
    ]) {
      await expect(
        decorateGovernanceCommandResult({
          command: "update",
          options,
          result: { ok: true },
        }),
      ).resolves.toEqual({ ok: true, audit_update: true });
    }
    await expect(
      decorateGovernanceCommandResult({
        command: "update-many",
        options: { allowAuditUpdate: true },
        result: { ok: true },
      }),
    ).resolves.toEqual({ ok: true, audit_update: true });
    await expect(
      decorateGovernanceCommandResult({
        command: "update",
        result: { ok: true },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      decorateGovernanceCommandResult({
        command: "release",
        options: { allowAuditRelease: true },
        result: { ok: true },
      }),
    ).resolves.toEqual({ ok: true, audit_release: true });
    await expect(
      decorateGovernanceCommandResult({
        command: "files",
        options: {},
        result: { files: [] },
      }),
    ).resolves.toEqual({ files: [] });
  });

  it("decorates linked artifacts through the package SDK reader", async () => {
    await withTempPmPath(async (sandbox) => {
      const created = sandbox.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Linked audit fixture",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      expect(
        sandbox.runCli([
          "files",
          id,
          "--add",
          "path=shared.ts,scope=project",
          "--json",
        ]).code,
      ).toBe(0);
      await expect(
        decorateGovernanceCommandResult({
          command: "files",
          options: { audit: true },
          pm_root: sandbox.pmPath,
          result: { files: [{ path: "shared.ts" }, { path: 1 }] },
        }),
      ).resolves.toEqual({
        files: [{ path: "shared.ts" }, { path: 1 }],
        audit: [
          { path: "shared.ts", linked_by_count: 1, linked_item_ids: [id] },
        ],
      });
      await expect(
        decorateGovernanceCommandResult({
          command: "files",
          options: { audit: true },
          result: { files: [] },
        }),
      ).resolves.toEqual({ files: [] });
      await expect(
        decorateGovernanceCommandResult({
          command: "docs",
          options: { audit: true },
          pm_root: sandbox.pmPath,
          result: { docs: "not-an-array" },
        }),
      ).resolves.toEqual({ docs: "not-an-array", audit: [] });

      const projectedWithoutId = vi
        .spyOn(PmClient.prototype, "list")
        .mockResolvedValueOnce({
          items: [
            { files: [{ path: "shared.ts" }] },
            {
              id: "pm-malformed-artifacts",
              files: [null, "invalid", { path: 1 }, { path: "shared.ts" }],
            },
          ],
        } as never);
      await expect(
        decorateGovernanceCommandResult({
          command: "files",
          options: { audit: true },
          pm_root: sandbox.pmPath,
          result: { files: [{ path: "shared.ts" }] },
        }),
      ).resolves.toEqual({
        files: [{ path: "shared.ts" }],
        audit: [
          {
            path: "shared.ts",
            linked_by_count: 1,
            linked_item_ids: ["pm-malformed-artifacts"],
          },
        ],
      });
      projectedWithoutId.mockRestore();
    });
  });

  it("dispatches every package-owned command definition", async () => {
    await withTempPmPath(async (sandbox) => {
      const commands: CommandDefinition[] = [];
      const parsers: Array<
        (context: { options: Record<string, unknown> }) => unknown
      > = [];
      let auditService: ServiceOverride | undefined;
      activate({
        registerCommand(definition) {
          commands.push(definition);
        },
        registerFlags() {},
        registerParser(_command, parser) {
          parsers.push(
            parser as (context: {
              options: Record<string, unknown>;
            }) => unknown,
          );
        },
        registerService(_service, override) {
          auditService = override;
        },
        hooks: { onRead() {}, onWrite() {} },
      } as unknown as ExtensionApi);
      const global = { path: sandbox.pmPath, json: true };
      const byName = new Map(
        commands.map((command) => [command.name, command]),
      );
      await expect(
        auditService?.({
          payload: {
            command: "update",
            options: { allowAuditUpdate: true },
            result: { ok: true },
          },
        } as never),
      ).resolves.toEqual({ ok: true, audit_update: true });
      expect(parsers[0]?.({ options: { allowAuditUpdate: true } })).toEqual({
        options: {
          allowAuditUpdate: true,
          ownershipMetadataBypass: true,
          ownershipDependencyBypass: false,
        },
      });
      expect(
        buildLinkedArtifactAudit({
          paths: ["docs/z.md", "docs/a.md"],
          items: [
            { id: "pm-one", artifacts: [{ path: "docs/a.md" }] },
            { id: "pm-two", artifacts: [{ path: "docs/a.md" }] },
          ],
        }),
      ).toEqual([
        {
          path: "docs/a.md",
          linked_by_count: 2,
          linked_item_ids: ["pm-one", "pm-two"],
        },
        { path: "docs/z.md", linked_by_count: 0, linked_item_ids: [] },
      ]);
      await expect(
        byName.get("dedupe-audit")?.run?.({ options: {}, global } as never),
      ).resolves.toHaveProperty("clusters");
      await expect(
        byName.get("comments-audit")?.run?.({ options: {}, global } as never),
      ).resolves.toHaveProperty("items");
      await expect(
        byName
          .get("normalize")
          ?.run?.({ options: { dryRun: true }, global } as never),
      ).resolves.toHaveProperty("dry_run");
      await expect(
        byName
          .get("dedupe-merge")
          ?.run?.({
            options: { keep: "pm-missing", close: "pm-other" },
            global,
          } as never),
      ).rejects.toThrow();
    });
  });
});
