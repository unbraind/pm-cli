/**
 * @module core/profile/profile-plan
 *
 * Pure planning for `pm profile apply`. Given a {@link ProjectProfileDefinition}
 * and a snapshot of the current tracker state, computes an idempotent diff across
 * every profile dimension (item types, statuses, fields, per-type workflows,
 * config knobs, templates, and package recommendations) without touching disk.
 *
 * Idempotency is structural: each schema component is upserted onto a clone and
 * the canonical serialization is compared before/after, so re-running `apply`
 * against an already-applied profile reports every entry as `unchanged` and the
 * command performs zero writes. The resulting files/settings the planner returns
 * are exactly what the apply step persists, guaranteeing the dry-run preview and
 * the real mutation never diverge.
 */
import {
  normalizeAddTypeInput,
  parseItemTypesFile,
  serializeItemTypesFile,
  upsertItemType,
  type ItemTypesFile,
} from "../schema/item-types-file.js";
import {
  normalizeAddStatusInput,
  parseStatusDefsFile,
  serializeStatusDefsFile,
  upsertStatusDef,
  type StatusDefsFile,
} from "../schema/status-defs-file.js";
import {
  normalizeAddFieldInput,
  parseFieldsFile,
  serializeFieldsFile,
  upsertField,
  type FieldsFile,
} from "../schema/fields-file.js";
import {
  parseNestedSettingValue,
  readNestedSettingValue,
  resolveNestedSettingDescriptor,
} from "../config/nested-settings.js";
import type { TypeWorkflowDefinition } from "../../types.js";
import type {
  ProfileTemplateOptions,
  ProjectProfileDefinition,
} from "./profile-presets.js";

/** Per-entry change classification used across every profile dimension. */
export type ProfileChangeStatus = "add" | "update" | "unchanged";

/** A single staged change keyed by its component identifier. */
export interface ProfileComponentChange {
  /** Component identity (type name, status id, field key, etc.). */
  key: string;
  /** Whether the entry is new, an overwrite, or already current. */
  status: ProfileChangeStatus;
}

/** Plan for a file-backed schema component (types/statuses/fields). */
export interface ProfileSchemaPlan<TFile> {
  /** Serialized file content to persist when `changed`. */
  file: TFile;
  /** Per-entry classifications in profile order. */
  changes: ProfileComponentChange[];
  /** True when at least one entry is add/update. */
  changed: boolean;
}

/** A staged per-type workflow change plus the merged result list. */
export interface ProfileWorkflowChange {
  /** Item type the workflow governs. */
  type: string;
  /** Whether the workflow is new, changed, or already current. */
  status: ProfileChangeStatus;
}

/** Plan for the `schema.type_workflows` settings subtree. */
export interface ProfileWorkflowPlan {
  /** Per-workflow classifications in profile order. */
  changes: ProfileWorkflowChange[];
  /** Full merged workflow list to persist when `changed`. */
  result: TypeWorkflowDefinition[];
  /** True when at least one workflow is add/update. */
  changed: boolean;
}

/** A staged config knob plus the resolved settings path and typed value. */
export interface ProfileConfigChange {
  /** Descriptor key (snake_case). */
  key: string;
  /** Dotted PmSettings path the value writes to. */
  path: string;
  /** Typed leaf value to persist. */
  value: string | number | boolean;
  /** Whether the leaf is new, changed, or already current. */
  status: ProfileChangeStatus;
}

/** Plan for the nested-settings knobs a profile stages. */
export interface ProfileConfigPlan {
  /** Per-knob classifications in profile order. */
  changes: ProfileConfigChange[];
  /** True when at least one knob is add/update. */
  changed: boolean;
}

/** A staged create-template change. */
export interface ProfileTemplateChange {
  /** Template name. */
  name: string;
  /** Option payload to persist for the template. */
  options: ProfileTemplateOptions;
  /** Whether the template is new, changed, or already current. */
  status: ProfileChangeStatus;
}

/** Plan for the create templates a profile stages. */
export interface ProfileTemplatePlan {
  /** Per-template classifications in profile order. */
  changes: ProfileTemplateChange[];
  /** True when at least one template is add/update. */
  changed: boolean;
}

