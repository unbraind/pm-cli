import { describe, expect, it } from "vitest";
import { activateExtensions } from "../../../src/core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../../../src/core/extensions/extension-types.js";
import type { ExtensionActivationResult, ExtensionApi } from "../../../src/core/extensions/loader.js";

/**
 * Activate a single in-memory extension whose `activate` body is supplied by the
 * test, through the real activation engine, so `registerProfile` runs against the
 * production loader (validation, capability gate, normalization, and all).
 */
async function activateProfileExtension(
  activate: (api: ExtensionApi) => void,
  capabilities: string[] = ["schema"],
): Promise<ExtensionActivationResult> {
  return activateExtensions({
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: [
      {
        layer: "project",
        directory: "",
        manifest_path: "",
        name: "profile-ext",
        version: "0.0.0",
        entry: "./index.js",
        priority: 0,
        entry_path: "",
        capabilities,
        module: { activate },
      },
    ],
  });
}

describe("api.registerProfile", () => {
  it("registers a fully specified profile under the schema capability", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile({
        name: "kanban",
        title: "Kanban",
        summary: "Continuous flow.",
        types: [{ name: "Card" }],
        statuses: [{ id: "doing", roles: ["active"] }],
        fields: [{ key: "wip_limit", type: "number" }],
        workflows: [{ type: "Card", allowed_transitions: [["open", "doing"]] }],
        config: [{ key: "search_provider", value: "bm25", summary: "Offline search." }],
        templates: [{ name: "card", options: { type: "Card" } }],
        packages: [{ spec: "templates", reason: "Reusable templates." }],
      });
    });

    expect(activation.failed).toEqual([]);
    expect(activation.registration_counts.profiles).toBe(1);
    const [registered] = activation.registrations.profiles;
    expect(registered.name).toBe("profile-ext");
    expect(registered.profile.name).toBe("kanban");
    expect(registered.profile.types).toEqual([{ name: "Card" }]);
  });

  it("defaults a blank summary and omitted dimensions to an empty string and arrays", async () => {
    const activation = await activateProfileExtension((api) => {
      // A sparse archetype is a first-class typed call (only name + title are
      // required); the loader normalizes the omitted dimensions and summary so
      // the planner can iterate every dimension safely.
      api.registerProfile({ name: "sparse", title: "Sparse" });
    });

    expect(activation.failed).toEqual([]);
    const [registered] = activation.registrations.profiles;
    expect(registered.profile.summary).toBe("");
    expect(registered.profile.types).toEqual([]);
    expect(registered.profile.statuses).toEqual([]);
    expect(registered.profile.fields).toEqual([]);
    expect(registered.profile.workflows).toEqual([]);
    expect(registered.profile.config).toEqual([]);
    expect(registered.profile.templates).toEqual([]);
    expect(registered.profile.packages).toEqual([]);
  });

  it("snapshots the profile so later mutation of the author's object never leaks in", async () => {
    const live = {
      name: "mutating",
      title: "Mutating",
      summary: "Snapshot me.",
      types: [{ name: "Card" }],
      statuses: [],
      fields: [],
      workflows: [],
      config: [],
      templates: [],
      packages: [],
    };
    const activation = await activateProfileExtension((api) => {
      api.registerProfile(live);
      live.types.push({ name: "Mutated" });
    });

    const [registered] = activation.registrations.profiles;
    expect(registered.profile.types).toEqual([{ name: "Card" }]);
  });

  it("fails activation when the profile is not an object", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile(null as never);
    });
    expect(activation.registrations.profiles).toEqual([]);
    expect(activation.failed[0].error).toContain("registerProfile profile requires an object definition");
  });

  it("fails activation when the profile name is missing", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile({ title: "No name" } as never);
    });
    expect(activation.failed[0].error).toContain("registerProfile profile.name requires a non-empty string");
  });

  it("fails activation when the profile title is missing", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile({ name: "untitled" } as never);
    });
    expect(activation.failed[0].error).toContain("registerProfile profile.title requires a non-empty string");
  });

  it("fails activation when the profile summary is not a string", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile({ name: "x", title: "X", summary: 42 } as never);
    });
    expect(activation.failed[0].error).toContain("registerProfile profile.summary must be a string when provided");
  });

  it("fails activation when a profile dimension is not an array", async () => {
    const activation = await activateProfileExtension((api) => {
      api.registerProfile({ name: "x", title: "X", config: "nope" } as never);
    });
    expect(activation.failed[0].error).toContain("registerProfile profile.config must be an array when provided");
  });

  it("fails activation when a profile dimension contains a non-object entry", async () => {
    const activation = await activateProfileExtension((api) => {
      // A primitive/null entry survives an array-only check but crashes the
      // planner and `pm profile show` downstream, so it is rejected here.
      api.registerProfile({ name: "x", title: "X", statuses: [null] } as never);
    });
    expect(activation.registrations.profiles).toEqual([]);
    expect(activation.failed[0].error).toContain("registerProfile profile.statuses[0] must be an object");
  });

  it("fails activation when registerProfile is called without the schema capability", async () => {
    const activation = await activateProfileExtension(
      (api) => {
        api.registerProfile({ name: "x", title: "X" });
      },
      ["commands"],
    );
    expect(activation.registrations.profiles).toEqual([]);
    expect(activation.failed[0].error).toContain("schema");
  });
});
