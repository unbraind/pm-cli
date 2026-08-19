import { describe, expect, it } from "vitest";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { _testOnly as listInternals } from "../../../../src/sdk/query/list.js";
import { parseSearchProjection } from "../../../../src/sdk/query/search-contracts.js";

describe("query projection recovery contracts", () => {
  it("canonicalizes and deduplicates list item aliases before projection", () => {
    const projection = listInternals.parseProjectionConfig({
      fields: "item.id,id,item.title,title",
    });
    expect(projection).toEqual({ mode: "fields", fields: ["id", "title"] });
    expect(
      listInternals.projectListItems(
        [{ id: "pm-one", title: "One" }] as never,
        projection,
      ),
    ).toEqual([{ id: "pm-one", title: "One" }]);
  });

  it("preserves the exact search operand in mutual-exclusion recovery", () => {
    const query = "auth status:open with spaces";
    expect(() =>
      parseSearchProjection({ full: true, fields: "id" }, query),
    ).toThrowError(PmCliError);
    try {
      parseSearchProjection({ full: true, fields: "id" }, query);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).context.recovery).toEqual({
        suggested_retry: 'pm search "auth status:open with spaces" --full',
        suggested_retry_args: ["search", query, "--full"],
      });
    }
  });
});
