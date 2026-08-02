import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getActiveContextIntentContracts,
  resolveContextIntentContract,
  runWithContextIntentContracts,
} from "../../../src/sdk/context-intent-contracts.js";
import {
  collectPackageContextIntentContracts,
  loadContextIntentRuntimeLayers,
  parseContextIntentDeclarations,
  readWorkspaceContextIntentContracts,
  runWithDiscoveredContextIntentContracts,
} from "../../../src/sdk/context-intent-runtime.js";

describe("runtime context intent contracts", () => {
  it("composes package and workspace declarations for one async execution scope", async () => {
    const outside = getActiveContextIntentContracts();
    await runWithContextIntentContracts(
      {
        packageContracts: [
          {
            command: "package-report",
            intent: "release",
            description: "Package release evidence.",
            included_field_groups: ["changes", "gates"],
            token_budget: 900,
          },
        ],
        workspaceContracts: [
          {
            command: "next",
            intent: "execute",
            description: "Workspace execution view.",
            included_field_groups: ["recommended", "blocked"],
            token_budget: 1_500,
          },
        ],
      },
      async () => {
        await Promise.resolve();
        expect(
          resolveContextIntentContract("package-report", "release"),
        ).toMatchObject({ source: "package" });
        expect(resolveContextIntentContract("next", "execute")).toMatchObject({
          source: "workspace",
          token_budget: 1_500,
        });
      },
    );
    expect(getActiveContextIntentContracts()).toEqual(outside);
  });

  it("isolates concurrent workspaces", async () => {
    const descriptions = await Promise.all(
      ["Alpha view", "Beta view"].map((description) =>
        runWithContextIntentContracts(
          {
            workspaceContracts: [
              {
                command: "next",
                intent: "execute",
                description,
                included_field_groups: ["recommended"],
                token_budget: 1_200,
              },
            ],
          },
          async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return resolveContextIntentContract("next", "execute")!.description;
          },
        ),
      ),
    );
    expect(descriptions).toEqual(["Alpha view", "Beta view"]);
  });

  it("loads workspace configuration and package exports with workspace precedence", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-context-intents-"));
    try {
      await writeFile(
        path.join(pmRoot, "context-intents.json"),
        JSON.stringify({
          intents: [
            {
              command: "search",
              intent: "domain-discovery",
              description: "Workspace domain discovery.",
              included_field_groups: ["identity", "domain"],
              token_budget: 700,
            },
          ],
        }),
      );
      const packages = [
        {
          name: "domain-package",
          module: {
            contextIntents: [
              {
                command: "search",
                intent: "domain-discovery",
                description: "Package domain discovery.",
                included_field_groups: ["identity"],
                token_budget: 600,
              },
              {
                command: "package-report",
                intent: "release",
                description: "Package release report.",
                included_field_groups: ["evidence"],
                token_budget: 500,
              },
            ],
          },
        },
      ];

      expect(collectPackageContextIntentContracts(packages)).toHaveLength(2);
      await runWithDiscoveredContextIntentContracts(
        { pmRoot, packages },
        async () => {
          expect(
            resolveContextIntentContract("search", "domain-discovery"),
          ).toMatchObject({
            source: "workspace",
            description: "Workspace domain discovery.",
          });
          expect(
            resolveContextIntentContract("package-report", "release"),
          ).toMatchObject({ source: "package" });
        },
      );
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed package declarations before entering a request scope", () => {
    expect(() =>
      collectPackageContextIntentContracts([
        { name: "broken", module: { context_intents: [{ intent: "x" }] } },
      ]),
    ).toThrow("package broken context intent at index 0");
  });

  it("accepts array and default exports while ignoring packages without declarations", () => {
    const declaration = {
      command: "package-report",
      intent: "release",
      description: "Package release report.",
      included_field_groups: ["evidence"],
      token_budget: 500,
    };
    expect(parseContextIntentDeclarations([declaration], "inline")).toEqual([
      declaration,
    ]);
    expect(
      collectPackageContextIntentContracts([
        { name: "empty", module: null },
        { name: "plain", module: {} },
        {
          name: "default-export",
          module: { default: { context_intents: [declaration] } },
        },
      ]),
    ).toEqual([declaration]);
  });

  it("fails closed for invalid containers, entries, JSON, and filesystem reads", async () => {
    expect(() => parseContextIntentDeclarations({}, "invalid")).toThrow(
      "must be an array or an object with an intents array",
    );
    expect(() => parseContextIntentDeclarations([null], "invalid")).toThrow(
      "must be an object",
    );

    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-context-errors-"));
    try {
      expect(await readWorkspaceContextIntentContracts(pmRoot)).toEqual([]);
      expect(await loadContextIntentRuntimeLayers({ pmRoot })).toEqual({
        workspaceContracts: [],
        packageContracts: [],
      });

      const declarationPath = path.join(pmRoot, "context-intents.json");
      await writeFile(declarationPath, "not-json");
      await expect(readWorkspaceContextIntentContracts(pmRoot)).rejects.toThrow(
        "Invalid context-intents.json",
      );

      const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "non-error parse failure";
      });
      await expect(readWorkspaceContextIntentContracts(pmRoot)).rejects.toThrow(
        "non-error parse failure",
      );
      parse.mockRestore();

      await rm(declarationPath);
      await mkdir(declarationPath);
      await expect(
        readWorkspaceContextIntentContracts(pmRoot),
      ).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
