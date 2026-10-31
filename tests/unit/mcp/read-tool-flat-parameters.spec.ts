import { describe, expect, it } from "vitest";
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS } from "../../../src/sdk/cli-contracts/tool-schema.js";
import { optionsWithAuthor } from "../../../src/sdk/runtime-input.js";
import { runAction } from "../../../src/sdk/runtime.js";
import { createTestItemId } from "../../helpers/itemFactory.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const READ_ACTIONS = ["context", "get", "list", "next", "search"] as const;

describe("MCP read tools read every declared flat parameter (pm-hke9z7)", () => {
  it.each(READ_ACTIONS)("hoists every optional %s contract parameter from flat arguments", (action) => {
    const declared = PM_TOOL_ACTION_PARAMETER_CONTRACTS[action].optional ?? [];
    expect(declared.length).toBeGreaterThan(0);
    // Search's query and its keywords alias are operands read from the top-level arguments.
    const unread = declared.filter(
      (key) => key !== "query" && key !== "keywords" && !(key in optionsWithAuthor({ [key]: "flat" }, action)),
    );
    expect(unread).toEqual([]);
    expect(optionsWithAuthor({ query: "q", keywords: "k" }, action)).not.toHaveProperty("query");
  });

  it("lets nested options win over the same flat argument", () => {
    expect(optionsWithAuthor({ limit: 5, options: { limit: 2 } }, "context")).toMatchObject({ limit: 2 });
    expect(optionsWithAuthor({ for: "orient" }, "update")).not.toHaveProperty("for");
  });

  it("applies flat intent and limit arguments exactly like nested options", async () => {
    await withTempPmPath(async (context) => {
      const id = createTestItemId(context, { title: "Flat MCP argument" });
      const common = { path: context.pmPath, noExtensions: true };
      const read = async (action: string, flat: Record<string, unknown>) => {
        const [flatResult, nestedResult] = await Promise.all([
          runAction({ ...common, action, ...flat }),
          runAction({ ...common, action, options: flat }),
        ]);
        return [flatResult, nestedResult] as Array<Record<string, unknown>>;
      };
      for (const [action, args] of [
        ["context", { for: "orient", limit: 10 }],
        ["list", { for: "triage" }],
        ["next", { for: "execute" }],
      ] as const) {
        const [flat, nested] = await read(action, args);
        expect(flat.context_intent).toMatchObject({ intent: args.for });
        expect(flat.context_intent).toEqual(nested.context_intent);
      }
      const [flatContext] = await read("context", { for: "orient", limit: 10 });
      expect(flatContext).toMatchObject({ filters: { limit: "3", requested_limit: "10" } });
      const [flatGet, nestedGet] = await Promise.all([
        runAction({ ...common, action: "get", id, for: "inspect" }),
        runAction({ ...common, action: "get", id, options: { for: "inspect" } }),
      ]) as Array<Record<string, unknown>>;
      expect(flatGet.context_intent).toMatchObject({ intent: "inspect" });
      expect(flatGet.context_intent).toEqual(nestedGet.context_intent);
      const flatSearch = (await runAction({ ...common, action: "search", query: "Flat", for: "discover" })) as Record<string, unknown>;
      expect(flatSearch.context_intent).toMatchObject({ intent: "discover" });
      const aliased = (await runAction({ ...common, action: "search", keywords: "Flat" })) as { items: Array<{ id: string }> };
      expect(aliased.items.map((item) => item.id)).toContain(id);
      await expect(runAction({ ...common, action: "search" })).rejects.toThrow("Missing required argument: query");
    });
  });
});
