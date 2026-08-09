import { describe, expect, it } from "vitest";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { runComments } from "../../../src/sdk/comments.js";
import { runLearnings } from "../../../src/sdk/learnings.js";
import { runNotes } from "../../../src/sdk/notes.js";
import {
  parseUnknownAuthorHistoryEventCoordinates,
  resolveUnknownAuthorAcknowledgmentSelector,
} from "../../../src/sdk/author-attribution.js";
import { _testOnlyHealthCommand } from "../../../src/sdk/governance/health.js";
import {
  applyReadOutputDimensions,
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
} from "../../../src/sdk/read-output-contracts.js";

describe("SDK read contract integrity", () => {
  it("declares package manage through the shared read-output registry", () => {
    expect(
      PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
        (contract) => contract.command === "package-manage",
      ),
    ).toMatchObject({
      command: "package-manage",
      dimensions: {
        include: { canonical_option: "--output-include", applicable: true },
        encoding: { canonical_option: "--output-format", applicable: true },
      },
    });
  });

  it("projects the primary get entity with the same bare-field grammar as collections", () => {
    const projected = applyReadOutputDimensions(
      "get",
      { outputInclude: "id,title" },
      {
        item: { id: "pm-1", title: "One", body: "withheld" },
        children: [{ id: "pm-child", title: "Child", body: "retained" }],
        claim_state: { claimed: false },
      },
    );

    expect(projected).toMatchObject({
      item: { id: "pm-1", title: "One" },
      omission_receipt: {
        has_omissions: true,
        omitted_field_groups: expect.arrayContaining([
          {
            name: "item.body",
            restore_with: "--output-include item.body",
          },
          { name: "children", restore_with: "--output-include children" },
        ]),
      },
    });
    expect(projected).not.toHaveProperty("children");
    expect(projected).not.toHaveProperty("claim_state");

    const fullItem = applyReadOutputDimensions(
      "get",
      { outputInclude: "item,claim_state" },
      {
        item: { id: "pm-1", title: "One", body: "retained" },
        children: [],
        claim_state: { claimed: false },
      },
    );
    expect(fullItem).toMatchObject({
      item: { id: "pm-1", title: "One", body: "retained" },
      claim_state: { claimed: false },
    });
    expect(fullItem).not.toHaveProperty(
      "omission_receipt.omitted_field_groups",
      expect.arrayContaining([{ name: "item" }]),
    );

    expect(
      applyReadOutputDimensions(
        "get",
        { outputInclude: "item.title,item.collection_counts" },
        {
          item: {
            id: "pm-1",
            title: "One",
            body: "retained",
            collection_counts: { comments: 0, notes: 0, tests: 0 },
          },
          children: [],
          claim_state: { claimed: false },
        },
      ),
    ).toMatchObject({
      item: {
        title: "One",
        collection_counts: { comments: 0, notes: 0, tests: 0 },
      },
    });

    expect(
      applyReadOutputDimensions(
        "get",
        { outputInclude: "children" },
        { item: null, children: [] },
      ),
    ).toMatchObject({
      children: [],
      omission_receipt: {
        omitted_field_groups: [
          { name: "item", restore_with: "--output-include item" },
        ],
      },
    });

    expect(
      applyReadOutputDimensions(
        "get",
        { outputInclude: "id" },
        {
          item: { id: "pm-1", title: "One", body: "withheld" },
          children: [],
          omission_receipt: {
            has_omissions: true,
            omitted_field_group_count: 1,
            omitted_field_groups: [
              {
                name: "upstream_context",
                restore_with: "--depth full",
              },
            ],
          },
        },
      ),
    ).toMatchObject({
      item: { id: "pm-1" },
      omission_receipt: {
        has_omissions: true,
        omitted_field_group_count: 4,
        omitted_field_groups: [
          { name: "upstream_context", restore_with: "--depth full" },
          { name: "item.body", restore_with: "--output-include item.body" },
          {
            name: "item.title",
            restore_with: "--output-include item.title",
          },
          { name: "children", restore_with: "--output-include children" },
        ],
      },
    });
  });

  it("refuses unknown and ambiguous get selectors with the valid vocabulary", () => {
    const result = {
      item: { id: "pm-1", title: "One" },
      children: [],
      claim_state: { claimed: false },
    };
    expect(() =>
      applyReadOutputDimensions("get", { outputInclude: "missing" }, result),
    ).toThrow(/Valid selectors:.*id.*title.*item/u);
    expect(() =>
      applyReadOutputDimensions("get", { outputInclude: "item,id" }, result),
    ).toThrow(/cannot mix a full item with projected item fields/u);
  });

  it("returns bounded mutation receipts independently of annotation history size", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "bounded annotation receipts",
        tags: "sdk,receipts",
        estimate: "10",
      });
      const runners = [
        ["comments", runComments],
        ["notes", runNotes],
        ["learnings", runLearnings],
      ] as const;

      for (const [collection, run] of runners) {
        for (let index = 0; index < 20; index += 1) {
          await run(
            id,
            { add: `${collection}-${String(index)}` },
            { path: context.pmPath },
          );
        }
        const receipt = await run(
          id,
          { add: `${collection}-latest` },
          { path: context.pmPath },
        );
        expect(receipt).toMatchObject({
          id,
          count: 1,
          total_count: 21,
          mutation_receipt: {
            action: "add",
            entry_index: 21,
            changed_count: 1,
            full_history_included: false,
          },
          omission_receipt: {
            has_omissions: true,
            omitted_field_groups: [
              {
                name: `${collection}_history`,
                restore_with: {
                  selector: "full_history",
                  cli_flag: "--full-history",
                  sdk_option: "fullHistory",
                  mcp_option: "full",
                },
              },
            ],
          },
        });
        expect(
          (receipt as unknown as Record<string, unknown[]>)[collection],
        ).toHaveLength(1);
        expect(JSON.stringify(receipt).length).toBeLessThan(1_000);

        const full = await run(
          id,
          { add: `${collection}-full`, fullHistory: true },
          { path: context.pmPath },
        );
        expect(
          (full as unknown as Record<string, unknown[]>)[collection],
        ).toHaveLength(22);
        expect(full).toMatchObject({
          total_count: 22,
          omission_receipt: { has_omissions: false },
        });
      }
    });
  });

  it("marks mutation receipts complete when no annotation history is withheld", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, {
        title: "complete annotation receipts",
        tags: "sdk,receipts",
        estimate: "10",
      });
      const runners = [
        ["comments", runComments],
        ["notes", runNotes],
        ["learnings", runLearnings],
      ] as const;

      for (const [collection, run] of runners) {
        const added = await run(
          id,
          { add: `${collection}-only` },
          { path: context.pmPath },
        );
        expect(added).toMatchObject({
          count: 1,
          total_count: 1,
          has_more: false,
          mutation_receipt: { full_history_included: true },
          omission_receipt: {
            has_omissions: false,
            omitted_field_group_count: 0,
            omitted_field_groups: [],
          },
        });

        const deleted = await run(id, { delete: 1 }, { path: context.pmPath });
        expect(deleted).toMatchObject({
          count: 0,
          total_count: 0,
          has_more: false,
          mutation_receipt: { full_history_included: true },
          omission_receipt: { has_omissions: false },
        });
      }
    });
  });

  it("keeps health read-only unless vector refresh is explicitly requested", () => {
    expect(_testOnlyHealthCommand.resolveVectorRefreshPolicy({})).toEqual({
      enabled: false,
      checkOnly: false,
      noRefresh: true,
      refreshVectors: false,
    });
    expect(
      _testOnlyHealthCommand.resolveVectorRefreshPolicy({
        refreshVectors: true,
      }),
    ).toEqual({
      enabled: true,
      checkOnly: false,
      noRefresh: false,
      refreshVectors: true,
    });
  });

  it("uses one SDK-owned selector and coordinate grammar for CLI and SDK callers", () => {
    expect(parseUnknownAuthorHistoryEventCoordinates(["_workspace:4"])).toEqual(
      [{ item_id: "_workspace", line: 4 }],
    );
    expect(
      resolveUnknownAuthorAcknowledgmentSelector(["_workspace:4"], false),
    ).toEqual({
      events: [{ item_id: "_workspace", line: 4 }],
      all_actionable: false,
    });
    expect(() =>
      resolveUnknownAuthorAcknowledgmentSelector([], false),
    ).toThrowError(
      expect.objectContaining({
        code: "history_author_acknowledge_selector_required",
      }),
    );
    expect(() =>
      resolveUnknownAuthorAcknowledgmentSelector(["pm-one:1"], true),
    ).toThrowError(
      expect.objectContaining({
        code: "history_author_acknowledge_selector_conflict",
      }),
    );
  });
});
