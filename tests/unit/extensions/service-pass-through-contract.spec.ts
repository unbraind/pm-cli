import { describe, expect, it } from "vitest";
import {
  runServiceOverride,
  runServiceOverrideSync,
} from "../../../src/core/extensions/extension-hook-runtime.js";
import type { ExtensionServiceRegistry } from "../../../src/core/extensions/extension-types.js";
import { activateExtensionForTest } from "../../../src/sdk/testing.js";

const context = {
  service: "output_format" as const,
  command: "list",
  pm_root: "/tmp/project",
  payload: { items: ["pm-one"] },
};

describe("service pass-through ownership", () => {
  it("accepts an explicit decline without changing native output", async () => {
    const services: ExtensionServiceRegistry = {
      overrides: [
        {
          layer: "project",
          name: "safe-decline",
          service: "output_format",
          passThrough: true,
          run: () => ({ handled: false }),
        },
      ],
    };

    expect(runServiceOverrideSync(services, context)).toEqual({
      handled: false,
      result: context.payload,
      warnings: [],
    });
    await expect(runServiceOverride(services, context)).resolves.toEqual({
      handled: false,
      result: context.payload,
      warnings: [],
    });
  });

  it("ignores a handled result that violates declared pass-through ownership", async () => {
    const services: ExtensionServiceRegistry = {
      overrides: [
        {
          layer: "project",
          name: "unsafe-declaration",
          service: "output_format",
          passThrough: true,
          run: () => ({ handled: true, result: "intercepted" }),
        },
      ],
    };
    const warning =
      "extension_service_pass_through_contract_violated:project:unsafe-declaration:output_format";

    expect(runServiceOverrideSync(services, context)).toEqual({
      handled: false,
      result: context.payload,
      warnings: [warning],
    });
    await expect(runServiceOverride(services, context)).resolves.toEqual({
      handled: false,
      result: context.payload,
      warnings: [warning],
    });
  });

  it("continues to allow an undeclared interceptor", () => {
    const services: ExtensionServiceRegistry = {
      overrides: [
        {
          layer: "project",
          name: "global-interceptor",
          service: "output_format",
          run: () => ({ handled: true, result: "intercepted" }),
        },
      ],
    };

    expect(runServiceOverrideSync(services, context)).toEqual({
      handled: true,
      result: "intercepted",
      warnings: [],
    });
  });

  it.each([
    [null, "ownership must be an object"],
    [{ interceptor: false }, "ownership supports only passThrough"],
    [{ passThrough: "yes" }, "ownership.passThrough must be a boolean"],
  ])("rejects invalid ownership metadata %#", async (ownership, message) => {
    const activation = await activateExtensionForTest(
      {
        activate(api: {
          registerService: (...args: unknown[]) => void;
        }) {
          api.registerService(
            "output_format",
            () => ({ handled: false }),
            ownership,
          );
        },
      },
      { capabilities: ["services"] },
    );

    expect(activation.failed).toHaveLength(1);
    expect(activation.failed[0]?.error).toContain(message);
  });
});
