import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { projectMutationResult } from "../../../../src/core/output/mutation-projection.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { runClose } from "../../../../src/sdk/lifecycle/close.js";
import { runCreate } from "../../../../src/sdk/lifecycle/create.js";
import { runReopen } from "../../../../src/sdk/lifecycle/reopen.js";
import {
  runMcpCloseAction,
  runMcpReopenAction,
} from "../../../../src/sdk/lifecycle/mcp-actions.js";
import { reopen as reopenItem } from "../../../../src/sdk/runtime.js";
import { evaluateSimilarityGovernance } from "../../../../src/sdk/similarity.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { describe, expect, it } from "vitest";

describe("runReopen", () => {
  it("preserves recurrence receipts in compact mutation envelopes", () => {
    expect(
      projectMutationResult(
        {
          item: { id: "pm-a", status: "open" },
          changed_fields: ["status"],
          recurrence: { reason: "Again" },
        },
        { changedFields: "compact", compactEnvelope: true },
      ),
    ).toEqual({
      id: "pm-a",
      status: "open",
      changed_field_count: 1,
      recurrence: { reason: "Again" },
    });
  });

  it("reopens a terminal item through update while preserving structured recurrence history", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        {
          title: "Recurring production regression",
          type: "Issue",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      await runClose(
        created.item.id,
        "Original incident was mitigated",
        {
          resolution: "Deployed the first mitigation",
          expectedResult: "The incident remains resolved",
          actualResult: "The incident initially remained resolved",
        },
        { path: context.pmPath },
      );

      const result = await runReopen(
        created.item.id,
        "The same failure recurred after the next deployment",
        { status: "in_progress", message: "Resume incident response" },
        { path: context.pmPath },
      );

      expect(result.item).toMatchObject({
        id: created.item.id,
        status: "in_progress",
      });
      expect(result.item).not.toHaveProperty("closed_at");
      expect(result.item).not.toHaveProperty("completed_at");
      expect(result.item).not.toHaveProperty("close_reason");
      expect(result.item).not.toHaveProperty("resolution");
      expect(result.item).not.toHaveProperty("expected_result");
      expect(result.item).not.toHaveProperty("actual_result");
      expect(result.item).not.toHaveProperty("fixed_version");
      expect(result.recurrence).toEqual({
        reason: "The same failure recurred after the next deployment",
        from_status: "closed",
        to_status: "in_progress",
        previous_terminal: {
          close_reason: "Original incident was mitigated",
          resolution: "Deployed the first mitigation",
          expected_result: "The incident remains resolved",
          actual_result: "The incident initially remained resolved",
        },
      });

      const history = await readHistoryEntries(
        getHistoryPath(context.pmPath, created.item.id),
        created.item.id,
      );
      expect(history.map((entry) => entry.op)).toEqual([
        "create",
        "close",
        "reopen",
      ]);
      expect(history.at(-1)).toMatchObject({
        message: "Resume incident response",
        context: {
          recurrence: {
            reason: "The same failure recurred after the next deployment",
            from_status: "closed",
            to_status: "in_progress",
          },
        },
      });
      expect(history[1].message).toBeUndefined();
    });
  });

  it("refuses an already-active item with an executable recovery envelope", async () => {
    await withTempPmPath(async (context) => {
      const created = await runCreate(
        { title: "Active work", type: "Task", createMode: "progressive" },
        { path: context.pmPath },
      );

      await expect(
        runReopen(
          created.item.id,
          "This must not append a recurrence",
          {},
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
        code: "item_already_active",
        context: {
          recovery: {
            suggested_retry: `pm get ${created.item.id} --full`,
            suggested_retry_args: ["get", created.item.id, "--full"],
          },
        },
      });
    });
  });

  it("points duplicate intake at reopening the strongest terminal match", async () => {
    await withTempPmPath(async (context) => {
      const canonical = await runCreate(
        {
          title: "Recurring duplicate intake",
          type: "Issue",
          createMode: "progressive",
        },
        { path: context.pmPath },
      );
      await runClose(
        canonical.item.id,
        "Closed before recurrence",
        {},
        { path: context.pmPath },
      );

      await expect(
        evaluateSimilarityGovernance(
          { title: "Recurring duplicate intake" },
          { mode: "strict", pmRoot: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "likely_duplicate",
        context: {
          recovery: {
            suggested_retry: `pm item reopen ${canonical.item.id} "<recurrence reason>"`,
            suggested_retry_args: [
              "item",
              "reopen",
              canonical.item.id,
              "<recurrence reason>",
            ],
          },
        },
      });
    });
  });

  it("validates recurrence inputs and missing generic-dispatch ids", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        runReopen("pm-missing", " ", {}, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        code: "reopen_reason_required",
        exitCode: EXIT_CODE.USAGE,
      });

      const created = await runCreate(
        { title: "Status validation", type: "Task", createMode: "progressive" },
        { path: context.pmPath },
      );
      await runClose(created.item.id, "Done", {}, { path: context.pmPath });
      await expect(
        runReopen(
          created.item.id,
          "Recurrence",
          { status: "archived" },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        code: "reopen_target_status_invalid",
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runMcpReopenAction({
          args: {},
          options: {},
          id: created.item.id,
          global: { path: context.pmPath },
        }),
      ).rejects.toMatchObject<PmCliError>({
        code: "reopen_reason_required",
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runMcpReopenAction({
          args: {},
          options: {},
          id: undefined,
          global: { path: context.pmPath },
        }),
      ).rejects.toThrow("Missing required argument: id");
    });
  });

  it("supports the top-level SDK helper and option-carried MCP aliases", async () => {
    await withTempPmPath(async (context) => {
      const first = await runCreate(
        { title: "SDK recurrence", type: "Issue", createMode: "progressive" },
        { path: context.pmPath },
      );
      await runClose(first.item.id, "Done", {}, { path: context.pmPath });
      await expect(
        reopenItem(first.item.id, "Recurred", {}, { pmRoot: context.pmPath }),
      ).resolves.toMatchObject({ item: { id: first.item.id, status: "open" } });

      const second = await runCreate(
        { title: "MCP recurrence", type: "Issue", createMode: "progressive" },
        { path: context.pmPath },
      );
      await runClose(second.item.id, "Done", {}, { path: context.pmPath });
      await expect(
        runMcpReopenAction({
          args: { fullChangedFields: true, idOnly: true },
          options: { id: second.item.id, text: "Recurred through options" },
          id: undefined,
          global: { path: context.pmPath },
        }),
      ).resolves.toEqual({ id: second.item.id, status: "open" });

      const third = await runCreate(
        { title: "MCP text alias", type: "Issue", createMode: "progressive" },
        { path: context.pmPath },
      );
      await runClose(third.item.id, "Done", {}, { path: context.pmPath });
      await expect(
        runMcpReopenAction({
          args: { text: "Recurred through flat text" },
          options: {},
          id: third.item.id,
          global: { path: context.pmPath },
        }),
      ).resolves.toMatchObject({ id: third.item.id, status: "open" });

      const fourth = await runCreate(
        { title: "MCP reason option", type: "Issue", createMode: "progressive" },
        { path: context.pmPath },
      );
      await runClose(fourth.item.id, "Done", {}, { path: context.pmPath });
      await expect(
        runMcpReopenAction({
          args: {},
          options: { reason: "Recurred through options" },
          id: fourth.item.id,
          global: { path: context.pmPath },
        }),
      ).resolves.toMatchObject({ id: fourth.item.id, status: "open" });

      const closeTarget = await runCreate(
        { title: "MCP close adapter", type: "Issue", createMode: "progressive" },
        { path: context.pmPath },
      );
      await expect(
        runMcpCloseAction({
          args: { text: "Closed through flat text" },
          options: {},
          id: closeTarget.item.id,
          global: { path: context.pmPath },
        }),
      ).resolves.toMatchObject({ id: closeTarget.item.id, status: "closed" });
    });
  });
});
