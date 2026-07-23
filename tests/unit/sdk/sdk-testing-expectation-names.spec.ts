import { describe, expect, it } from "vitest";
import {
  activateExtensionForTest,
  assertRegisteredCommandContract,
  assertRegisteredFlags,
  assertRegisteredItemField,
  assertRegisteredItemType,
  assertRegisteredRendererOverride,
  assertRegisteredSearchProvider,
  type RegisteredRendererOverrideExpectation,
} from "../../../src/sdk/testing.js";

describe("SDK registration expectation names", () => {
  it("uses name consistently while preserving every legacy selector alias", async () => {
    const activation = await activateExtensionForTest(
      {
        activate(api) {
          api.registerCommand({
            name: "demo run",
            run: () => ({ ok: true }),
          });
          api.registerFlags("demo run", [
            { long: "--limit", value_type: "number" },
          ]);
          api.registerItemFields([
            { name: "demo_priority", type: "number", optional: true },
          ]);
          api.registerItemTypes([
            { name: "Demo", folder: "demos", aliases: ["demo"] },
          ]);
          api.registerSearchProvider({
            name: "demo-search",
            query: () => [],
          });
        },
      },
      {
        name: "expectation-names",
        capabilities: ["commands", "schema", "search"],
      },
    );

    expect(
      assertRegisteredCommandContract(activation.registrations, {
        name: "demo run",
      }).command.command,
    ).toBe("demo run");
    expect(
      assertRegisteredFlags(activation.registrations, {
        name: "demo run",
        flags: ["--limit"],
      }).target_command,
    ).toBe("demo run");
    expect(
      assertRegisteredItemField(activation.registrations, {
        name: "demo_priority",
      }).field.name,
    ).toBe("demo_priority");
    expect(
      assertRegisteredItemType(activation.registrations, {
        name: "Demo",
      }).itemType.name,
    ).toBe("Demo");
    expect(
      assertRegisteredSearchProvider(activation.registrations, {
        name: "demo-search",
      }).definition.name,
    ).toBe("demo-search");

    expect(
      assertRegisteredCommandContract(activation.registrations, {
        command: "demo run",
      }).command.command,
    ).toBe("demo run");
    expect(
      assertRegisteredFlags(activation.registrations, {
        targetCommand: "demo run",
      }).target_command,
    ).toBe("demo run");
    expect(
      assertRegisteredItemField(activation.registrations, {
        field: "demo_priority",
      }).field.name,
    ).toBe("demo_priority");
    expect(
      assertRegisteredItemType(activation.registrations, {
        itemType: "Demo",
      }).itemType.name,
    ).toBe("Demo");
    expect(
      assertRegisteredSearchProvider(activation.registrations, {
        provider: "demo-search",
      }).definition.name,
    ).toBe("demo-search");
  });

  it("rejects a runtime payload that omits both canonical and legacy names", () => {
    expect(() =>
      assertRegisteredRendererOverride(
        { overrides: [] },
        {} as RegisteredRendererOverrideExpectation,
      ),
    ).toThrow(/must be a non-empty string/);
  });
});