/** Advisory package recommendation with install status. */
export interface ProfilePackagePlan {
  /** Catalog alias or install spec. */
  spec: string;
  /** Why the archetype benefits from the package. */
  reason: string;
  /** `installed` when already present, otherwise `recommended`. */
  status: "installed" | "recommended";
}

/** Current tracker state the planner diffs the profile against. */
export interface ProfileCurrentState {
  /** Raw `schema/types.json` content (or null when absent). */
  typesRaw: string | null;
  /** Raw status-defs file content (or null when absent). */
  statusesRaw: string | null;
  /** Raw fields file content (or null when absent). */
  fieldsRaw: string | null;
  /** Current `schema.type_workflows` entries. */
  workflows: readonly TypeWorkflowDefinition[];
  /** Settings object used to read current config leaf values. */
  settings: unknown;
  /** Existing stored template options keyed by template name. */
  templates: ReadonlyMap<string, ProfileTemplateOptions>;
  /** Install specs/aliases already present in the project. */
  installedPackages: ReadonlySet<string>;
}

/** Complete idempotent plan for applying a profile. */
export interface ProfileApplicationPlan {
  /** Identifying metadata for the planned profile. */
  profile: { name: string; title: string; summary: string };
  /** Item-type plan. */
  types: ProfileSchemaPlan<ItemTypesFile>;
  /** Status plan. */
  statuses: ProfileSchemaPlan<StatusDefsFile>;
  /** Field plan. */
  fields: ProfileSchemaPlan<FieldsFile>;
  /** Per-type workflow plan. */
  workflows: ProfileWorkflowPlan;
  /** Config-knob plan. */
  config: ProfileConfigPlan;
  /** Template plan. */
  templates: ProfileTemplatePlan;
  /** Advisory package recommendations. */
  packages: ProfilePackagePlan[];
  /** True when any dimension stages an add/update. */
  changed: boolean;
}

/**
 * Plans a file-backed schema component by upserting each normalized input onto a
 * working clone and comparing canonical serializations to classify add/update/
 * unchanged. Shared by the type, status, and field planners.
 */
function planSchemaComponent<TInput, TFile>(
  initialFile: TFile,
  inputs: readonly TInput[],
  keyOf: (input: TInput) => string,
  serialize: (file: TFile) => string,
  upsert: (file: TFile, input: TInput) => { file: TFile; replaced: boolean },
): ProfileSchemaPlan<TFile> {
  let file = initialFile;
  const changes: ProfileComponentChange[] = [];
  for (const input of inputs) {
    const before = serialize(file);
    const result = upsert(file, input);
    const after = serialize(result.file);
    file = result.file;
    const status: ProfileChangeStatus = before === after ? "unchanged" : result.replaced ? "update" : "add";
    changes.push({ key: keyOf(input), status });
  }
  return { file, changes, changed: changes.some((change) => change.status !== "unchanged") };
}

/**
 * Plans the per-type workflow merge. A workflow whose serialized transitions
 * exactly match the current entry is `unchanged`; a new type is `add`; a changed
 * transition list is `update`. The merged result preserves untouched entries.
 */
function planWorkflows(
  current: readonly TypeWorkflowDefinition[],
  desired: readonly TypeWorkflowDefinition[],
): ProfileWorkflowPlan {
  const result = current.map((entry) => ({ ...entry }));
  const changes: ProfileWorkflowChange[] = [];
  for (const workflow of desired) {
    const index = result.findIndex((entry) => entry.type === workflow.type);
    const next: TypeWorkflowDefinition = { type: workflow.type, allowed_transitions: workflow.allowed_transitions };
    if (index < 0) {
      result.push(next);
      changes.push({ type: workflow.type, status: "add" });
    } else if (JSON.stringify(result[index].allowed_transitions) === JSON.stringify(workflow.allowed_transitions)) {
      changes.push({ type: workflow.type, status: "unchanged" });
    } else {
      result[index] = next;
      changes.push({ type: workflow.type, status: "update" });
    }
  }
  return { changes, result, changed: changes.some((change) => change.status !== "unchanged") };
}

