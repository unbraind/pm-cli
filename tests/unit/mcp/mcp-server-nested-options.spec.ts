import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/**
 * pm-upi0: nested `options` keys absent from the invoked action's contract are
 * silently dropped before dispatch, so the MCP server must surface the same
 * non-breaking warnings the pm-qxwu top-level detection produces.
 */
describe("mcp nested option-key validation (pm-upi0)", () => {
  it("flags mutation-shaped options on read tools without rejecting the call", async () => {
    const server = await import("../../../src/mcp/server.js");
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Nested options",
          "--description",
          "pm-upi0 fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "upi0-spec",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const response = (await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_deps",
          arguments: {
            id,
            path: context.pmPath,
            options: { dep: `id=${id},kind=related` },
          },
        },
      })) as {
        structuredContent: { result: unknown; warnings?: string[] };
        isError?: boolean;
      };
      // The call still succeeds — detection is warn-only — but the silent
      // no-op is now explicit in the envelope.
      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.result).toBeTruthy();
      expect(
        response.structuredContent.warnings!.some((warning) =>
          warning.includes('Unknown option "dep" for pm_deps action "deps"'),
        ),
      ).toBe(true);

      // pm_run resolves the action from its arguments and gets the same
      // nested-option validation for contract-described actions.
      const passthrough = (await server.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            action: "deps",
            id,
            path: context.pmPath,
            options: { dep: `id=${id},kind=related` },
          },
        },
      })) as { structuredContent: { warnings?: string[] } };
      expect(
        passthrough.structuredContent.warnings!.some((warning) =>
          warning.includes('Unknown option "dep" for pm_run action "deps"'),
        ),
      ).toBe(true);

      // A pm_run call without a string action has no resolvable contract; the
      // missing-action failure itself still comes from the runtime.
      await expect(
        server.handleRequest({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: { path: context.pmPath, options: { dep: "id=x" } },
          },
        }),
      ).rejects.toThrow(/action/);
    });
  });

  it("resolves contract keys per action and skips unknown or extension actions", async () => {
    const server = await import("../../../src/mcp/server.js");
    const detect = server._testOnly.detectUnexpectedOptionKeys;
    expect(
      detect("pm_deps", "deps", {
        options: { format: "tree", maxDepth: 2, json: true },
      }),
    ).toEqual([]);
    const suggested = detect("pm_deps", "deps", { options: { formt: "tree" } });
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toContain('did you mean "format"');
    const flagged = detect("pm_deps", "deps", { options: { dep: "id=x" } });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain("has no effect");
    // Mutation projection keys stay legal inside options for mutation actions.
    expect(
      detect("pm_update", "update", {
        options: {
          fullChangedFields: true,
          dep: "id=x,kind=related",
        },
      }),
    ).toEqual([]);
    expect(detect("pm_deps", "deps", {})).toEqual([]);
    expect(detect("pm_deps", "deps", { options: null })).toEqual([]);
    expect(detect("pm_deps", "deps", { options: ["x"] })).toEqual([]);
    expect(detect("pm_run", undefined, { options: { anything: 1 } })).toEqual(
      [],
    );
    // Extension- and package-owned actions have no contract table entry and
    // keep arbitrary passthrough options.
    expect(
      detect("pm_run", "custom-extension-action", {
        options: { anything: 1 },
      }),
    ).toEqual([]);
  });
});
