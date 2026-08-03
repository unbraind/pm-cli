import { describe, expect, it } from "vitest";
import { resolveItemTypeRegistry } from "../../../src/core/item/type-registry.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  parseMultiValueFilter,
  parsePriorityFilterSet,
  parseStringFilterSet,
  parseTypeFilterSet,
} from "../../../src/sdk/query/multi-value-filters.js";
import { _testOnly as listInternals } from "../../../src/sdk/query/list.js";
import {
  buildCompactSearchFilterSummary,
  buildVerboseSearchFilters,
} from "../../../src/sdk/query/search-rendering.js";

describe("multi-value query filters", () => {
  it("decodes escaped commas and backslashes before stable de-duplication", () => {
    expect(
      parseMultiValueFilter(
        String.raw`alpha, customer\,success,windows\\path,alpha`,
        { label: "--tag", normalize: (value) => value.toLowerCase() },
      ),
    ).toEqual(["alpha", "customer,success", String.raw`windows\path`]);
    expect(parseMultiValueFilter(String.raw`literal\q`, { label: "--tag" })).toEqual([
      String.raw`literal\q`,
    ]);
  });

  it("rejects explicitly empty filters but preserves an omitted filter", () => {
    expect(parseMultiValueFilter(undefined, { label: "--release" })).toBeUndefined();
    expect(() => parseMultiValueFilter(" , ", { label: "--release" })).toThrow(
      new PmCliError(
        "--release requires at least one non-empty value",
        2,
      ),
    );
  });

  it("builds normalized string membership sets", () => {
    expect(
      parseStringFilterSet("Alpha, beta,ALPHA", {
        label: "--tag",
        normalize: (value) => value.toLowerCase(),
      }),
    ).toEqual(new Set(["alpha", "beta"]));
  });

  it("resolves every type token and reports the invalid token", () => {
    const registry = resolveItemTypeRegistry(SETTINGS_DEFAULTS);
    expect(parseTypeFilterSet("task,issue", registry)).toEqual(
      new Set(["Task", "Issue"]),
    );
    expect(() => parseTypeFilterSet("Task,NotAType", registry)).toThrow(
      /--type filter token "NotAType"/,
    );
  });

  it("validates every priority token independently", () => {
    expect(parsePriorityFilterSet("0,2,4,2")).toEqual(new Set([0, 2, 4]));
    expect(() => parsePriorityFilterSet("0,9")).toThrow(
      /--priority filter must be 0\.\.4/,
    );
  });

  it("keeps absent compact receipts empty and non-string statuses explicit", () => {
    expect(
      listInternals.buildCompactListFilterSummary({
        filtersStatus: null,
        options: {},
        treeEnabled: false,
        treeDepth: undefined,
        sortField: undefined,
        sortOrder: "asc",
        runtimeFieldFilters: {},
      }),
    ).not.toHaveProperty("status");
    expect(
      buildCompactSearchFilterSummary({
        mode: "keyword",
        matchMode: "or",
        options: { status: 1 as never },
        includeLinked: false,
        titleExact: false,
        phraseExact: false,
        scoreThreshold: 0,
        hybridSemanticWeight: 0.5,
      }),
    ).toMatchObject({ status: 1 });
    expect(
      buildVerboseSearchFilters({
        effectiveMode: "keyword",
        matchMode: "or",
        options: { status: 1 as never },
        includeLinked: false,
        titleExact: false,
        phraseExact: false,
        scoreThreshold: 0,
        hybridSemanticWeight: 0.5,
        queryExpansion: { enabled: false, provider: null },
        rerank: { enabled: false, model: "none", top_k: 0 },
        runtimeFieldFilters: {},
      }),
    ).toMatchObject({ status: 1 });
  });
});