/**
 * Plans config knobs by resolving each descriptor, coercing the value, and
 * comparing it against the current settings leaf. Throws a plain Error for an
 * unknown key or invalid value so the CLI can map it to a USAGE exit code.
 */
function planConfig(profile: ProjectProfileDefinition, settings: unknown): ProfileConfigPlan {
  const changes: ProfileConfigChange[] = [];
  for (const entry of profile.config) {
    const descriptor = resolveNestedSettingDescriptor(entry.key);
    if (descriptor === undefined) {
      throw new Error(`Profile "${profile.name}" references unknown config key "${entry.key}".`);
    }
    const parsed = parseNestedSettingValue(descriptor, entry.value);
    if (!parsed.ok) {
      throw new Error(`Profile "${profile.name}" config ${entry.key}: ${parsed.error.message}`);
    }
    const current = readNestedSettingValue(settings, descriptor);
    const status: ProfileChangeStatus =
      current === null ? "add" : current === parsed.parsed.value ? "unchanged" : "update";
    changes.push({ key: descriptor.key, path: descriptor.path, value: parsed.parsed.value, status });
  }
  return { changes, changed: changes.some((change) => change.status !== "unchanged") };
}

/**
 * Canonicalizes a template option payload to a key-order-independent string so a
 * profile's authored option order never produces a spurious `update` against the
 * key-sorted form `pm templates save` persists.
 */
function canonicalTemplateOptions(options: ProfileTemplateOptions): string {
  const sorted = Object.entries(options).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(sorted);
}

/**
 * Plans create templates by comparing each profile template's option payload
 * against the stored template (if any). Equality is canonical so option key
 * ordering never produces a spurious `update`.
 */
function planTemplates(
  profile: ProjectProfileDefinition,
  existing: ReadonlyMap<string, ProfileTemplateOptions>,
): ProfileTemplatePlan {
  const changes: ProfileTemplateChange[] = [];
  for (const template of profile.templates) {
    const current = existing.get(template.name);
    let status: ProfileChangeStatus;
    if (current === undefined) {
      status = "add";
    } else if (canonicalTemplateOptions(current) === canonicalTemplateOptions(template.options)) {
      status = "unchanged";
    } else {
      status = "update";
    }
    changes.push({ name: template.name, options: template.options, status });
  }
  return { changes, changed: changes.some((change) => change.status !== "unchanged") };
}

/**
 * Computes the complete idempotent application plan for a profile against the
 * supplied tracker snapshot. The returned files/settings are exactly what the
 * apply step persists; nothing here touches disk.
 */
export function planProfileApplication(
  profile: ProjectProfileDefinition,
  current: ProfileCurrentState,
): ProfileApplicationPlan {
  const types = planSchemaComponent(
    parseItemTypesFile(current.typesRaw),
    profile.types,
    (input) => normalizeAddTypeInput(input).name,
    serializeItemTypesFile,
    (file, input) => upsertItemType(file, normalizeAddTypeInput(input)),
  );
  const statuses = planSchemaComponent(
    parseStatusDefsFile(current.statusesRaw),
    profile.statuses,
    (input) => normalizeAddStatusInput(input).id,
    serializeStatusDefsFile,
    (file, input) => upsertStatusDef(file, normalizeAddStatusInput(input)),
  );
  const fields = planSchemaComponent(
    parseFieldsFile(current.fieldsRaw),
    profile.fields,
    (input) => normalizeAddFieldInput(input).key,
    serializeFieldsFile,
    (file, input) => upsertField(file, normalizeAddFieldInput(input)),
  );
  const workflows = planWorkflows(current.workflows, profile.workflows);
  const config = planConfig(profile, current.settings);
  const templates = planTemplates(profile, current.templates);
  const packages = profile.packages.map((recommendation) => ({
    spec: recommendation.spec,
    reason: recommendation.reason,
    status: current.installedPackages.has(recommendation.spec) ? ("installed" as const) : ("recommended" as const),
  }));
  const changed = types.changed || statuses.changed || fields.changed || workflows.changed || config.changed || templates.changed;
  return {
    profile: { name: profile.name, title: profile.title, summary: profile.summary },
    types,
    statuses,
    fields,
    workflows,
    config,
    templates,
    packages,
    changed,
  };
}
