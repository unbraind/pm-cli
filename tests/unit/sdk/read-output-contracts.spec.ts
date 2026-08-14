import { describe, expect, it } from "vitest";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";
import { updateReadOutputReceiptEstimate } from "../../../src/sdk/read-output-budget.js";
import { prioritizeAssuranceAssertions } from "../../../src/sdk/read-output/continuation.js";
import {
  PM_READ_OUTPUT_DIMENSIONS,
  PM_READ_OUTPUT_COMPOSITION_OPTION_FLAGS,
  PM_READ_OUTPUT_OPTION_FLAGS,
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  applyReadOutputDimensions,
  decodeReadOutputContinuationCursor,
  encodeReadOutputContinuationCursor,
  isReadOutputBudgetExceeded,
  resolveReadOutputDimensions,
  resolveReadOutputEncoding,
  resolveReadOutputSurface,
  validateReadOutputOptions,
} from "../../../src/sdk/read-output-contracts.js";
import {
  boundReadOutputRows,
  countReadOutputRows,
  mapReadOutputRows,
  readOutputBudgetCollections,
  readOutputRowCollections,
  sliceReadOutputRowCollection,
} from "../../../src/sdk/read-output-rows.js";
import {
  PM_READ_OUTPUT_SESSION_MAX_SEEN_ITEM_IDS,
  attachReadOutputSessionReceipt,
  parseReadOutputSession,
} from "../../../src/sdk/read-output-session.js";
import {
  decodeQueryCursorState,
  encodeQueryCursor,
} from "../../../src/sdk/pagination.js";

