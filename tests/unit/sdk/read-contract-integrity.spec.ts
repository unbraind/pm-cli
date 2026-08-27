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
  normalizeReadOutputIncludeModeOptions,
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  readOutputIncludeModeOptions,
} from "../../../src/sdk/read-output-contracts.js";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";

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

  it("keeps exact projection replacements separate from execution semantics", () => {
    expect(readOutputIncludeModeOptions("list").get("brief")).toBe("brief");
    expect(readOutputIncludeModeOptions("deps").has("collapse")).toBe(false);
    expect(readOutputIncludeModeOptions("health").has("check_only")).toBe(
      false,
    );
    expect(
      PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
        (contract) => contract.command === "deps",
      )?.dimensions.include.legacy_aliases,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flag: "--collapse",
          semantics: "behavior_preserving",
        }),
      ]),
    );
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

    const projectedCounts = applyReadOutputDimensions(
      "get",
      { outputInclude: "item.title,item.collection_counts" },
      {
        item: {
          id: "pm-1",
          title: "One",
          body: "retained",
          collection_counts: { comments: 2, notes: 3, tests: 1 },
        },
        children: [],
        claim_state: { claimed: false },
      },
    );
    expect(projectedCounts).toMatchObject({
      item: {
        title: "One",
        collection_counts: { comments: 2, notes: 3, tests: 1 },
      },
    });
    expect(projectedCounts).not.toHaveProperty("item.body");
    expect(projectedCounts).not.toHaveProperty("item.id");

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

  it("forwards get collection selectors into the pre-execution field projection", () => {
    const options: Record<string, unknown> = {
      outputInclude: "item,comments",
      fields: "notes",
    };

    normalizeReadOutputIncludeModeOptions("get", options);

    expect(options).toMatchObject({
      outputInclude: "item,comments",
      fields: "notes,comments",
    });
    expect(
      attachReadOutputContracts("get", options, {
        item: { id: "pm-1", title: "One" },
        comments: [],
      }),
    ).toMatchObject({
      read_output: { legacy_aliases_used: [], migration_hints: [] },
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

  it("enforces the shared default cost contract without taxing ordinary get reads", () => {
    const small = {
      item: { id: "pm-1", title: "One" },
      children: [],
    };
    expect(applyReadOutputDimensions("get", {}, small)).toBe(small);

    const oversized = {
      item: { id: "pm-1", body: "context ".repeat(10_000) },
      children: [],
    };
    expect(applyReadOutputDimensions("get", {}, oversized)).toMatchObject({
      read_output: {
        budget_source: "default",
        budget_tokens: 4_000,
        within_budget: true,
        strings_compacted: true,
      },
    });
    expect(
      applyReadOutputDimensions(
        "get",
        { outputBudget: "unbounded" },
        oversized,
      ),
    ).toBe(oversized);
  });

  it("keeps row discovery opt-in and measures the final read envelope exactly", () => {
    const session = {
      version: 1 as const,
      id: "read-contract-integrity",
      token_budget: 2_000,
      spent_tokens: 0,
      seen_item_ids: [],
    };
    const hidden = attachReadOutputContracts(
      "list",
      { outputSession: session },
      { items: [{ id: "pm-1", title: "One" }], count: 1 },
    ) as Record<string, unknown> & {
      read_output: { estimated_tokens: number };
      read_session: { spent_this_call_tokens: number };
    };
    const hiddenEstimate = Math.ceil(
      Buffer.byteLength(JSON.stringify(hidden), "utf8") / 4,
    );
    expect(hidden).not.toHaveProperty("row_contract");
    expect(hidden.read_output.estimated_tokens).toBe(hiddenEstimate);
    expect(hidden.read_session.spent_this_call_tokens).toBe(hiddenEstimate);

    const disclosed = attachReadOutputContracts(
      "list",
      { outputRowContract: true, outputSession: session },
      { items: [{ id: "pm-1", title: "One" }], count: 1 },
    ) as Record<string, unknown> & {
      read_output: { estimated_tokens: number };
      read_session: { spent_this_call_tokens: number };
    };
    const disclosedEstimate = Math.ceil(
      Buffer.byteLength(JSON.stringify(disclosed), "utf8") / 4,
    );
    expect(disclosed).toHaveProperty("row_contract");
    expect(disclosed.read_output.estimated_tokens).toBe(disclosedEstimate);
    expect(disclosed.read_session.spent_this_call_tokens).toBe(
      disclosedEstimate,
    );
    const staleMetadata = attachReadOutputContracts(
      "list",
      {},
      {
        items: [],
        row_contract: {},
        context_intent: [],
        read_output: { estimated_tokens: "stale" },
      },
    ) as Record<string, unknown>;
    expect(staleMetadata).not.toHaveProperty("row_contract");
    expect(staleMetadata).toMatchObject({
      context_intent: [],
      read_output: { estimated_tokens: expect.any(Number) },
    });
    expect(
      attachReadOutputContracts(
        "list",
        { output_row_contract: true },
        { items: [{ id: "pm-1" }] },
      ),
    ).toHaveProperty("row_contract");
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
