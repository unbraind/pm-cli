import { describe, expect, it } from "vitest";
import {
  composeExtension,
  describeExtensionBlueprint,
} from "../../../src/sdk/compose.js";
import { defineRendererOverride } from "../../../src/sdk/define.js";
import { _testOnly as extensionTestOnly } from "../../../src/sdk/extension.js";
import {
  activateExtensionForTest,
  runRegisteredRendererOverrideForTest,
} from "../../../src/sdk/testing.js";

describe("SDK renderer ownership", () => {
  it("enforces declarative command ownership before invoking a renderer", async () => {
    const scopedRenderer = defineRendererOverride({
      commands: ["owned render"],
      run: (context) => `owned:${JSON.stringify(context.result)}`,
    });
    const activation = await activateExtensionForTest(
      composeExtension({
        renderers: { toon: scopedRenderer },
      }),
      { name: "scoped-renderer", capabilities: ["renderers"] },
    );

    expect(activation.renderers.overrides[0]).toMatchObject({
      format: "toon",
      commands: ["owned render"],
    });
    await expect(
      runRegisteredRendererOverrideForTest(activation.renderers, {
        format: "toon",
        command: "owned render",
        result: { ok: true },
      }),
    ).resolves.toMatchObject({
      overridden: true,
      rendered: 'owned:{"ok":true}',
    });
    await expect(
      runRegisteredRendererOverrideForTest(activation.renderers, {
        format: "toon",
        command: "unrelated",
        result: { ok: true },
      }),
    ).resolves.toMatchObject({ overridden: false, rendered: null });
    expect(
      extensionTestOnly.collectGlobalOutputOverrideDoctorWarnings(activation),
    ).toEqual([]);
  });

  it("supports a host-enforced result discriminator and retains unscoped warnings", async () => {
    const scoped = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRenderer(
            "json",
            () => '{"owned":true}',
            {
              resultDiscriminator: (result) =>
                typeof result === "object" &&
                result !== null &&
                "owned" in result,
            },
          );
        },
      },
      { name: "result-renderer", capabilities: ["renderers"] },
    );
    await expect(
      runRegisteredRendererOverrideForTest(scoped.renderers, {
        format: "json",
        result: { owned: true },
      }),
    ).resolves.toMatchObject({ overridden: true });
    await expect(
      runRegisteredRendererOverrideForTest(scoped.renderers, {
        format: "json",
        result: { other: true },
      }),
    ).resolves.toMatchObject({ overridden: false });
    const throwing = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRenderer("json", () => "{}", {
            resultDiscriminator: () => {
              throw new Error("extension predicate failed");
            },
          });
        },
      },
      { name: "throwing-renderer", capabilities: ["renderers"] },
    );
    await expect(
      runRegisteredRendererOverrideForTest(throwing.renderers, {
        format: "json",
        result: { owned: true },
      }),
    ).resolves.toMatchObject({ overridden: false });
    expect(
      extensionTestOnly.collectGlobalOutputOverrideDoctorWarnings(scoped),
    ).toEqual([]);

    const unscoped = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRenderer("json", () => "{}");
        },
      },
      { name: "global-renderer", capabilities: ["renderers"] },
    );
    expect(
      extensionTestOnly.collectGlobalOutputOverrideDoctorWarnings(unscoped),
    ).toEqual([
      "extension_output_renderer_override_global:json:project:global-renderer",
    ]);
  });

  it("supports legacy composed renderers and deterministically describes multiple scoped owners", async () => {
    const legacy = await activateExtensionForTest(
      composeExtension({ renderers: { toon: () => "legacy" } }),
      { name: "legacy-renderer", capabilities: ["renderers"] },
    );
    expect(legacy.renderers.overrides[0]?.commands).toEqual([]);

    const blueprint = {
      renderers: {
        toon: {
          commands: ["zeta render"],
          run: () => "toon",
        },
        json: {
          resultDiscriminator: () => true,
          run: () => "json",
        },
      },
    };
    expect(describeExtensionBlueprint(blueprint).renderer_ownership).toEqual([
      {
        format: "json",
        commands: [],
        result_discriminator: true,
      },
      {
        format: "toon",
        commands: ["zeta render"],
        result_discriminator: false,
      },
    ]);
    const activation = await activateExtensionForTest(
      composeExtension(blueprint),
      { name: "multiple-renderers", capabilities: ["renderers"] },
    );
    expect(activation.failed).toEqual([]);
  });

  it("reports malformed renderer ownership without registering a partial override", async () => {
    const invalidDiscriminator = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRenderer("json", () => "{}", {
            resultDiscriminator: true as unknown as (result: unknown) => boolean,
          });
        },
      },
      { name: "invalid-discriminator", capabilities: ["renderers"] },
    );
    expect(invalidDiscriminator.failed[0]?.error).toMatch(
      /resultDiscriminator must be a function/,
    );
    expect(invalidDiscriminator.renderers.overrides).toEqual([]);

    const invalidCommands = await activateExtensionForTest(
      {
        activate(api) {
          api.registerRenderer("json", () => "{}", {
            commands: [42] as unknown as string[],
          });
        },
      },
      { name: "invalid-commands", capabilities: ["renderers"] },
    );
    expect(invalidCommands.failed[0]?.error).toMatch(
      /commands must contain non-empty command paths/,
    );
    expect(invalidCommands.renderers.overrides).toEqual([]);
  });
});
