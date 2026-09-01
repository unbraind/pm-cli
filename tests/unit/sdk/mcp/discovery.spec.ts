import { describe, expect, it } from "vitest";

import {
  PM_MCP_ENTRY_TOOL_NAMES,
  discoverPmTools,
  parsePmToolDiscoveryOptions,
  type PmToolDiscoveryCandidate,
} from "../../../../src/sdk/mcp/discovery.js";
import { PmCliError } from "../../../../src/sdk/runtime-primitives.js";

function candidate(
  name: string,
  description = `Operate ${name}`,
): PmToolDiscoveryCandidate {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
}

describe("progressive MCP tool discovery", () => {
  it("composes every declared signal and exposes the ranking policy", () => {
    const result = discoverPmTools(
      [
        {
          ...candidate("pm_close", "Close completed work with evidence"),
          signals: { semantic: 1, graph: 1, freshness: 1, usage: 1 },
        },
        candidate("pm_get", "Inspect one work item"),
      ],
      { query: "close completed evidence", outputBudget: "unbounded" },
    );

    expect(result.tools[0]).toMatchObject({
      name: "pm_close",
      command: "close",
      family: "lifecycle",
      signals: {
        lexical: { available: true, source: "computed" },
        semantic: { value: 1, available: true, source: "host" },
        graph: { value: 1, available: true, source: "host" },
        permission: { value: 1, source: "authorization" },
        freshness: { value: 1, available: true, source: "host" },
        usage: { value: 1, available: true, source: "host" },
      },
    });
    expect(Object.keys(result.ranking_policy.weights).sort()).toEqual([
      "freshness",
      "graph",
      "lexical",
      "permission",
      "semantic",
      "usage",
    ]);
    expect(result.tools[1]?.signals).toMatchObject({
      semantic: { available: true, source: "computed" },
      graph: { available: true, source: "computed" },
      freshness: { available: true, source: "computed" },
      usage: { available: true, source: "computed" },
    });

    const malformedHostSignal = discoverPmTools(
      [{ ...candidate("pm_get"), signals: { semantic: Number.NaN } }],
      { outputBudget: "unbounded" },
    );
    expect(malformedHostSignal.tools[0]?.signals.semantic).toMatchObject({
      value: 0,
      available: true,
      source: "host",
    });
  });

  it("filters unauthorized and tier-incompatible tools before ranking", () => {
    const result = discoverPmTools(
      [
        { ...candidate("pm_close"), authorized: false },
        candidate("pm_context"),
        candidate("pm_health"),
      ],
      { tier: "core", outputBudget: "unbounded" },
    );
    expect(result.tools.map(({ name }) => name)).toEqual(["pm_context"]);
  });

  it("applies the default budget and an exact capability-family filter", () => {
    const result = discoverPmTools(
      [candidate("pm_close"), candidate("pm_get")],
      { family: "lifecycle" },
    );
    expect(result.tools.map(({ name }) => name)).toEqual(["pm_close"]);
    expect(result.token_cost.budget).toBe(1_200);
  });

  it("rejects unknown runtime tier and family values instead of returning empty results", () => {
    for (const tier of ["unknown", "internal", 42]) {
      expect(() =>
        discoverPmTools([candidate("pm_get")], { tier: tier as never }),
      ).toThrow(/tier must be/u);
    }
    for (const family of ["unknown", 42]) {
      expect(() =>
        discoverPmTools([candidate("pm_get")], { family: family as never }),
      ).toThrow(/family must be/u);
    }
  });

  it("treats prototype-inherited candidate names as unregistered tools", () => {
    const result = discoverPmTools(
      [candidate("toString"), candidate("valueOf"), candidate("constructor")],
      { outputBudget: "unbounded" },
    );

    expect(result.tools).toHaveLength(3);
    expect(result.tools.every(({ command }) => command === "help")).toBe(true);
  });

  it("uses locale-independent code-unit ordering for equal-score names", () => {
    const result = discoverPmTools([candidate("a_tool"), candidate("Z_tool")], {
      outputBudget: "unbounded",
    });

    expect(result.tools.map(({ name }) => name)).toEqual(["Z_tool", "a_tool"]);
    expect(
      discoverPmTools([candidate("same"), candidate("same")], {
        outputBudget: "unbounded",
      }).tools.map(({ name }) => name),
    ).toEqual(["same", "same"]);
  });

  it("pages without duplicates and rejects stale or mismatched cursors", () => {
    const candidates = Array.from({ length: 137 }, (_, index) =>
      candidate(`pm_synthetic_${String(index).padStart(3, "0")}`),
    );
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = discoverPmTools(candidates, {
        query: "synthetic",
        limit: 17,
        cursor,
        outputBudget: "unbounded",
      });
      names.push(...page.tools.map(({ name }) => name));
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    expect(names).toHaveLength(137);
    expect(new Set(names).size).toBe(137);

    const first = discoverPmTools(candidates, {
      query: "synthetic",
      limit: 5,
      outputBudget: "unbounded",
    });
    expect(() =>
      discoverPmTools(candidates, {
        query: "different",
        cursor: first.next_cursor,
        outputBudget: "unbounded",
      }),
    ).toThrow(/Invalid or stale/u);

    const decoded = JSON.parse(
      Buffer.from(first.next_cursor ?? "", "base64url").toString("utf8"),
    ) as { offset: number; signature: string };
    const forgedCursor = Buffer.from(
      JSON.stringify({ ...decoded, offset: decoded.offset + 1 }),
      "utf8",
    ).toString("base64url");
    const malformedCursors = [
      forgedCursor,
      "not-json",
      Buffer.from(JSON.stringify({ ...decoded, version: 2 }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ ...decoded, offset: 1.5 }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ ...decoded, offset: -1 }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ version: 1, offset: decoded.offset }),
        "utf8",
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ ...decoded, signature: "" }),
        "utf8",
      ).toString("base64url"),
    ];
    for (const cursorValue of malformedCursors) {
      expect(() =>
        discoverPmTools(candidates, {
          query: "synthetic",
          limit: 5,
          cursor: cursorValue,
          outputBudget: "unbounded",
        }),
      ).toThrow(/Invalid or stale/u);
    }
    const pastEndCursor = Buffer.from(
      JSON.stringify({ ...decoded, offset: candidates.length + 1 }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      discoverPmTools(candidates, {
        query: "synthetic",
        limit: 5,
        cursor: pastEndCursor,
        outputBudget: "unbounded",
      }),
    ).toThrow(/Invalid or stale/u);
  });

  it("scopes private cache identities to the exact discovery page inputs", () => {
    const candidates = PM_MCP_ENTRY_TOOL_NAMES.map((name) => candidate(name));
    const first = discoverPmTools(candidates, {
      limit: 2,
      outputBudget: "unbounded",
    });
    const second = discoverPmTools(candidates, {
      limit: 2,
      cursor: first.next_cursor,
      outputBudget: "unbounded",
    });
    const differentLimit = discoverPmTools(candidates, {
      limit: 3,
      outputBudget: "unbounded",
    });
    const differentBudget = discoverPmTools(candidates, {
      limit: 2,
      outputBudget: 2_000,
    });

    expect(
      new Set([
        first.cache.key,
        second.cache.key,
        differentLimit.cache.key,
        differentBudget.cache.key,
      ]),
    ).toHaveProperty("size", 4);
  });

  it("continues cursors with a shared integrity key and rejects key rotation", () => {
    const candidates = PM_MCP_ENTRY_TOOL_NAMES.map((name) => candidate(name));
    const firstKey = new Uint8Array(32).fill(1);
    const secondKey = new Uint8Array(32).fill(2);
    const first = discoverPmTools(candidates, {
      cursorIntegrityKey: firstKey,
      limit: 2,
      outputBudget: "unbounded",
    });
    const second = discoverPmTools(candidates, {
      cursor: first.next_cursor,
      cursorIntegrityKey: firstKey,
      limit: 2,
      outputBudget: "unbounded",
    });
    const rotated = discoverPmTools(candidates, {
      cursorIntegrityKey: secondKey,
      limit: 2,
      outputBudget: "unbounded",
    });

    expect(second.returned).toBe(2);
    expect(rotated.cache.key).not.toBe(first.cache.key);
    expect(() =>
      discoverPmTools(candidates, {
        cursor: first.next_cursor,
        cursorIntegrityKey: secondKey,
        limit: 2,
        outputBudget: "unbounded",
      }),
    ).toThrow(/Invalid or stale/u);
  });

  it("reports schema and token-budget omissions with recoverable cursors", () => {
    const candidates = PM_MCP_ENTRY_TOOL_NAMES.map((name) => candidate(name));
    const compact = discoverPmTools(candidates, {
      limit: 2,
      outputBudget: "unbounded",
    });
    expect(compact.omission_receipt.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "input_schema" }),
        expect.objectContaining({ name: "tools", reason: "limit" }),
      ]),
    );
    expect(compact.tools[0]?.input_schema).toBeUndefined();

    const expanded = discoverPmTools(candidates, {
      includeSchema: true,
      outputBudget: "unbounded",
    });
    expect(expanded.tools[0]?.input_schema).toBeDefined();
    expect(expanded.token_cost.within_budget).toBe(true);

    const budgeted = discoverPmTools(candidates, { outputBudget: 1_200 });
    expect(budgeted.token_cost.estimated_tokens).toBeLessThanOrEqual(1_200);
    expect(
      Math.ceil(Buffer.byteLength(JSON.stringify(budgeted), "utf8") / 4),
    ).toBe(budgeted.token_cost.estimated_tokens);
    let minimumBudgetRefusal: unknown;
    try {
      discoverPmTools([candidate("pm_context")], { outputBudget: 128 });
    } catch (error: unknown) {
      minimumBudgetRefusal = error;
    }
    if (!(minimumBudgetRefusal instanceof PmCliError)) {
      throw new Error("expected a minimum discovery budget refusal");
    }
    const requiredBudget = Number(minimumBudgetRefusal.context.required);
    expect(minimumBudgetRefusal.message).toMatch(/too small to return a tool/u);
    expect(
      discoverPmTools([candidate("pm_context")], {
        outputBudget: requiredBudget,
      }).returned,
    ).toBe(1);
    expect(() => discoverPmTools([], { outputBudget: 128 })).toThrow(
      /at least .* estimated tokens are required for this page/u,
    );

    let rowBudgetRefusal: Error | undefined;
    for (let budget = 128; budget < 1_200; budget += 1) {
      try {
        discoverPmTools([candidate("pm_context")], { outputBudget: budget });
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          /too small to return a tool/u.test(error.message)
        ) {
          rowBudgetRefusal = error;
          break;
        }
      }
    }
    expect(rowBudgetRefusal?.message).toMatch(/increase it to at least/u);
  });

  it("stays deterministic and bounded at one hundred, one thousand, and ten thousand tools", () => {
    for (const size of [100, 1_000, 10_000]) {
      const candidates = Array.from({ length: size }, (_, index) =>
        candidate(
          `pm_catalog_${String(index).padStart(5, "0")}`,
          index === size - 1
            ? "Unique deploy release verification capability"
            : `Catalog capability ${index}`,
        ),
      );
      const first = discoverPmTools(candidates, {
        query: "unique deploy release verification",
        limit: 10,
        outputBudget: 1_200,
      });
      const second = discoverPmTools([...candidates].reverse(), {
        query: "unique deploy release verification",
        limit: 10,
        outputBudget: 1_200,
      });
      expect(first).toEqual(second);
      expect(first.tools[0]?.name).toBe(
        `pm_catalog_${String(size - 1).padStart(5, "0")}`,
      );
      expect(first.token_cost.within_budget).toBe(true);
    }
  });

  it("keeps exact bounded accounting linear across one hundred schema-bearing rows", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      ...candidate(`pm_schema_${String(index).padStart(3, "0")}`),
      inputSchema: {
        type: "object",
        description: "x".repeat(4_096),
        properties: { id: { type: "string" } },
      },
    }));
    const unbounded = discoverPmTools(candidates, {
      includeSchema: true,
      limit: 100,
      outputBudget: "unbounded",
    });
    const bounded = discoverPmTools(candidates, {
      includeSchema: true,
      limit: 100,
      outputBudget: unbounded.token_cost.estimated_tokens,
    });

    expect(bounded.returned).toBe(100);
    expect(
      Math.ceil(Buffer.byteLength(JSON.stringify(bounded), "utf8") / 4),
    ).toBe(bounded.token_cost.estimated_tokens);
  });

  it("fails closed on invalid limits and budgets", () => {
    const maximumUnicodeQuery = "🚀".repeat(4_096);
    expect(
      discoverPmTools([], {
        query: maximumUnicodeQuery,
        outputBudget: "unbounded",
      }).query,
    ).toBe(maximumUnicodeQuery);
    expect(() => discoverPmTools([], { limit: 0 })).toThrow(/limit/u);
    expect(() => discoverPmTools([], { outputBudget: 127 })).toThrow(
      /outputBudget/u,
    );
    expect(() => discoverPmTools([], { query: "x".repeat(4_097) })).toThrow(
      /query/u,
    );
    expect(() => discoverPmTools([], { query: "🚀".repeat(4_097) })).toThrow(
      /query/u,
    );
    expect(() => discoverPmTools([], { query: 42 as never })).toThrow(/query/u);
    expect(() => discoverPmTools([], { cursor: "x".repeat(4_097) })).toThrow(
      /cursor/u,
    );
    expect(() => discoverPmTools([], { cursor: 42 as never })).toThrow(
      /cursor/u,
    );
    expect(() => discoverPmTools([], { includeSchema: 1 as never })).toThrow(
      /includeSchema/u,
    );
    for (const [field, value] of [
      ["query", null],
      ["cursor", null],
      ["limit", null],
      ["outputBudget", null],
    ] as const) {
      expect(() => discoverPmTools([], { [field]: value } as never)).toThrow(
        new RegExp(field, "u"),
      );
    }
    for (const profile of ["invalid", 42, null]) {
      expect(() => discoverPmTools([], { profile: profile as never })).toThrow(
        /profile/u,
      );
    }
    expect(
      discoverPmTools([], {
        profile: "custom",
        outputBudget: "unbounded",
      }).profile,
    ).toBe("custom");
    for (const cursorIntegrityKey of [new Uint8Array(31), "not-bytes"]) {
      expect(() =>
        discoverPmTools([], {
          cursorIntegrityKey: cursorIntegrityKey as never,
        }),
      ).toThrow(/cursorIntegrityKey/u);
    }
  });

  it("rejects malformed public candidate catalogs with canonical usage errors", () => {
    const malformedCatalogs = [null, {}, "invalid", 42, false];
    const malformedRows = [
      null,
      [],
      "invalid",
      42,
      false,
      { description: "missing name", inputSchema: {} },
      { name: " ", description: "blank name", inputSchema: {} },
      { name: "pm_get", description: 42, inputSchema: {} },
      { name: "pm_get", description: "missing schema" },
      { name: "pm_get", description: "null schema", inputSchema: null },
      { name: "pm_get", description: "array schema", inputSchema: [] },
    ];
    for (const candidates of [
      ...malformedCatalogs,
      ...malformedRows.map((row) => [row]),
    ]) {
      let refusal: unknown;
      try {
        discoverPmTools(candidates as never, { outputBudget: "unbounded" });
      } catch (error: unknown) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(PmCliError);
      expect(refusal).toMatchObject({ exitCode: 64 });
    }
  });

  it("rejects malformed public options containers with a canonical usage error", () => {
    for (const options of [null, [], "invalid", 42, false]) {
      for (const invoke of [
        () => parsePmToolDiscoveryOptions(options as never),
        () => discoverPmTools([], options as never),
      ]) {
        let refusal: unknown;
        try {
          invoke();
        } catch (error: unknown) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(PmCliError);
        expect(refusal).toMatchObject({
          exitCode: 64,
          message: "pm tool discovery options must be an object.",
        });
      }
    }
    expect(() => parsePmToolDiscoveryOptions(undefined as never)).toThrow(
      /options must be an object/u,
    );
  });
});
