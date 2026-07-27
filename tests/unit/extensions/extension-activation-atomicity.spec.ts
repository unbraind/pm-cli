import { describe, expect, it } from "vitest";
import { activateExtensions } from "../../../src/core/extensions/loader.js";
import type {
  ExtensionApi,
  ExtensionLoadResult,
} from "../../../src/core/extensions/extension-types.js";

describe("extension activation atomicity", () => {
  it("rolls back every registration when a later declaration is rejected", async () => {
    const activate = (api: ExtensionApi): void => {
      api.registerCommand({
        name: "partial command",
        run: async () => ({ shouldNotRemain: true }),
      });
      api.registerCommand({
        name: "partial malformed",
        tier: "wide" as never,
        run: async () => ({ shouldNotRemain: true }),
      });
    };
    const loadResult: ExtensionLoadResult = {
      disabled_by_flag: false,
      roots: { global: "/tmp/global", project: "/tmp/project" },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      failed: [],
      loaded: [
        {
          layer: "project",
          directory: "atomic-extension",
          manifest_path: "/tmp/project/atomic-extension/manifest.json",
          name: "atomic-extension",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/atomic-extension/index.mjs",
          capabilities: ["commands"],
          module: { activate },
        },
      ],
    };

    const result = await activateExtensions(loadResult);

    expect(result.failed).toHaveLength(1);
    expect(result.commands.handlers).toEqual([]);
    expect(result.registrations.commands).toEqual([]);
    expect(result.registrations.flags).toEqual([]);
    expect(result.registration_counts.commands).toBe(0);
    expect(result.warnings).toContain(
      "extension_activation_rolled_back:project:atomic-extension",
    );
  });

  it("rolls back registrations when activate throws after registering", async () => {
    const loadResult: ExtensionLoadResult = {
      disabled_by_flag: false,
      roots: { global: "/tmp/global", project: "/tmp/project" },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      failed: [],
      loaded: [
        {
          layer: "project",
          directory: "throwing-extension",
          manifest_path: "/tmp/project/throwing-extension/manifest.json",
          name: "throwing-extension",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/throwing-extension/index.mjs",
          capabilities: ["commands"],
          module: {
            activate(api: ExtensionApi): void {
              api.registerCommand({
                name: "throwing command",
                run: async () => ({ shouldNotRemain: true }),
              });
              throw new Error("activation failed after registration");
            },
          },
        },
      ],
    };

    const result = await activateExtensions(loadResult);

    expect(result.failed[0]?.error).toContain(
      "activation failed after registration",
    );
    expect(result.commands.handlers).toEqual([]);
    expect(result.registrations.commands).toEqual([]);
    expect(result.warnings).toContain(
      "extension_activate_failed:project:throwing-extension",
    );
  });
});
