import { describe, expect, it } from "vitest";
import { recordAfterCommandContextUsage } from "../../../src/cli/after-command-context-usage.js";
import { appendCommanderExtensionFailures } from "../../../src/cli/commander-usage.js";
import {
  loadExtensionRecoveryFailures,
  loadUnknownCommandRecoveryFailures,
} from "../../../src/cli/extension-recovery.js";

describe("CLI recovery and derived usage helpers", () => {
  it("skips derived context usage before any filesystem access when disabled", async () => {
    const previous = process.env.PM_CONTEXT_USAGE_DISABLED;
    process.env.PM_CONTEXT_USAGE_DISABLED = "1";
    try {
      await expect(
        recordAfterCommandContextUsage({
          pmRoot: "/missing/tracker",
          itemIds: ["pm-a"],
          intent: "update",
        }),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PM_CONTEXT_USAGE_DISABLED;
      else process.env.PM_CONTEXT_USAGE_DISABLED = previous;
    }
  });

  it("appends bounded extension failures to JSON and text usage", () => {
    const failures = [
      { layer: "project", name: "broken", error: "activation failed" },
    ];
    expect(
      appendCommanderExtensionFailures('{"error":"unknown"}', true, failures),
    ).toContain('"failed_extensions"');
    expect(
      appendCommanderExtensionFailures("Unknown command", false, failures),
    ).toContain("- project:broken: activation failed");
    expect(appendCommanderExtensionFailures("usage", false, [])).toBe("usage");
  });

  it("contains Error and non-Error extension recovery failures", async () => {
    const successful = await loadExtensionRecoveryFailures("/tracker", {
      readSettings: async () => ({}) as never,
      loadExtensions: async () =>
        ({
          failed: [
            { layer: "project", name: "load-failure", error: "load failed" },
          ],
        }) as never,
      activateExtensions: async () =>
        ({
          failed: [
            {
              layer: "global",
              name: "activation-failure",
              error: "activation failed",
            },
          ],
        }) as never,
    });
    expect(successful).toEqual([
      { layer: "project", name: "load-failure", error: "load failed" },
      {
        layer: "global",
        name: "activation-failure",
        error: "activation failed",
      },
    ]);
    const errorResult = await loadExtensionRecoveryFailures("/missing", {
      readSettings: async () => {
        throw new Error("settings unavailable");
      },
    });
    expect(errorResult).toEqual([
      {
        layer: "runtime",
        name: "extension-loader",
        error: "settings unavailable",
      },
    ]);
    const stringResult = await loadUnknownCommandRecoveryFailures(
      "unknown_command",
      "/missing",
      {
        readSettings: () => Promise.reject("non-error failure"),
      },
    );
    expect(stringResult[0]?.error).toBe("non-error failure");
    await expect(
      loadUnknownCommandRecoveryFailures("invalid_option", "/missing"),
    ).resolves.toEqual([]);
  });

  it("explains storage and extension-discovery relocation for unknown commands", async () => {
    const result = await loadUnknownCommandRecoveryFailures(
      "unknown_command",
      "/scratch/.agents/pm",
      {
        resolveImplicitPmRoot: () => "/workspace/.agents/pm",
        readSettings: async () => ({}) as never,
        loadExtensions: async ({ pmRoot }) =>
          ({
            roots: { project: `${pmRoot}/extensions`, global: "/global" },
            loaded:
              pmRoot === "/workspace/.agents/pm"
                ? [
                    {},
                    {
                      activation: {
                        commands: ["changelog generate", "changelog export"],
                      },
                    },
                  ]
                : [{}],
            failed: [],
          }) as never,
        activateExtensions: async () => ({ failed: [] }) as never,
      },
    );

    expect(result).toContainEqual({
      layer: "runtime",
      name: "extension-root-relocation",
      error: expect.stringContaining(
        "storage_root=/scratch/.agents/pm extension_discovery_root=/scratch/.agents/pm/extensions",
      ),
    });
    expect(result.at(-1)?.error).toContain(
      "cwd_extension_discovery_root=/workspace/.agents/pm/extensions",
    );
    expect(result.at(-1)?.error).toContain(
      "--pm-path selects extension discovery as well as item storage",
    );
    expect(result.at(-1)?.error).toContain(
      "pm --pm-path /scratch/.agents/pm install <package> --project",
    );
  });

  it("bounds relocation comparison across same-root, same-command, and large-command surfaces", async () => {
    const base = {
      readSettings: async () => ({}) as never,
      activateExtensions: async () => ({ failed: [] }) as never,
    };
    const sameRoot = await loadUnknownCommandRecoveryFailures(
      "unknown_command",
      "/same/.agents/pm",
      {
        ...base,
        resolveImplicitPmRoot: () => "/same/.agents/pm",
        loadExtensions: async () =>
          ({
            roots: { project: "/same/.agents/pm/extensions" },
            loaded: [],
            failed: [],
          }) as never,
      },
    );
    expect(sameRoot).toEqual([]);

    const compare = (workspaceCommands: string[], selectedCommands: string[]) =>
      loadUnknownCommandRecoveryFailures(
        "unknown_command",
        "/selected/.agents/pm",
        {
          ...base,
          resolveImplicitPmRoot: () => "/workspace/.agents/pm",
          loadExtensions: async ({ pmRoot }) =>
            ({
              roots: { project: `${pmRoot}/extensions` },
              loaded: [
                {
                  activation: {
                    commands:
                      pmRoot === "/workspace/.agents/pm"
                        ? workspaceCommands
                        : selectedCommands,
                  },
                },
              ],
              failed: [],
            }) as never,
        },
      );
    await expect(compare(["shared"], ["shared"])).resolves.toEqual([]);
    const many = await compare(
      [
        "shared",
        ...Array.from({ length: 9 }, (_, index) => `command-${index}`),
      ],
      ["shared"],
    );
    expect(many.at(-1)?.error).toContain("missing 9 workspace command path(s)");
    expect(many.at(-1)?.error).toContain(", ...");
  });
});
