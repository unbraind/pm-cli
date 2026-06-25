import { describe, expect, it } from "vitest";
import { planProfileApplication, type ProfileCurrentState } from "../../../../src/core/profile/profile-plan.js";
import type { ProjectProfileDefinition } from "../../../../src/core/profile/profile-presets.js";
import {
  normalizeAddTypeInput,
  parseItemTypesFile,
  serializeItemTypesFile,
  upsertItemType,
} from "../../../../src/core/schema/item-types-file.js";
import {
  normalizeAddStatusInput,
  parseStatusDefsFile,
  serializeStatusDefsFile,
  upsertStatusDef,
} from "../../../../src/core/schema/status-defs-file.js";
import {
  normalizeAddFieldInput,
  parseFieldsFile,
  serializeFieldsFile,
  upsertField,
} from "../../../../src/core/schema/fields-file.js";

const PROFILE: ProjectProfileDefinition = {
  name: "test",
  title: "Test",
  summary: "Synthetic test profile",
  types: [{ name: "Widget", description: "A widget", defaultStatus: "open", folder: "widgets", aliases: [] }],
  statuses: [{ id: "verifying", roles: ["active"] }],
  fields: [{ key: "widget_size", type: "number" }],
  workflows: [{ type: "Widget", allowed_transitions: [["open", "in_progress"]] }],
  config: [{ key: "search_max_results", value: "30", summary: "cap" }],
  templates: [{ name: "widget", options: { type: "Widget", priority: "2" } }],
  packages: [{ spec: "templates", reason: "reuse" }],
};

function emptyState(overrides: Partial<ProfileCurrentState> = {}): ProfileCurrentState {
  return {
    typesRaw: null,
    statusesRaw: null,
    fieldsRaw: null,
    workflows: [],
    settings: {},
    templates: new Map(),
    installedPackages: new Set<string>(),
    ...overrides,
  };
}

