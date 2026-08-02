import { describe, expect, it, vi } from "vitest";
import { loadContextIntentSnapshotForInvocation } from "../../../src/cli/context-intent-invocation.js";
import { TOOLS } from "../../../src/mcp/tool-definitions.js";
import { pmToolActionParameterKeys } from "../../../src/sdk/cli-contracts/tool-schema.js";
import {
  actionGlobalOptions,
  optionsWithAuthor,
} from "../../../src/sdk/runtime-input.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const CANONICAL_KEYS = [
  "outputInclude",
  "outputLimit",
  "outputBudget",
  "outputFormat",
] as const;

describe("universal read-output transport contracts", () => {
  it("publishes canonical controls in strict SDK schemas", () => {
    for (const action of ["list", "context", "search", "get", "health"]) {
      expect(pmToolActionParameterKeys(action)).toEqual(
        expect.arrayContaining(CANONICAL_KEYS),
      );
    }
    expect(pmToolActionParameterKeys("create")).not.toEqual(
      expect.arrayContaining(CANONICAL_KEYS),
    );
  });

  it("publishes canonical controls on narrow MCP tools", () => {
    const listTool = TOOLS.find(({ name }) => name === "pm_list");
    const properties = listTool?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(CANONICAL_KEYS),
    );
  });

  it("hoists top-level MCP controls while preserving nested precedence", () => {
    expect(
      optionsWithAuthor({
        outputInclude: "id,title",
        outputLimit: 5,
        outputBudget: 600,
        outputFormat: "toon",
        options: { outputLimit: 3 },
      }),
    ).toMatchObject({
      outputInclude: "id,title",
      outputLimit: 3,
      outputBudget: 600,
      outputFormat: "toon",
    });
  });

  it("normalizes renderer-facing global controls", () => {
    expect(
      actionGlobalOptions({
        outputInclude: "id,title",
        outputLimit: 5,
        outputBudget: "600",
        outputFormat: "json",
      }),
    ).toMatchObject({
      outputInclude: "id,title",
      outputLimit: "5",
      outputBudget: "600",
      outputFormat: "json",
    });
  });

  it("loads active package declarations only for intent-aware runtime reads", async () => {
    await withTempPmPath(async (context) => {
      const loadSnapshot = vi.fn(async () => null);
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["contracts", "--full"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["list", "--for=triage"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["list"],
          context.pmPath,
          false,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      await expect(
        loadContextIntentSnapshotForInvocation(
          ["contracts", "--full"],
          context.pmPath,
          true,
          loadSnapshot,
        ),
      ).resolves.toBeNull();
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(loadSnapshot).toHaveBeenCalledWith(context.pmPath);
    });
  });
});