describe("read output contracts", () => {
  it("declares the same four dimensions on every read surface", () => {
    expect(PM_READ_OUTPUT_DIMENSIONS).toEqual([
      "include",
      "amount",
      "cost",
      "encoding",
    ]);
    expect(PM_READ_OUTPUT_SURFACE_CONTRACTS).toHaveLength(22);
    expect(PM_READ_OUTPUT_OPTION_FLAGS).toEqual([
      "--output-include",
      "--output-limit",
      "--output-budget",
      "--output-format",
    ]);
    expect(PM_READ_OUTPUT_COMPOSITION_OPTION_FLAGS).toEqual([
      "--output-session",
      "--output-cursor",
      "--output-row-contract",
    ]);
    for (const contract of PM_READ_OUTPUT_SURFACE_CONTRACTS) {
      expect(Object.keys(contract.dimensions).sort()).toEqual(
        [...PM_READ_OUTPUT_DIMENSIONS].sort(),
      );
      for (const dimension of Object.values(contract.dimensions)) {
        expect(dimension.applicable).toBe(true);
        expect(dimension.inapplicable_reason).toBeNull();
        expect(Object.isFrozen(dimension)).toBe(true);
        expect(Object.isFrozen(dimension.legacy_aliases)).toBe(true);
        expect(dimension.legacy_aliases.every(Object.isFrozen)).toBe(true);
      }
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.dimensions)).toBe(true);
      expect(contract.budget_retention_policy).toBe(
        contract.command === "assurance"
          ? "verdict_priority"
          : "ordered_prefix",
      );
    }
  });

  it("resolves canonical controls ahead of legacy aliases and intent defaults", () => {
    expect(
      resolveReadOutputDimensions("get", {
        outputInclude: "item,linked",
        outputLimit: "4",
        outputBudget: "1200",
        outputFormat: "json",
        fields: "id,title",
        depth: "deep",
        tokenBudget: "900",
        format: "toon",
        for: "inspect",
      }),
    ).toMatchObject({
      include: {
        source: "canonical",
        value: ["item", "linked"],
      },
      amount: { source: "canonical", value: 4 },
      cost: { source: "canonical", value: 1200 },
      encoding: { source: "canonical", value: "json" },
      precedence: ["canonical", "legacy", "intent", "default"],
    });
  });

  it("resolves format-aware default ceilings and an explicit unbounded escape hatch", () => {
    expect(resolveReadOutputDimensions("list", {})).toMatchObject({
      cost: { source: "default", value: 4_000 },
    });
    expect(resolveReadOutputDimensions("list-all", {})).toMatchObject({
      command: "list",
      cost: { source: "intent", value: "unbounded" },
    });
    expect(
      resolveReadOutputDimensions("list", { truncate: false }),
    ).toMatchObject({
      amount: { source: "legacy", value: "unbounded" },
      cost: { source: "intent", value: "unbounded" },
    });
    expect(
      resolveReadOutputDimensions("comments-audit", {
        resolvedOutputFormat: "json",
      }),
    ).toMatchObject({
      command: "comments-audit",
      cost: { source: "default", value: 6_000 },
    });
    expect(
      resolveReadOutputDimensions("assurance run", {
        outputBudget: "unbounded",
      }),
    ).toMatchObject({
      command: "assurance",
      cost: { source: "canonical", value: "unbounded" },
    });
  });

  it("projects fields, bounds rows, and emits an exact machine-readable receipt", () => {
    const projected = applyReadOutputDimensions(
      "list",
      {
        outputInclude: "id,title",
        outputLimit: "2",
        outputBudget: "800",
      },
      {
        items: [
          { id: "pm-1", title: "One", body: "discard" },
          { id: "pm-2", title: "Two", body: "discard" },
          { id: "pm-3", title: "Three", body: "discard" },
        ],
        count: 3,
        total: 3,
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );

    expect(projected).toMatchObject({
      items: [
        { id: "pm-1", title: "One" },
        { id: "pm-2", title: "Two" },
      ],
      count: 2,
      total: 3,
      has_more: true,
      truncated: true,
      read_output: {
        command: "list",
        requested_dimensions: ["include", "amount", "cost"],
        precedence: ["canonical", "legacy", "intent", "default"],
        within_budget: true,
      },
    });
    expect(isReadOutputBudgetExceeded(projected)).toBe(false);
    if (isReadOutputBudgetExceeded(projected) || !projected.read_output) {
      throw new Error("Expected a shaped read result with a receipt.");
    }
    expect(projected.read_output.estimated_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(projected), "utf8") / 4),
    );
  });

  it("counts every retained row collection after applying an amount bound", () => {
    const projected = applyReadOutputDimensions(
      "list",
      { outputLimit: 2 },
      {
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
        related: [{ id: "r1" }],
        metadata: "not-a-row-array",
        count: 4,
        row_contract: {
          command: "list",
          row_keys: ["items", "related", "metadata"],
        },
      },
    );
    expect(projected).toMatchObject({ count: 3 });
  });

  it("keeps legacy flags working while publishing one-line migration hints", () => {
    const result = { checks: [{ name: "storage", status: "ok" }] };
    const resolved = resolveReadOutputDimensions("health", { summary: true });
    expect(resolved).toMatchObject({
      legacy_aliases_used: ["--summary"],
      migration_hints: [
        "--summary is a compatibility alias; prefer --output-include summary.",
      ],
    });
    expect(applyReadOutputDimensions("health", { summary: true }, result)).toBe(
      result,
    );
    expect(
      resolveReadOutputDimensions("activity", { unbounded: true }),
    ).toMatchObject({
      migration_hints: [
        "--unbounded is a compatibility alias; prefer --output-limit unbounded.",
      ],
    });
    expect(
      resolveReadOutputDimensions("list", { truncate: false }),
    ).toMatchObject({
      migration_hints: [
        "--no-truncate is a compatibility alias; prefer --output-limit unbounded.",
      ],
    });
    for (const command of ["health", "validate"] as const) {
      const contract = PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
        (entry) => entry.command === command,
      );
      expect(
        contract?.dimensions.include.legacy_aliases.map((entry) => entry.flag),
      ).not.toContain("--verbose");
    }
    const contextResult = {
      filters: { token_budget: 64 },
      packing: { token_budget: 64 },
      detail: "x".repeat(2_000),
    };
    expect(
      applyReadOutputDimensions(
        "context",
        { tokenBudget: "64" },
        contextResult,
      ),
    ).toBe(contextResult);
  });

  it("fails closed to a bounded receipt when the requested budget is infeasible", () => {
    const projected = applyReadOutputDimensions(
      "stats",
      { outputBudget: 256 },
      Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `field_${index}`,
          "x".repeat(100),
        ]),
      ),
    );
    expect(projected).toMatchObject({
      output_budget_exceeded: {
        omitted_result: true,
        reason: "requested_budget_infeasible",
        restore_with: "Unbounded",
        recovery: { outputBudget: "unbounded" },
      },
      read_output: {
        command: "stats",
        within_budget: false,
        result_omitted: true,
      },
    });
    expect(isReadOutputBudgetExceeded(projected)).toBe(true);
    expect(projected.read_output.estimated_tokens).toBeLessThanOrEqual(256);
    expect(
      projected.read_output.omitted_result_estimated_tokens,
    ).toBeGreaterThan(256);

    const perCallOnly = applyReadOutputDimensions(
      "stats",
      { outputBudget: 1 },
      { detail: "cannot fit" },
    );
    expect(perCallOnly).toMatchObject({
      output_budget_exceeded: { omitted_result: true },
      read_output: { result_omitted: true },
    });

    expect(() =>
      applyReadOutputDimensions(
        "list",
        {
          outputSession: {
            version: 1,
            id: "exhausted",
            token_budget: 256,
            spent_tokens: 256,
            seen_item_ids: [],
          },
        },
        { items: [{ id: "pm-1", title: "Cannot fit" }] },
      ),
    ).toThrow("remaining output-session budget cannot fit");
  });

  it("includes mandatory session receipts in the binding remaining budget", () => {
    for (const state of [
      {
        version: 1 as const,
        id: "tiny",
        token_budget: 256,
        spent_tokens: 0,
        seen_item_ids: [],
      },
      {
        version: 1 as const,
        id: "tiny",
        token_budget: 512,
        spent_tokens: 256,
        seen_item_ids: [],
      },
    ]) {
      const remaining = state.token_budget - state.spent_tokens;
      const bounded = applyReadOutputDimensions(
        "list",
        { outputSession: state },
        { items: [{ id: "pm-1", title: "x".repeat(2_000) }] },
      ) as Record<string, unknown>;
      const estimatedTokens = Math.ceil(
        Buffer.byteLength(JSON.stringify(bounded), "utf8") / 4,
      );
      expect(bounded).toMatchObject({
        output_budget_exceeded: { omitted_result: true },
        read_output: {
          estimated_tokens: estimatedTokens,
          within_budget: false,
          result_omitted: true,
        },
        read_session: {
          spent_before_tokens: state.spent_tokens,
          spent_this_call_tokens: estimatedTokens,
          charged_this_call_tokens: estimatedTokens,
        },
      });
      expect(estimatedTokens).toBeLessThanOrEqual(remaining);
    }

    expect(() =>
      applyReadOutputDimensions(
        "list",
        {
          outputSession: {
            version: 1,
            id: "session-id-too-large-for-the-terminal-receipt-at-this-budget",
            token_budget: 256,
            spent_tokens: 0,
            seen_item_ids: [],
          },
        },
        { items: [{ id: "pm-1", title: "x".repeat(2_000) }] },
      ),
    ).toThrow("remaining output-session budget cannot fit");
  });

  it("leaves mutations and unbounded reads byte-for-byte unchanged", () => {
    const result = { id: "pm-1", status: "open" };
    expect(applyReadOutputDimensions("create", {}, result)).toBe(result);
    expect(applyReadOutputDimensions("list", {}, result)).toBe(result);
    expect(
      applyReadOutputDimensions("list", { outputBudget: "unbounded" }, result),
    ).toBe(result);
    expect(
      applyReadOutputDimensions(
        "list",
        { outputBudget: "unbounded", outputInclude: "id" },
        { items: [{ id: "pm-1", title: "drop" }] },
      ),
    ).toMatchObject({
      items: [{ id: "pm-1" }],
      read_output: {
        requested_dimensions: ["include", "cost"],
        within_budget: true,
      },
    });
  });

  it("enforces a declared default only when an otherwise-unbounded result exceeds it", () => {
    const result = {
      items: Array.from({ length: 200 }, (_, index) => ({
        id: `pm-${index}`,
        detail: "x".repeat(600),
      })),
      row_contract: { command: "list", row_keys: ["items"] },
    };
    const projected = applyReadOutputDimensions("list", {}, result);
    expect(projected).not.toBe(result);
    expect(projected).toMatchObject({
      read_output: {
        budget_source: "default",
        budget_tokens: 4_000,
        requested_dimensions: [],
        within_budget: true,
      },
    });
    if (isReadOutputBudgetExceeded(projected)) {
      throw new Error("The representative default-bound list should compact.");
    }
    expect(projected.read_output?.estimated_tokens).toBeLessThanOrEqual(4_000);

    const omitted = applyReadOutputDimensions(
      "stats",
      {},
      Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `field_${index}`,
          "x".repeat(100),
        ]),
      ),
    );
    expect(omitted).toMatchObject({
      output_budget_exceeded: { omitted_result: true },
      read_output: {
        budget_source: "default",
        budget_tokens: 6_000,
        result_omitted: true,
      },
    });
  });

  it("rejects malformed controls and mutation-scoped output projection", () => {
    expect(() =>
      validateReadOutputOptions("list", { outputLimit: "zero" }),
    ).toThrow("positive integer or unbounded");
    expect(() =>
      validateReadOutputOptions("create", { outputBudget: "100" }),
    ).toThrow("only to read commands");
    expect(() =>
      validateReadOutputOptions("comments", {
        add: "mutation",
        outputFormat: "json",
      }),
    ).toThrow("cannot be combined with a comments mutation");
  });

  it("validates every canonical value type and its snake-case transport spelling", () => {
    expect(() => validateReadOutputOptions("list", {})).not.toThrow();
    expect(() =>
      validateReadOutputOptions("list", {
        output_include: ["id", "title"],
        output_limit: "unbounded",
        output_budget: "unbounded",
        output_format: "toon",
      }),
    ).not.toThrow();
    for (const [options, message] of [
      [{ outputInclude: " , " }, "requires at least one"],
      [{ outputBudget: 0 }, "positive integer"],
      [{ outputFormat: "yaml" }, "toon or json"],
      [{ outputCursor: "" }, "non-empty continuation cursor"],
      [{ output_cursor: 1 }, "non-empty continuation cursor"],
    ] as const) {
      expect(() => validateReadOutputOptions("list", options)).toThrow(message);
    }
    expect(() =>
      validateReadOutputOptions("list", { outputCursor: "cursor-1" }),
    ).not.toThrow();
    expect(() => validateReadOutputOptions("", { outputLimit: 1 })).toThrow(
      "this command is not a read surface",
    );
  });

  it("normalizes aliases and legacy dimension spellings without changing their output", () => {
    expect(resolveReadOutputSurface(" LIST-OPEN ")).toBe("list");
    expect(resolveReadOutputSurface("ctx --depth brief")).toBe("context");
    expect(resolveReadOutputSurface("create")).toBeUndefined();
    expect(
      resolveReadOutputDimensions("list", {
        no_truncate: true,
        token_budget: "600",
        format: "toon",
      }),
    ).toMatchObject({
      amount: { source: "legacy", value: "unbounded" },
      cost: { source: "legacy", value: 600 },
      encoding: { source: "legacy", value: "toon" },
    });
    expect(
      resolveReadOutputDimensions("list", { truncate: false }),
    ).toMatchObject({ amount: { source: "legacy", value: "unbounded" } });
    expect(
      resolveReadOutputDimensions("activity", { unbounded: true }),
    ).toMatchObject({ amount: { source: "legacy", value: "unbounded" } });
    expect(resolveReadOutputDimensions("list", { limit: "4" })).toMatchObject({
      amount: { source: "legacy", value: 4 },
    });
    expect(
      resolveReadOutputDimensions("list", { limit: "invalid" })?.amount,
    ).toBeUndefined();
    expect(
      resolveReadOutputDimensions("list", { for: "triage" })?.cost,
    ).toEqual({ source: "default", value: 4_000 });
    expect(
      resolveReadOutputDimensions("list", {
        for: "triage",
        token_budget: "600",
      }),
    ).toMatchObject({ cost: { source: "legacy", value: 600 } });
    expect(
      resolveReadOutputDimensions("list", {
        after: "cursor",
        limit: "10",
      }),
    ).toMatchObject({ amount: { source: "legacy", value: 10 } });
    expect(
      resolveReadOutputDimensions("list", { token_budget: "invalid" })?.cost,
    ).toEqual({ source: "default", value: 4_000 });
    expect(
      resolveReadOutputDimensions("events", { follow: true })?.encoding,
    ).toEqual({ source: "legacy", value: "stream" });
    expect(
      resolveReadOutputDimensions("list", {
        outputInclude: ["id", "title"],
        outputLimit: "unbounded",
      }),
    ).toMatchObject({
      include: { source: "canonical", value: ["id", "title"] },
      amount: { source: "canonical", value: "unbounded" },
    });
    expect(resolveReadOutputEncoding("history", { format: "json" })).toBe(
      "json",
    );
    expect(
      resolveReadOutputEncoding("history", { format: "yaml" }),
    ).toBeUndefined();
    expect(
      resolveReadOutputEncoding("events", { follow: true }),
    ).toBeUndefined();
  });

  it("projects root fields and inferred heterogeneous row collections", () => {
    const root = applyReadOutputDimensions(
      "stats",
      { outputInclude: "alpha" },
      { alpha: 1, beta: 2 },
    );
    expect(root).toMatchObject({ alpha: 1, read_output: { command: "stats" } });
    expect(root).not.toHaveProperty("beta");

    const rows = applyReadOutputDimensions(
      "list",
      { outputInclude: "id", outputLimit: 10 },
      {
        items: [{ id: "pm-1", title: "drop" }, "literal"],
        secondary: [{ id: "pm-2", body: "drop" }],
      },
    );
    expect(rows).toMatchObject({
      items: [{ id: "pm-1" }, "literal"],
      secondary: [{ id: "pm-2" }],
      read_output: { within_budget: true },
    });

    const unbounded = applyReadOutputDimensions(
      "list",
      { outputLimit: "unbounded" },
      { items: [{ id: "pm-1" }] },
    );
    if (isReadOutputBudgetExceeded(unbounded)) {
      throw new Error(
        "An unbounded row request cannot return a budget omission.",
      );
    }
    expect(unbounded.items).toHaveLength(1);
    expect(unbounded.read_output).toMatchObject({ within_budget: true });
  });

  it("projects and bounds nested row paths through the same universal contract", () => {
    const projected = applyReadOutputDimensions(
      "graph",
      { outputInclude: "id", outputLimit: 1 },
      {
        graph: {
          nodes: [
            { id: "pm-1", title: "One" },
            { id: "pm-2", title: "Two" },
          ],
          edges: [
            { id: "edge-1", kind: "blocks" },
            { id: "edge-2", kind: "related" },
          ],
        },
        count: 4,
        row_contract: {
          command: "graph",
          row_keys: ["graph.nodes", "graph.edges"],
        },
      },
    );
    expect(projected).toMatchObject({
      graph: {
        nodes: [{ id: "pm-1" }],
        edges: [{ id: "edge-1" }],
      },
      count: 2,
      truncated: true,
      read_output: { within_budget: true },
    });
  });

  it("projects selectors qualified by a declared row path", () => {
    const projected = applyReadOutputDimensions(
      "list",
      { outputInclude: "items.id" },
      {
        items: [
          { id: "pm-1", title: "One", body: "discard" },
          { id: "pm-2", title: "Two", body: "discard" },
        ],
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );
    if (isReadOutputBudgetExceeded(projected)) {
      throw new Error("A field-only projection cannot omit its result.");
    }
    expect(projected.items).toEqual([{ id: "pm-1" }, { id: "pm-2" }]);
    expect(projected.read_output).toMatchObject({ within_budget: true });

    const rootOnly = applyReadOutputDimensions(
      "list",
      { outputInclude: "count" },
      {
        items: [{ id: "pm-1" }],
        count: 1,
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );
    expect(rootOnly).toMatchObject({
      count: 1,
      row_contract: { row_keys: ["items"] },
      read_output: { within_budget: true },
    });
    expect(rootOnly).not.toHaveProperty("items");
  });

  it("refuses selectors that empty every returned row with mode-aware guidance", () => {
    expect(() =>
      applyReadOutputDimensions(
        "list",
        { outputInclude: "nosuchfield" },
        { items: [{ id: "pm-1", title: "One" }] },
      ),
    ).toThrow(
      "No selector matched any returned row field. Declared list projection modes: brief, compact, full.",
    );

    expect(() =>
      applyReadOutputDimensions(
        "comments",
        { outputInclude: "nosuchfield" },
        { comments: [{ text: "One" }] },
      ),
    ).toThrow(
      "The comments surface declares no projection modes; name row fields instead.",
    );
  });

  it("carries cross-call spend and replaces prior item facts with references", () => {
    const first = applyReadOutputDimensions(
      "list",
      {
        outputSession: {
          version: 1,
          id: "orientation",
          token_budget: 2_000,
          spent_tokens: 0,
          seen_item_ids: [],
        },
      },
      {
        items: [
          { id: "pm-1", title: "One" },
          { id: "pm-2", title: "Two" },
        ],
        row_contract: { command: "list", row_keys: ["items"] },
      },
    ) as Record<string, unknown>;
    const firstSession = first.read_session as {
      spent_total_tokens: number;
      next_state: Record<string, unknown>;
    };
    expect(firstSession).toMatchObject({
      seen_before_count: 0,
      new_item_count: 2,
      suppressed_repeat_count: 0,
      next_state: { seen_item_ids: ["pm-1", "pm-2"] },
    });
    expect(firstSession).not.toHaveProperty("seen_item_overflow_count");

    const second = applyReadOutputDimensions(
      "search",
      { outputSession: firstSession.next_state },
      {
        items: [
          { id: "pm-1", title: "Repeated prose that must disappear" },
          { id: "pm-3", title: "Three" },
        ],
        row_contract: { command: "search", row_keys: ["items"] },
      },
    ) as Record<string, unknown>;
    expect(second).toMatchObject({
      items: [
        { id: "pm-1", context_ref: "session:orientation:pm-1" },
        { id: "pm-3", title: "Three" },
      ],
      read_session: {
        seen_before_count: 2,
        new_item_count: 1,
        suppressed_repeat_count: 1,
        next_state: { seen_item_ids: ["pm-1", "pm-2", "pm-3"] },
      },
    });
    const secondSession = second.read_session as {
      spent_before_tokens: number;
      spent_total_tokens: number;
    };
    expect(secondSession.spent_before_tokens).toBe(
      firstSession.spent_total_tokens,
    );
    expect(secondSession.spent_total_tokens).toBeGreaterThan(
      secondSession.spent_before_tokens,
    );
    const secondRead = second.read_output as { estimated_tokens: number };
    expect(secondRead.estimated_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(second), "utf8") / 4),
    );
  });

  it("preserves context references after field projection", () => {
    const projected = applyReadOutputDimensions(
      "list",
      {
        outputInclude: "id,title",
        outputSession: {
          version: 1,
          id: "orientation",
          token_budget: 2_000,
          spent_tokens: 100,
          seen_item_ids: ["pm-1"],
        },
      },
      {
        items: [{ id: "pm-1", title: "Repeated", body: "discard" }],
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );
    expect(projected).toMatchObject({
      items: [{ id: "pm-1", context_ref: "session:orientation:pm-1" }],
    });
  });

  it("rejects malformed session state before a read executes", () => {
    expect(() =>
      validateReadOutputOptions("list", {
        outputSession: JSON.stringify({
          version: 1,
          id: "orientation",
          token_budget: 2_000,
          spent_tokens: 0,
          seen_item_ids: [],
          surprise: true,
        }),
      }),
    ).toThrow('unknown field "surprise"');
  });

  it("strictly validates every caller-carried session field", () => {
    for (const [value, message] of [
      ["{", "valid JSON object"],
      [null, "JSON object"],
      [{ version: 2 }, "version must equal 1"],
      [
        {
          version: 1,
          id: 7,
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: [],
        },
        "id must be",
      ],
      [
        {
          version: 1,
          id: "not portable!",
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: [],
        },
        "id must be",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: "256",
          spent_tokens: 0,
          seen_item_ids: [],
        },
        "token_budget",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 255,
          spent_tokens: 0,
          seen_item_ids: [],
        },
        "token_budget",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: "0",
          seen_item_ids: [],
        },
        "spent_tokens",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: -1,
          seen_item_ids: [],
        },
        "spent_tokens",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: 257,
          seen_item_ids: [],
        },
        "spent_tokens",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: "pm-1",
        },
        "seen_item_ids",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: Array.from(
            { length: PM_READ_OUTPUT_SESSION_MAX_SEEN_ITEM_IDS + 1 },
            (_, index) => `pm-${index}`,
          ),
        },
        "seen_item_ids",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: [7],
        },
        "seen_item_ids",
      ],
      [
        {
          version: 1,
          id: "session",
          token_budget: 256,
          spent_tokens: 0,
          seen_item_ids: ["not portable!"],
        },
        "seen_item_ids",
      ],
    ] as const) {
      expect(() => parseReadOutputSession(value)).toThrow(message);
    }
    expect(
      parseReadOutputSession({
        version: 1,
        id: "session",
        token_budget: 256,
        spent_tokens: 0,
        seen_item_ids: ["pm-z", "pm-a", "pm-z"],
      }),
    ).toMatchObject({ seen_item_ids: ["pm-a", "pm-z"] });
  });

  it("keeps producer next states valid when newly served identities exceed capacity", () => {
    const seenItemIds = Array.from(
      { length: PM_READ_OUTPUT_SESSION_MAX_SEEN_ITEM_IDS - 1 },
      (_, index) => `pm-seen-${String(index).padStart(5, "0")}`,
    );
    const result = attachReadOutputSessionReceipt(
      {
        items: [{ id: "pm-new-z" }, { id: "pm-new-a" }],
        row_contract: { command: "list", row_keys: ["items"] },
      },
      {
        version: 1,
        id: "capacity",
        token_budget: 1_000_000,
        spent_tokens: 0,
        seen_item_ids: seenItemIds,
      },
    );
    const receipt = result.read_session;
    expect(receipt.next_state.seen_item_ids).toHaveLength(
      PM_READ_OUTPUT_SESSION_MAX_SEEN_ITEM_IDS,
    );
    expect(receipt.next_state.seen_item_ids).toContain("pm-new-a");
    expect(receipt.next_state.seen_item_ids).not.toContain("pm-new-z");
    expect(receipt.next_state.seen_item_ids).toEqual(
      [...receipt.next_state.seen_item_ids].sort(),
    );
    expect(receipt).toMatchObject({ seen_item_overflow_count: 1 });
    expect(parseReadOutputSession(receipt.next_state)).toEqual(
      receipt.next_state,
    );
  });

  it("maps, counts, and bounds nested object rows and ignores invalid paths", () => {
    const result = {
      graph: {
        nodes: {
          first: { item_id: "pm-1", title: "One" },
          second: { item: { id: "pm-2" }, title: "Two" },
          literal: "value",
          unidentified: { title: "No id" },
        },
      },
      invalid: "not-an-object",
      row_contract: {
        command: "graph",
        row_keys: ["graph.nodes", "invalid.rows"],
      },
    };
    expect(readOutputRowCollections(result)).toHaveLength(1);
    expect(countReadOutputRows(result)).toBe(4);
    expect(
      sliceReadOutputRowCollection(result, "graph.nodes", 2),
    ).toMatchObject({
      graph: {
        nodes: {
          literal: "value",
          unidentified: { title: "No id" },
        },
      },
    });
    expect(sliceReadOutputRowCollection(result, "missing.rows", 1)).toBe(
      result,
    );
    const mapped = mapReadOutputRows(result, (row, path, index) => ({
      row,
      path,
      index,
    }));
    expect(
      (mapped as { graph: { nodes: Record<string, unknown> } }).graph.nodes,
    ).toEqual({
      first: {
        row: result.graph.nodes.first,
        path: "graph.nodes",
        index: 0,
      },
      second: {
        row: result.graph.nodes.second,
        path: "graph.nodes",
        index: 1,
      },
      literal: { row: "value", path: "graph.nodes", index: 2 },
      unidentified: {
        row: result.graph.nodes.unidentified,
        path: "graph.nodes",
        index: 3,
      },
    });
    expect(boundReadOutputRows(result, 1)).toMatchObject({
      truncated: true,
      result: { graph: { nodes: { first: result.graph.nodes.first } } },
    });

    const sessionResult = applyReadOutputDimensions(
      "graph",
      {
        outputSession: {
          version: 1,
          id: "object-map",
          token_budget: 2_000,
          spent_tokens: 0,
          seen_item_ids: ["pm-1", "pm-2"],
        },
      },
      result,
    );
    expect(sessionResult).toMatchObject({
      graph: {
        nodes: {
          first: { id: "pm-1", context_ref: "session:object-map:pm-1" },
          second: { id: "pm-2", context_ref: "session:object-map:pm-2" },
          literal: "value",
          unidentified: { title: "No id" },
        },
      },
      read_session: { suppressed_repeat_count: 2, new_item_count: 0 },
    });
  });

  it("discovers nested budget collections without redefining projected rows", () => {
    const result = {
      checks: [
        {
          details: {
            missing_resolution_rows: [{ id: "pm-1" }, { id: "pm-2" }],
            remediation_hints: ["one", "two"],
          },
        },
      ],
      read_output: { requested_dimensions: ["cost"] },
    };
    expect(readOutputRowCollections(result).map(({ path }) => path)).toEqual([
      "checks",
    ]);
    expect(readOutputBudgetCollections(result).map(({ path }) => path)).toEqual(
      [
        "checks",
        "checks.0.details.missing_resolution_rows",
        "checks.0.details.remediation_hints",
      ],
    );
  });

  it("bounds fixed-point receipt work for adversarial serializers", () => {
    let directSerializations = 0;
    const direct = attachReadOutputSessionReceipt(
      {
        toJSON: () => ({
          value: "x".repeat(directSerializations++ % 2 === 0 ? 4 : 400),
        }),
      },
      {
        version: 1,
        id: "adversarial-direct",
        token_budget: 2_000,
        spent_tokens: 0,
        seen_item_ids: [],
      },
    );
    expect(direct).toHaveProperty("read_session");
    expect(directSerializations).toBeGreaterThan(0);
    expect(directSerializations).toBeLessThanOrEqual(8);

    let composedSerializations = 0;
    const composed = applyReadOutputDimensions(
      "list",
      {
        outputSession: {
          version: 1,
          id: "adversarial-composed",
          token_budget: 20_000,
          spent_tokens: 0,
          seen_item_ids: [],
        },
      },
      {
        toJSON: () => ({
          value: "x".repeat(composedSerializations++ * 20 + 4),
        }),
      },
    );
    expect(composed).toHaveProperty("read_session");
    expect(composedSerializations).toBeGreaterThan(0);
    expect(composedSerializations).toBeLessThanOrEqual(144);
  });

  it("compacts explanatory text and rows before omitting a budgeted result", () => {
    const textCompacted = applyReadOutputDimensions(
      "stats",
      { outputBudget: 300 },
      { detail: "x".repeat(2_000) },
    );
    expect(textCompacted).toMatchObject({
      read_output: {
        within_budget: true,
        strings_compacted: true,
        rows_compacted: false,
        result_omitted: false,
      },
    });
    if (isReadOutputBudgetExceeded(textCompacted)) {
      throw new Error("Expected compacted text instead of an omission.");
    }
    expect(String(textCompacted.detail).endsWith("…")).toBe(true);

    const makeRows = (prefix: string) =>
      Array.from({ length: 8 }, (_, index) => ({
        id: `${prefix}-${index}`,
        detail: "x".repeat(600),
      }));
    const rowCompacted = applyReadOutputDimensions(
      "list",
      { outputBudget: 650 },
      {
        items: makeRows("item"),
        related: makeRows("related"),
        metadata: "not-a-row-array",
        count: 16,
        row_contract: {
          command: "list",
          row_keys: ["items", "related", "metadata"],
        },
      },
    );
    expect(rowCompacted).toMatchObject({
      has_more: true,
      truncated: true,
      read_output: {
        within_budget: true,
        strings_compacted: true,
        rows_compacted: true,
        result_omitted: false,
      },
    });
    if (isReadOutputBudgetExceeded(rowCompacted)) {
      throw new Error("Expected compacted rows instead of an omission.");
    }
    expect(rowCompacted.count).toBe(
      rowCompacted.items.length + rowCompacted.related.length,
    );

    const paginated = applyReadOutputDimensions(
      "list",
      { outputBudget: 650 },
      {
        items: makeRows("page"),
        count: 8,
        total: 20,
        applied_limit: 8,
        has_more: true,
        truncated: true,
        next_cursor: encodeQueryCursor("list-fingerprint", "page-7", 7),
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );
    if (isReadOutputBudgetExceeded(paginated)) {
      throw new Error("Expected a cursor-rebased compacted page.");
    }
    const retainedLast = paginated.items.at(-1);
    expect(paginated.output_budget_truncation).toMatchObject({
      continuation_cursor_rebased: true,
      continuation_available: true,
      recovery_budget_multiplier: 1,
      recovery: {
        cursor: expect.any(String),
        cli: "--output-cursor",
        sdk: "outputCursor",
        mcp: "outputCursor",
      },
    });
    expect(paginated).toMatchObject({ continuation_kind: "producer_cursor" });
    expect(
      decodeQueryCursorState(String(paginated.next_cursor), "list-fingerprint"),
    ).toEqual({
      after_id: retainedLast?.id,
      after_index: paginated.items.length - 1,
    });
    expect(paginated.applied_limit).toBe(paginated.items.length);

    const rawCursor = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const compactPage = (
      nextCursor: string,
      items: unknown[] = makeRows("defensive"),
    ) =>
      applyReadOutputDimensions(
        "list",
        { outputBudget: 550 },
        {
          items,
          next_cursor: nextCursor,
          has_more: true,
          row_contract: { command: "list", row_keys: ["items"] },
        },
      );
    for (const malformedCursor of [
      "not-json",
      rawCursor(null),
      rawCursor([]),
      rawCursor({}),
      rawCursor({ version: 2, fingerprint: "scope", after_index: 7 }),
      rawCursor({ version: 1, after_index: 7 }),
      rawCursor({ version: 1, fingerprint: 7, after_index: 7 }),
      rawCursor({ version: 1, fingerprint: "scope" }),
      rawCursor({ version: 1, fingerprint: "scope", after_id: "row-7" }),
      rawCursor({ version: 1, fingerprint: "scope", after_index: 1.5 }),
      rawCursor({ version: 1, fingerprint: "scope", after_index: -1 }),
    ]) {
      const defensive = compactPage(malformedCursor);
      expect(defensive).toMatchObject({
        output_budget_truncation: { continuation_cursor_rebased: false },
      });
    }
    for (const invalidLastRow of [
      "x".repeat(600),
      null,
      ["x".repeat(600)],
      { detail: "x".repeat(600) },
      { id: 7, detail: "x".repeat(600) },
      { id: "", detail: "x".repeat(600) },
    ]) {
      const defensive = compactPage(
        encodeQueryCursor("scope", "row-7", 7),
        Array.from({ length: 1_000 }, () => structuredClone(invalidLastRow)),
      );
      if (isReadOutputBudgetExceeded(defensive)) {
        throw new Error("Expected defensive row compaction, not omission.");
      }
      const retainedLastRow = defensive.items.at(-1);
      expect(
        Object.prototype.toString.call(retainedLastRow) !== "[object Object]" ||
          typeof Reflect.get(retainedLastRow as object, "id") !== "string" ||
          Reflect.get(retainedLastRow as object, "id").length === 0,
      ).toBe(true);
      expect(defensive).toMatchObject({
        output_budget_truncation: { continuation_cursor_rebased: false },
      });
    }
    const negativeRebase = compactPage(encodeQueryCursor("scope", "row-0", 0));
    expect(negativeRebase).toMatchObject({
      output_budget_truncation: { continuation_cursor_rebased: false },
    });
    const unrelatedRowsCompacted = applyReadOutputDimensions(
      "list",
      { outputBudget: 550 },
      {
        items: [{ id: "kept" }],
        related: makeRows("related-only"),
        next_cursor: encodeQueryCursor("scope", "kept", 0),
        has_more: true,
        row_contract: { command: "list", row_keys: ["items", "related"] },
      },
    );
    expect(unrelatedRowsCompacted).toMatchObject({
      items: [{ id: "kept" }],
      output_budget_truncation: { continuation_cursor_rebased: false },
    });
    const continuedFromInput = applyReadOutputDimensions(
      "list",
      {
        outputBudget: 550,
        after: encodeQueryCursor("list-fingerprint", "previous", 9),
      },
      {
        items: makeRows("continued"),
        next_cursor: null,
        has_more: false,
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );
    if (isReadOutputBudgetExceeded(continuedFromInput)) {
      throw new Error("Expected the input cursor to be rebased.");
    }
    expect(
      decodeQueryCursorState(
        String(continuedFromInput.next_cursor),
        "list-fingerprint",
      ),
    ).toEqual({
      after_id: continuedFromInput.items.at(-1)?.id,
      after_index: 9 + continuedFromInput.items.length,
    });
    const snapshotted = compactPage(
      encodeQueryCursor("snapshot-scope", "page-7", 7, "tree-1"),
    );
    if (isReadOutputBudgetExceeded(snapshotted)) {
      throw new Error("Expected the snapshot cursor to be rebased.");
    }
    expect(
      decodeQueryCursorState(String(snapshotted.next_cursor), "snapshot-scope"),
    ).toMatchObject({ snapshot: "tree-1" });

    const withoutCount = applyReadOutputDimensions(
      "list",
      { outputBudget: 700 },
      {
        items: makeRows("item"),
        related: makeRows("related"),
        row_contract: { command: "list", row_keys: ["items", "related"] },
      },
    );
    expect(withoutCount).not.toHaveProperty("count");
    expect(withoutCount).toMatchObject({
      read_output: { within_budget: true, result_omitted: false },
    });

    const inferredRows = applyReadOutputDimensions(
      "list",
      { outputBudget: 350 },
      { items: makeRows("item"), related: makeRows("related") },
    );
    expect(inferredRows).toMatchObject({
      has_more: true,
      truncated: true,
      read_output: { rows_compacted: true },
    });

    const objectRowsInput = {
      graph: {
        nodes: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            `pm-${index}`,
            { id: `pm-${index}`, detail: "x".repeat(600) },
          ]),
        ),
      },
      row_contract: { command: "graph", row_keys: ["graph.nodes"] },
    };
    const objectRows = applyReadOutputDimensions(
      "graph",
      { outputBudget: 400 },
      structuredClone(objectRowsInput),
    );
    expect(objectRows).toMatchObject({
      has_more: true,
      truncated: true,
      read_output: { rows_compacted: true },
    });
    if (isReadOutputBudgetExceeded(objectRows)) {
      throw new Error("Expected resumable object rows.");
    }
    const continuedObjectRows = applyReadOutputDimensions(
      "graph",
      { outputBudget: 400, outputCursor: String(objectRows.next_cursor) },
      structuredClone(objectRowsInput),
    );
    expect(continuedObjectRows).toMatchObject({
      graph: { nodes: expect.objectContaining({}) },
    });

    const mixedRows = applyReadOutputDimensions(
      "graph",
      { outputBudget: 500 },
      {
        graph: {
          nodes: Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `pm-${index}`,
              { id: `pm-${index}`, detail: "x".repeat(600) },
            ]),
          ),
          edges: Array.from({ length: 8 }, (_, index) => ({
            id: `edge-${index}`,
            detail: "x".repeat(600),
          })),
        },
        row_contract: {
          command: "graph",
          row_keys: ["graph.nodes", "graph.edges"],
        },
      },
    );
    expect(mixedRows).toMatchObject({
      has_more: true,
      truncated: true,
      read_output: { rows_compacted: true },
    });

    const validationResult = {
      ok: false,
      checks: [
        {
          name: "resolution",
          details: {
            missing_resolution_rows: makeRows("missing"),
            missing_resolution_remediation_hints: makeRows("hint"),
          },
        },
        { name: "history", details: { findings: [] } },
      ],
    };
    const nestedRows = applyReadOutputDimensions(
      "validate",
      { outputBudget: 700, outputLimit: "unbounded" },
      structuredClone(validationResult),
    );
    expect(nestedRows).toMatchObject({
      ok: false,
      has_more: true,
      truncated: true,
      output_budget_truncation: {
        restore_with: expect.any(String),
        continuation_available: expect.any(Boolean),
        overridden_dimensions: ["amount"],
        compacted_row_paths: expect.arrayContaining([
          "checks.0.details.missing_resolution_rows",
          "checks.0.details.missing_resolution_remediation_hints",
        ]),
      },
      read_output: {
        within_budget: true,
        rows_compacted: true,
        compacted_row_paths: expect.arrayContaining([
          "checks.0.details.missing_resolution_rows",
        ]),
      },
    });
    expect(isReadOutputBudgetExceeded(nestedRows)).toBe(false);
    const restoredNestedRows = applyReadOutputDimensions(
      "validate",
      { outputBudget: "unbounded" },
      structuredClone(validationResult),
    );
    expect(restoredNestedRows).not.toHaveProperty("output_budget_truncation");
    expect(
      restoredNestedRows.checks[0]?.details.missing_resolution_rows,
    ).toHaveLength(8);
    expect(
      restoredNestedRows.checks[0]?.details
        .missing_resolution_remediation_hints,
    ).toHaveLength(8);
  });

  it("resumes verdict-prioritized declared rows at the first withheld assertion", () => {
    expect(prioritizeAssuranceAssertions({ verdict: "pass" })).toEqual({
      verdict: "pass",
    });
    expect(
      prioritizeAssuranceAssertions({
        assertions: [
          { assertion_id: "pass", verdict: "pass" },
          null,
          { assertion_id: "retired", verdict: "retired" },
        ],
      }).assertions,
    ).toEqual([
      { assertion_id: "retired", verdict: "retired" },
      { assertion_id: "pass", verdict: "pass" },
      null,
    ]);
    const assertions = [
      ...Array.from({ length: 9 }, (_, index) => ({
        assertion_id: `pass-${index}`,
        verdict: "pass",
        enforcement: "block",
        detail: "x".repeat(600),
      })),
      {
        assertion_id: "blocking-tail",
        verdict: "fail",
        enforcement: "block",
        detail: "x".repeat(600),
      },
      {
        assertion_id: "warning-tail",
        verdict: "fail",
        enforcement: "warn",
        detail: "x".repeat(600),
      },
      {
        assertion_id: "observed-tail",
        verdict: "fail",
        enforcement: "observe",
        detail: "x".repeat(600),
      },
    ];
    const input = {
      verdict: "block",
      assertions,
      assertions_total: assertions.length,
      row_contract: { command: "assurance", row_keys: ["assertions"] },
    };
    const first = applyReadOutputDimensions(
      "assurance",
      { outputBudget: 650 },
      structuredClone(input),
    );
    if (isReadOutputBudgetExceeded(first)) {
      throw new Error("Expected a resumable assurance page.");
    }
    expect(first).toMatchObject({
      assertions_total: 12,
      budget_retention_policy: "verdict_priority",
      continuation_kind: "output_cursor",
      output_budget_truncation: {
        continuation_available: true,
        recovery_budget_multiplier: 1,
        continuations: [
          expect.objectContaining({
            path: "assertions",
            total_rows: 12,
          }),
        ],
      },
    });
    expect(first.assertions[0]).toMatchObject({
      assertion_id: "blocking-tail",
      verdict: "fail",
    });
    expect(
      first.assertions
        .filter((entry) => entry.verdict === "fail")
        .map((entry) => entry.assertion_id),
    ).toEqual(["blocking-tail", "warning-tail", "observed-tail"]);
    const cursor = String(first.next_cursor);
    expect(decodeReadOutputContinuationCursor(cursor)).toMatchObject({
      command: "assurance",
      path: "assertions",
      offset: first.assertions.length,
      total_rows: 12,
    });

    const second = applyReadOutputDimensions(
      "assurance",
      { outputBudget: 650, outputCursor: cursor },
      structuredClone(input),
    );
    if (isReadOutputBudgetExceeded(second)) {
      throw new Error("Expected the next assurance page.");
    }
    expect(second.assertions[0]?.assertion_id).toBe(
      `pass-${first.assertions.length - 3}`,
    );
    expect(second.assertions.some((entry) => entry.verdict === "fail")).toBe(
      false,
    );

    expect(() =>
      applyReadOutputDimensions(
        "assurance",
        { outputCursor: cursor },
        { ...structuredClone(input), assertions: assertions.slice(1) },
      ),
    ).toThrow("no longer matches");
    expect(() =>
      applyReadOutputDimensions(
        "list",
        { outputCursor: cursor },
        { items: [{ id: "pm-1" }] },
      ),
    ).toThrow("belongs to assurance");
    expect(() =>
      applyReadOutputDimensions(
        "list",
        {
          outputCursor: encodeReadOutputContinuationCursor({
            command: "list",
            path: "missing.rows",
            offset: 0,
            total_rows: 1,
            fingerprint: "missing",
          }),
        },
        { items: [{ id: "pm-1" }] },
      ),
    ).toThrow("no longer matches");

    for (const malformed of [
      "not-json",
      { version: 2 },
      { version: 1, command: "create" },
      { version: 1, command: "list", path: 1 },
      { version: 1, command: "list", path: "", offset: 0 },
      { version: 1, command: "list", path: "items", offset: "0" },
      { version: 1, command: "list", path: "items", offset: -1 },
      {
        version: 1,
        command: "list",
        path: "items",
        offset: 0,
        total_rows: "1",
      },
      {
        version: 1,
        command: "list",
        path: "items",
        offset: 0,
        total_rows: 0,
      },
      {
        version: 1,
        command: "list",
        path: "items",
        offset: 0,
        total_rows: 1,
        fingerprint: 1,
      },
      {
        version: 1,
        command: "list",
        path: "items",
        offset: 0,
        total_rows: 1,
        fingerprint: "",
      },
    ]) {
      const malformedCursor =
        typeof malformed === "string"
          ? malformed
          : Buffer.from(JSON.stringify(malformed), "utf8").toString(
              "base64url",
            );
      expect(() => decodeReadOutputContinuationCursor(malformedCursor)).toThrow(
        "malformed or unsupported",
      );
    }
  });

  it("bounds token estimation when custom JSON serialization never reaches a fixed point", () => {
    let serializationCount = 0;
    const receipt = {
      command: "list" as const,
      requested_dimensions: [],
      precedence: ["canonical", "legacy", "intent", "default"] as const,
      legacy_aliases_used: [],
      migration_hints: [],
      estimated_tokens: 0,
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    };
    updateReadOutputReceiptEstimate(
      {
        toJSON: () => ({
          value: "x".repeat(serializationCount++ % 2 === 0 ? 4 : 400),
        }),
      },
      receipt,
    );
    expect(serializationCount).toBe(8);
    expect(receipt.estimated_tokens).toBeGreaterThan(50);
  });

  it("composes intent, relevance order, row bounds, and token budgets", () => {
    const projected = attachReadOutputContracts(
      "search",
      {
        for: "discover",
        outputInclude: "id,score",
        outputLimit: 2,
        outputBudget: 1_000,
      },
      {
        items: [
          { id: "pm-high", title: "High", score: 0.99 },
          { id: "pm-mid", title: "Mid", score: 0.75 },
          { id: "pm-low", title: "Low", score: 0.5 },
        ],
        row_contract: { command: "search", row_keys: ["items"] },
      },
    ) as Record<string, unknown>;
    expect(projected).toMatchObject({
      items: [
        { id: "pm-high", score: 0.99 },
        { id: "pm-mid", score: 0.75 },
      ],
      context_intent: { intent: "discover", within_budget: true },
      read_output: { within_budget: true },
    });
  });
});