describe("planProfileApplication", () => {
  it("stages every dimension as add against an empty tracker", () => {
    const plan = planProfileApplication(PROFILE, emptyState());
    expect(plan.profile).toEqual({ name: "test", title: "Test", summary: "Synthetic test profile" });
    expect(plan.types.changes).toEqual([{ key: "Widget", status: "add" }]);
    expect(plan.types.changed).toBe(true);
    expect(plan.statuses.changes).toEqual([{ key: "verifying", status: "add" }]);
    expect(plan.fields.changes).toEqual([{ key: "widget_size", status: "add" }]);
    expect(plan.workflows.changes).toEqual([{ type: "Widget", status: "add" }]);
    expect(plan.workflows.result).toEqual([{ type: "Widget", allowed_transitions: [["open", "in_progress"]] }]);
    expect(plan.config.changes).toEqual([
      { key: "search_max_results", path: "search.max_results", value: 30, status: "add" },
    ]);
    expect(plan.templates.changes).toEqual([
      { name: "widget", options: { type: "Widget", priority: "2" }, status: "add" },
    ]);
    expect(plan.packages).toEqual([{ spec: "templates", reason: "reuse", status: "recommended" }]);
    expect(plan.changed).toBe(true);
  });

  it("is idempotent: re-planning the applied state reports unchanged and changed=false", () => {
    const first = planProfileApplication(PROFILE, emptyState());
    const applied = emptyState({
      typesRaw: serializeItemTypesFile(first.types.file),
      statusesRaw: serializeStatusDefsFile(first.statuses.file),
      fieldsRaw: serializeFieldsFile(first.fields.file),
      workflows: first.workflows.result,
      settings: { search: { max_results: 30 } },
      templates: new Map([["widget", PROFILE.templates[0].options]]),
    });
    const second = planProfileApplication(PROFILE, applied);
    expect(second.types.changes).toEqual([{ key: "Widget", status: "unchanged" }]);
    expect(second.statuses.changes).toEqual([{ key: "verifying", status: "unchanged" }]);
    expect(second.fields.changes).toEqual([{ key: "widget_size", status: "unchanged" }]);
    expect(second.workflows.changes).toEqual([{ type: "Widget", status: "unchanged" }]);
    expect(second.config.changes[0].status).toBe("unchanged");
    expect(second.templates.changes[0].status).toBe("unchanged");
    expect(second.changed).toBe(false);
  });

  it("classifies a differing stored entry as update across every schema dimension", () => {
    const typesRaw = serializeItemTypesFile(
      upsertItemType(parseItemTypesFile(null), normalizeAddTypeInput({ name: "Widget", folder: "gadgets" })).file,
    );
    const statusesRaw = serializeStatusDefsFile(
      upsertStatusDef(parseStatusDefsFile(null), normalizeAddStatusInput({ id: "verifying", roles: ["draft"] })).file,
    );
    const fieldsRaw = serializeFieldsFile(
      upsertField(parseFieldsFile(null), normalizeAddFieldInput({ key: "widget_size", type: "string" })).file,
    );
    const plan = planProfileApplication(
      PROFILE,
      emptyState({
        typesRaw,
        statusesRaw,
        fieldsRaw,
        workflows: [{ type: "Widget", allowed_transitions: [["open", "closed"]] }],
        settings: { search: { max_results: 99 } },
        templates: new Map([["widget", { type: "Widget", priority: "5" }]]),
      }),
    );
    expect(plan.types.changes).toEqual([{ key: "Widget", status: "update" }]);
    expect(plan.statuses.changes).toEqual([{ key: "verifying", status: "update" }]);
    expect(plan.fields.changes).toEqual([{ key: "widget_size", status: "update" }]);
    expect(plan.workflows.changes).toEqual([{ type: "Widget", status: "update" }]);
    expect(plan.config.changes[0].status).toBe("update");
    expect(plan.templates.changes[0].status).toBe("update");
    expect(plan.changed).toBe(true);
  });

  it("preserves untouched existing workflows and appends the staged one", () => {
    const plan = planProfileApplication(
      PROFILE,
      emptyState({ workflows: [{ type: "Other", allowed_transitions: [["open", "closed"]] }] }),
    );
    expect(plan.workflows.result).toEqual([
      { type: "Other", allowed_transitions: [["open", "closed"]] },
      { type: "Widget", allowed_transitions: [["open", "in_progress"]] },
    ]);
  });

  it("treats reordered template option keys as unchanged via canonical comparison", () => {
    const plan = planProfileApplication(
      PROFILE,
      emptyState({ templates: new Map([["widget", { priority: "2", type: "Widget" }]]) }),
    );
    expect(plan.templates.changes[0].status).toBe("unchanged");
  });

  it("marks a recommendation installed when present in installedPackages", () => {
    const plan = planProfileApplication(PROFILE, emptyState({ installedPackages: new Set(["templates"]) }));
    expect(plan.packages).toEqual([{ spec: "templates", reason: "reuse", status: "installed" }]);
  });

  it("excludes advisory package recommendations from the changed aggregate", () => {
    const onlyPackages: ProjectProfileDefinition = {
      ...PROFILE,
      types: [],
      statuses: [],
      fields: [],
      workflows: [],
      config: [],
      templates: [],
    };
    const plan = planProfileApplication(onlyPackages, emptyState());
    expect(plan.changed).toBe(false);
    expect(plan.packages).toHaveLength(1);
  });

  it("throws on an unknown config key", () => {
    const bad: ProjectProfileDefinition = {
      ...PROFILE,
      config: [{ key: "definitely_not_a_knob", value: "1", summary: "x" }],
    };
    expect(() => planProfileApplication(bad, emptyState())).toThrow(/unknown config key "definitely_not_a_knob"/);
  });

  it("throws on an invalid config value", () => {
    const bad: ProjectProfileDefinition = {
      ...PROFILE,
      config: [{ key: "search_max_results", value: "not-a-number", summary: "x" }],
    };
    expect(() => planProfileApplication(bad, emptyState())).toThrow(/config search_max_results/);
  });
});
