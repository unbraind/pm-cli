import { afterEach, expect, it } from "vitest";
import {
  clearActiveExtensionHooks, isActiveCommandUnextended, runWithIsolatedExtensionRuntime,
  setActiveCommandContext, setActiveExtensionCommands, setActiveExtensionHooks,
  setActiveExtensionParsers, setActiveExtensionPreflight, setActiveExtensionRegistrations,
  setActiveExtensionRenderers, setActiveExtensionServices,
  createEmptyExtensionHookRegistry, createEmptyExtensionRegistrationRegistry,
} from "../../../../src/core/extensions/index.js";

afterEach(clearActiveExtensionHooks);

it.each([false, true])("proves ownership within the correct runtime scope (isolated=%s)", async (isolated) => {
  const verify = async () => {
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveCommandContext({ command: "list", args: [], options: {} });
    expect(isActiveCommandUnextended("list")).toBe(true);
    expect(isActiveCommandUnextended("get")).toBe(false);
    setActiveExtensionHooks(createEmptyExtensionHookRegistry());
    setActiveExtensionCommands({ handlers: [], overrides: [] });
    setActiveExtensionParsers({ overrides: [] });
    setActiveExtensionPreflight({ overrides: [] });
    setActiveExtensionServices({ overrides: [] });
    setActiveExtensionRenderers({ overrides: [] });
    setActiveExtensionRegistrations(createEmptyExtensionRegistrationRegistry());
    expect(isActiveCommandUnextended("list")).toBe(true);
    setActiveExtensionCommands({ handlers: [{ command: "custom", layer: "project", name: "fixture", run: () => null }], overrides: [] });
    expect(isActiveCommandUnextended("list")).toBe(true);
    setActiveExtensionCommands({ handlers: [{ command: "list", layer: "project", name: "fixture", run: () => null }], overrides: [] });
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionCommands(null);
    const hooks = createEmptyExtensionHookRegistry();
    hooks.onRead.push({ layer: "project", name: "fixture", run: () => undefined });
    setActiveExtensionHooks(hooks);
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionHooks(null);
    setActiveExtensionParsers({ overrides: [{ command: "list", layer: "project", name: "fixture", run: () => ({}) }] });
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionParsers(null);
    setActiveExtensionPreflight({ overrides: [{ layer: "project", name: "fixture", run: () => ({}) }] });
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionPreflight(null);
    setActiveExtensionServices({ overrides: [{ layer: "project", name: "fixture", service: "context_relevance", run: () => null }] });
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionServices(null);
    setActiveExtensionRenderers({ overrides: [{ layer: "project", name: "fixture", format: "json", run: () => null }] });
    expect(isActiveCommandUnextended("list")).toBe(false);
    setActiveExtensionRenderers(null);
    const registrations = createEmptyExtensionRegistrationRegistry();
    registrations.migrations.push({ layer: "project", name: "fixture", definition: { id: "fixture", status: "pending" }, runtime_definition: { id: "fixture", status: "pending" } });
    setActiveExtensionRegistrations(registrations);
    expect(isActiveCommandUnextended("list")).toBe(false);
  };
  if (isolated) await runWithIsolatedExtensionRuntime(verify);
  else await verify();
});
