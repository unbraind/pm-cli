import { describe, expect, it } from "vitest";
import { assertExtensionDeactivated, createExtensionTestHarness } from "../../../src/sdk/testing.js";
import { listProfiles, planProfileApplication, type ProfileCurrentState } from "../../../src/sdk/index.js";
import kanbanExtension, {
  KANBAN_ITEM_FIELDS,
  KANBAN_ITEM_TYPE,
  activate,
  deactivate,
  kanbanProfile,
  manifest,
} from "../../../packages/pm-kanban/extensions/kanban/index.ts";

/** An empty tracker snapshot so the planner reports every dimension as a fresh add. */
function emptyState(): ProfileCurrentState {
  return {
    typesRaw: null,
    statusesRaw: null,
    fieldsRaw: null,
    workflows: [],
    settings: {},
    templates: new Map(),
    installedPackages: new Set(),
  };
}

describe("pm-kanban archetype package", () => {
  it("exposes a schema-capability manifest with no command-gated activation", () => {
    expect(manifest.name).toBe("builtin-kanban-profile");
    expect(manifest.capabilities).toEqual(["schema"]);
    // Schema item types are GLOBAL: gating activation to named commands would hide
    // the Card type from `pm create`, so the manifest must omit activation.commands.
    expect("activation" in manifest).toBe(false);
    expect(kanbanExtension.manifest).toBe(manifest);
    expect(kanbanExtension.activate).toBe(activate);
    expect(kanbanExtension.deactivate).toBe(deactivate);
  });

  it("registers the Card item type and flow fields, then deactivates cleanly", async () => {
    const ext = await createExtensionTestHarness(kanbanExtension, { capabilities: ["schema"] });

    const cardType = ext.assertItemType({ itemType: "Card" });
    expect(cardType.itemType.name).toBe("Card");

    for (const field of KANBAN_ITEM_FIELDS) {
      expect(ext.assertItemField({ field: field.name }).field.name).toBe(field.name);
    }

    assertExtensionDeactivated(await ext.deactivate());
  });

  it("keeps the live registration surfaces in lockstep with the profile spec", () => {
    // The registration definitions and the profile describe the same archetype, so
    // their type name and field identifiers must never drift apart.
    expect(KANBAN_ITEM_TYPE.name).toBe(kanbanProfile.types[0].name);
    expect(KANBAN_ITEM_FIELDS.map((field) => field.name)).toEqual(kanbanProfile.fields.map((field) => field.key));
  });

  it("ships a profile the SDK planner can stage without touching core profiles", () => {
    // The Kanban archetype is package-provided: it must NOT appear among the
    // core-baked profiles, proving the package extends the archetype set without
    // modifying core.
    expect(listProfiles().map((profile) => profile.name)).not.toContain("kanban");

    const plan = planProfileApplication(kanbanProfile, emptyState());
    expect(plan.profile.name).toBe("kanban");
    expect(plan.changed).toBe(true);
    expect(plan.types.changes).toContainEqual({ key: "Card", status: "add" });
    expect(plan.fields.changes.map((change) => change.status)).toEqual(["add", "add", "add"]);
    expect(plan.statuses.changes.map((change) => change.key)).toEqual(["doing", "verifying"]);
    expect(plan.workflows.changes).toContainEqual({ type: "Card", status: "add" });
    expect(plan.config.changes.map((change) => change.key)).toEqual(["search_provider", "search_max_results"]);
    expect(plan.templates.changes.map((change) => change.name)).toEqual(["card"]);
    // No packages are installed in the empty snapshot, so every recommendation is advisory.
    expect(plan.packages.every((pkg) => pkg.status === "recommended")).toBe(true);
  });

  it("re-applying the staged profile is idempotent", () => {
    const plan = planProfileApplication(kanbanProfile, emptyState());
    const reapplied = planProfileApplication(kanbanProfile, {
      ...emptyState(),
      typesRaw: JSON.stringify(plan.types.file),
      statusesRaw: JSON.stringify(plan.statuses.file),
      fieldsRaw: JSON.stringify(plan.fields.file),
      workflows: plan.workflows.result,
      templates: new Map(plan.templates.changes.map((change) => [change.name, change.options])),
    });
    expect(reapplied.types.changed).toBe(false);
    expect(reapplied.statuses.changed).toBe(false);
    expect(reapplied.fields.changed).toBe(false);
    expect(reapplied.workflows.changed).toBe(false);
    expect(reapplied.templates.changed).toBe(false);
  });
});
