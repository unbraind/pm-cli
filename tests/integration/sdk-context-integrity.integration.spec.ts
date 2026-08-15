/**
 * @module SDK context integrity integration tests
 *
 * Proves projected `get` and workspace-history author acknowledgments through
 * installed CLI and SDK action transports against real temporary trackers.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendWorkspaceAuditEvent } from "../../src/core/history/workspace-history.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import {
  resolveUnknownAuthorAcknowledgmentSelector,
  scanHistoryAuthorAttribution,
} from "../../src/sdk/author-attribution.js";
import { runHealth } from "../../src/sdk/governance/health.js";
import { runValidate } from "../../src/sdk/governance/validate.js";
import { runAction } from "../../src/sdk/runtime.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("SDK context integrity transports", () => {
  it("keeps CLI and SDK get output selectors and omission receipts equivalent", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "projection parity",
        description: "withheld description",
      });
      const cli = context.runCli(
        ["get", id, "--output-include", "id,title", "--json"],
        { expectJson: true },
      );
      expect(cli.code).toBe(0);
      const sdk = await runAction({
        action: "get",
        id,
        path: context.pmPath,
        outputInclude: "id,title",
      });

      expect(cli.json).toMatchObject({
        item: { id, title: "projection parity" },
        omission_receipt: {
          has_omissions: true,
          omitted_field_groups: expect.arrayContaining([
            {
              name: "item.description",
              restore_with: "--output-include item.description",
            },
          ]),
        },
      });
      expect(sdk).toEqual(cli.json);

      const invalidCli = context.runCli([
        "get",
        id,
        "--output-include",
        "item,id",
        "--json",
      ]);
      expect(invalidCli.code).toBe(2);
      const invalidSdk = await runAction({
        action: "get",
        id,
        path: context.pmPath,
        outputInclude: "item,id",
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(invalidSdk).toBeInstanceOf(PmCliError);
      expect((invalidSdk as PmCliError).exitCode).toBe(invalidCli.code);
    });
  });

  it("round-trips an actionable _workspace coordinate through CLI health and validation", async () => {
    await withTempPmPath(async (context) => {
      const missingSelectorCli = context.runCli([
        "history-author-acknowledge",
        "--attributed-author",
        "fixture-agent",
        "--reviewer",
        "fixture-maintainer",
        "--reason",
        "Missing selector parity.",
        "--json",
      ]);
      const missingSelectorSdk = (() => {
        try {
          resolveUnknownAuthorAcknowledgmentSelector([], false);
          return null;
        } catch (error) {
          return error;
        }
      })();
      const missingSelectorEnvelope = JSON.parse(missingSelectorCli.stderr) as {
        code: string;
        exit_code: number;
        required: string;
        examples: string[];
      };
      expect(missingSelectorSdk).toBeInstanceOf(PmCliError);
      expect(missingSelectorEnvelope).toMatchObject({
        code: (missingSelectorSdk as PmCliError).code,
        exit_code: (missingSelectorSdk as PmCliError).exitCode,
        required: (missingSelectorSdk as PmCliError).context.required,
        examples: (missingSelectorSdk as PmCliError).context.examples,
      });

      await appendWorkspaceAuditEvent({
        pmRoot: context.pmPath,
        op: "fixture:unknown-workspace-author",
        author: "unknown",
        message: "Fixture requiring explicit provenance review.",
        lockTtlSeconds: 30,
        lockWaitMs: 1_000,
      });
      const workspaceHistoryPath = path.join(
        context.pmPath,
        "history",
        "_workspace.jsonl",
      );
      const events = (await readFile(workspaceHistoryPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { author?: string });
      const unknownLine =
        events.findIndex((event) => event.author === "unknown") + 1;
      expect(unknownLine).toBeGreaterThan(0);
      await expect(
        scanHistoryAuthorAttribution(context.pmPath, 20, true),
      ).resolves.toMatchObject({
        actionable_events: expect.arrayContaining([
          { item_id: "_workspace", line: unknownLine },
        ]),
      });

      const preview = context.runCli(
        [
          "history-author-acknowledge",
          "--event",
          `_workspace:${String(unknownLine)}`,
          "--dry-run",
          "--limit",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      expect(preview.code).toBe(0);
      const planFingerprint = (
        preview.json as { plan: { plan_fingerprint: string } }
      ).plan.plan_fingerprint;
      const unboundedPreview = context.runCli(
        [
          "history-author-acknowledge",
          "--event",
          `_workspace:${String(unknownLine)}`,
          "--dry-run",
          "--json",
        ],
        { expectJson: true },
      );
      expect(unboundedPreview).toMatchObject({ code: 0 });
      expect(unboundedPreview.json).toMatchObject({
        plan: { plan_fingerprint: planFingerprint, omitted_count: 0 },
      });
      const acknowledged = context.runCli(
        [
          "history-author-acknowledge",
          "--event",
          `_workspace:${String(unknownLine)}`,
          "--plan-fingerprint",
          planFingerprint,
          "--attributed-author",
          "fixture-agent",
          "--reviewer",
          "fixture-maintainer",
          "--reason",
          "Reviewed workspace provenance in an acceptance test.",
          "--json",
        ],
        { expectJson: true },
      );
      expect(acknowledged.code).toBe(0);
      expect(acknowledged.json).toMatchObject({ acknowledged: 1 });
      await expect(
        scanHistoryAuthorAttribution(context.pmPath),
      ).resolves.toMatchObject({
        actionable_unknown_event_count: 0,
        acknowledged_actionable_event_count: 1,
      });

      const health = await runHealth(
        { path: context.pmPath },
        { skipIntegrity: true, skipDrift: true, skipVectors: true },
      );
      const validation = await runValidate({}, { path: context.pmPath });
      expect(health.warnings).not.toContain("history_unknown_author_events:1");
      expect(validation.warnings).not.toContain(
        "validate_history_unknown_author_events:1",
      );

      const invalid = context.runCli([
        "history-author-acknowledge",
        "--event",
        "_other:1",
        "--attributed-author",
        "fixture-agent",
        "--reviewer",
        "fixture-maintainer",
        "--reason",
        "Invalid workspace coordinate.",
        "--json",
      ]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("expects <item-id>:<one-based-line>");
    });
  });
});
