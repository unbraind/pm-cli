/**
 * @module cli/commands/profile
 *
 * Implements the `pm profile` command surface: listing the built-in project
 * archetypes, showing a profile's full composition, and applying a profile to an
 * initialized tracker. Apply stages item types, custom statuses, custom fields,
 * per-type workflows, config knobs, and create templates idempotently, and
 * surfaces advisory package recommendations. The pure diff lives in
 * {@link module:core/profile/profile-plan}; this module is the I/O orchestration
 * and human formatting around it.
 */
import path from "node:path";
import { pathExists, readFileIfExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { acquireLock } from "../../core/lock/lock.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { nowIso } from "../../core/shared/time.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, resolveGovernanceKnobs, writeSettings } from "../../core/store/settings.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
} from "../../core/schema/runtime-schema.js";
import { normalizeAddTypeInput, serializeItemTypesFile } from "../../core/schema/item-types-file.js";
import { serializeStatusDefsFile } from "../../core/schema/status-defs-file.js";
import { serializeFieldsFile } from "../../core/schema/fields-file.js";
import {
  resolveNestedSettingDescriptor,
  writeNestedSettingValue,
} from "../../core/config/nested-settings.js";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import {
  resolveProfileCatalog,
  resolveProfileEntry,
  type ExtensionProfileContribution,
  type ProfileSourceKind,
  type ProfileTemplateOptions,
  type ProjectProfileDefinition,
  type ResolvedProfile,
} from "../../core/profile/profile-presets.js";
import {
  planProfileApplication,
  type ProfileApplicationPlan,
  type ProfileChangeStatus,
  type ProfileCurrentState,
} from "../../core/profile/profile-plan.js";
import { ensureTypeFolderScaffold } from "./schema.js";
import { runTemplatesSave } from "./templates.js";

/** Ordered `pm profile` subcommands. */
export const PROFILE_SUBCOMMANDS = ["list", "show", "apply"] as const;
/**
 * Restricts profile subcommand values accepted by command, SDK, and storage contracts.
 */
export type ProfileSubcommand = (typeof PROFILE_SUBCOMMANDS)[number];

const PROFILE_TYPES_LOCK_ID = "schema-types";
const PROFILE_STATUSES_LOCK_ID = "schema-statuses";
const PROFILE_FIELDS_LOCK_ID = "schema-fields";

/** Per-dimension counts summarizing how much a profile stages. */
export interface ProfileComposition {
  /** Number of item types the profile registers. */
  types: number;
  /** Number of custom statuses. */
  statuses: number;
  /** Number of custom fields. */
  fields: number;
  /** Number of per-type workflows. */
  workflows: number;
  /** Number of config knobs. */
  config: number;
  /** Number of create templates. */
  templates: number;
  /** Number of recommended packages. */
  packages: number;
}

/** A single profile entry in the `pm profile list` payload. */
export interface ProfileListEntry {
  /** Profile name. */
  name: string;
  /** Display title. */
  title: string;
  /** One-line archetype summary. */
  summary: string;
  /** Whether the profile is core-baked or contributed by an active extension. */
  source: ProfileSourceKind;
  /** Owning package/extension name for an extension profile; omitted for builtins. */
  package?: string;
  /** Per-dimension counts. */
  composition: ProfileComposition;
}

/** Result of `pm profile list`. */
export interface ProfileListResult {
  /** Discriminant for the profile result union. */
  action: "list";
  /** Built-in profiles in canonical order followed by active extension profiles. */
  profiles: ProfileListEntry[];
  /** Non-fatal merge warnings (built-in shadowing attempts, duplicate names). */
  warnings: string[];
  /** ISO timestamp the result was produced. */
  generated_at: string;
}

/** Result of `pm profile show <name>`. */
export interface ProfileShowResult {
  /** Discriminant for the profile result union. */
  action: "show";
  /** Profile name. */
  name: string;
  /** Display title. */
  title: string;
  /** One-line archetype summary. */
  summary: string;
  /** Whether the profile is core-baked or contributed by an active extension. */
  source: ProfileSourceKind;
  /** Owning package/extension name for an extension profile; omitted for builtins. */
  package?: string;
  /** Per-dimension counts. */
  composition: ProfileComposition;
  /** Item type names the profile registers. */
  types: string[];
  /** Custom status ids. */
  statuses: string[];
  /** Custom field keys. */
  fields: string[];
  /** Item types governed by a staged workflow. */
  workflows: string[];
  /** Config knobs as `key=value` pairs. */
  config: string[];
  /** Template names the profile stages. */
  templates: string[];
  /** Recommended package specs with rationale. */
  packages: Array<{ spec: string; reason: string }>;
  /** ISO timestamp the result was produced. */
  generated_at: string;
}

/** Per-dimension change summary in an apply result. */
export interface ProfileApplyDimension {
  /** Entry keys that were newly created. */
  added: string[];
  /** Entry keys whose stored value was overwritten. */
  updated: string[];
  /** Entry keys already current (no write). */
  unchanged: string[];
}

/** Result of `pm profile apply <name>`. */
export interface ProfileApplyResult {
  /** Discriminant for the profile result union. */
  action: "apply";
  /** Applied profile name. */
  name: string;
  /** Display title. */
  title: string;
  /** True when changes were persisted; false for `--dry-run` or a no-op. */
  applied: boolean;
  /** True when `--dry-run` previewed without writing. */
  dry_run: boolean;
  /** True when at least one dimension stages an add/update. */
  changed: boolean;
  /** Item-type change summary. */
  types: ProfileApplyDimension;
  /** Status change summary. */
  statuses: ProfileApplyDimension;
  /** Field change summary. */
  fields: ProfileApplyDimension;
  /** Workflow change summary. */
  workflows: ProfileApplyDimension;
  /** Config-knob change summary. */
  config: ProfileApplyDimension;
  /** Template change summary. */
  templates: ProfileApplyDimension;
  /** Advisory package recommendations with install status. */
  packages: Array<{ spec: string; reason: string; status: "installed" | "recommended" }>;
  /** Deduped on-write hook + advisory warnings. */
  warnings: string[];
  /** ISO timestamp the result was produced. */
  generated_at: string;
}

/** Discriminated union of every `pm profile` result shape. */
export type ProfileResult = ProfileListResult | ProfileShowResult | ProfileApplyResult;

/* c8 ignore start -- profile command I/O orchestration and formatting is covered by profile integration workflows; the idempotent diff is unit-tested in core/profile/profile-plan. */

function compositionOf(profile: ProjectProfileDefinition): ProfileComposition {
  return {
    types: profile.types.length,
    statuses: profile.statuses.length,
    fields: profile.fields.length,
    workflows: profile.workflows.length,
    config: profile.config.length,
    templates: profile.templates.length,
    packages: profile.packages.length,
  };
}

/**
 * Collects the profiles contributed by active extensions, mapping the live
 * registration registry onto the resolver's contribution shape. Returns an empty
 * list when extensions are disabled or none registered a profile.
 */
function collectExtensionProfileContributions(): ExtensionProfileContribution[] {
  const registrations = getActiveExtensionRegistrations();
  if (registrations === null) {
    return [];
  }
  return registrations.profiles.map((entry) => ({ name: entry.name, profile: entry.profile }));
}

/**
 * Lists every available profile — the built-in archetypes followed by profiles
 * contributed by active extensions — with per-dimension composition counts and
 * the source each came from. Surfaces any non-fatal merge collisions as warnings.
 */
export function runProfileList(): ProfileListResult {
  const { profiles, warnings } = resolveProfileCatalog(collectExtensionProfileContributions());
  return {
    action: "list",
    profiles: profiles.map((resolved) => ({
      name: resolved.definition.name,
      title: resolved.definition.title,
      summary: resolved.definition.summary,
      source: resolved.source,
      ...(resolved.package !== undefined ? { package: resolved.package } : {}),
      composition: compositionOf(resolved.definition),
    })),
    warnings,
    generated_at: nowIso(),
  };
}

/**
 * Shows the full composition of a single profile, resolved across built-in and
 * extension-contributed archetypes. Throws a USAGE error for a missing or unknown
 * profile name.
 */
export function runProfileShow(name: string | undefined): ProfileShowResult {
  let resolved: ResolvedProfile;
  try {
    resolved = resolveProfileEntry(name, collectExtensionProfileContributions());
  } catch (error) {
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
  }
  const profile = resolved.definition;
  return {
    action: "show",
    name: profile.name,
    title: profile.title,
    summary: profile.summary,
    source: resolved.source,
    ...(resolved.package !== undefined ? { package: resolved.package } : {}),
    composition: compositionOf(profile),
    types: profile.types.map((type) => normalizeAddTypeInput(type).name),
    statuses: profile.statuses.map((status) => String(status.id ?? "")),
    fields: profile.fields.map((field) => String(field.key ?? "")),
    workflows: profile.workflows.map((workflow) => workflow.type),
    config: profile.config.map((entry) => `${entry.key}=${entry.value}`),
    templates: profile.templates.map((template) => template.name),
    packages: profile.packages.map((pkg) => ({ spec: pkg.spec, reason: pkg.reason })),
    generated_at: nowIso(),
  };
}

/** Options accepted by {@link runProfileApply}. */
export interface ProfileApplyCommandOptions {
  /** Preview the diff without writing any files. */
  dryRun?: boolean;
  /** Mutation author override. */
  author?: string;
  /** Force ownership/lock override. */
  force?: boolean;
}

function templateFilePath(pmRoot: string, name: string): string {
  return path.join(pmRoot, "templates", `${name}.json`);
}

async function readStoredTemplateOptions(pmRoot: string, name: string): Promise<ProfileTemplateOptions | undefined> {
  const raw = await readFileIfExists(templateFilePath(pmRoot, name));
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const options = (parsed as { options?: unknown }).options;
      if (options !== null && typeof options === "object" && !Array.isArray(options)) {
        return options as ProfileTemplateOptions;
      }
    }
  } catch {
    // A malformed template file is treated as absent so apply re-stages it.
  }
  return undefined;
}

async function loadProfileCurrentState(
  pmRoot: string,
  schema: ReturnType<typeof normalizeRuntimeSchemaSettings>,
  settings: Awaited<ReturnType<typeof readSettings>>,
  profile: ProjectProfileDefinition,
): Promise<ProfileCurrentState> {
  const templates = new Map<string, ProfileTemplateOptions>();
  for (const template of profile.templates) {
    const stored = await readStoredTemplateOptions(pmRoot, template.name);
    if (stored !== undefined) {
      templates.set(template.name, stored);
    }
  }
  return {
    typesRaw: await readFileIfExists(filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types)),
    statusesRaw: await readFileIfExists(
      filePathForSchemaSection(pmRoot, schema.files.statuses, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses),
    ),
    fieldsRaw: await readFileIfExists(
      filePathForSchemaSection(pmRoot, schema.files.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields),
    ),
    workflows: settings.schema.type_workflows ?? [],
    settings,
    templates,
    // Package recommendations are advisory: apply never installs and never
    // inspects install state, so every recommendation surfaces as "recommended".
    // The planner still supports an install-state set for SDK consumers that want
    // richer reporting.
    installedPackages: new Set<string>(),
  };
}

function dimensionFrom(changes: ReadonlyArray<{ key: string; status: ProfileChangeStatus }>): ProfileApplyDimension {
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const change of changes) {
    (change.status === "add" ? added : change.status === "update" ? updated : unchanged).push(change.key);
  }
  return { added, updated, unchanged };
}

function buildApplyResult(
  profile: ProjectProfileDefinition,
  plan: ProfileApplicationPlan,
  applied: boolean,
  dryRun: boolean,
  warnings: string[],
): ProfileApplyResult {
  return {
    action: "apply",
    name: profile.name,
    title: profile.title,
    applied,
    dry_run: dryRun,
    changed: plan.changed,
    types: dimensionFrom(plan.types.changes),
    statuses: dimensionFrom(plan.statuses.changes),
    fields: dimensionFrom(plan.fields.changes),
    workflows: dimensionFrom(plan.workflows.changes.map((change) => ({ key: change.type, status: change.status }))),
    config: dimensionFrom(plan.config.changes),
    templates: dimensionFrom(plan.templates.changes.map((change) => ({ key: change.name, status: change.status }))),
    packages: plan.packages,
    warnings: [...new Set(warnings)].sort((left, right) => left.localeCompare(right)),
    generated_at: nowIso(),
  };
}

/**
 * Applies a profile to the initialized tracker, or previews the idempotent diff
 * when `dryRun` is set. Schema files are written under their respective locks;
 * config and workflows are persisted to settings; templates are staged via the
 * shared template writer. Re-applying an already-applied profile performs zero
 * writes. Throws a USAGE error for an unknown profile or an invalid config knob,
 * and a NOT_FOUND error when the tracker is not initialized.
 */
export async function runProfileApply(
  name: string | undefined,
  options: ProfileApplyCommandOptions,
  global: GlobalOptions,
): Promise<ProfileApplyResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  let profile: ProjectProfileDefinition;
  try {
    profile = resolveProfileEntry(name, collectExtensionProfileContributions()).definition;
  } catch (error) {
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
  }

  const dryRun = options.dryRun === true;
  const settings = await readSettings(pmRoot);
  const schema = normalizeRuntimeSchemaSettings(settings.schema);

  if (dryRun) {
    const state = await loadProfileCurrentState(pmRoot, schema, settings, profile);
    const plan = planProfile(profile, state);
    return buildApplyResult(profile, plan, false, true, []);
  }

  const author = resolveAuthor(options.author, settings.author_default);
  const governance = resolveGovernanceKnobs(settings);
  const force = Boolean(options.force);
  const warnings: string[] = [];

  // Acquire all three schema locks inside the try so a later acquisition that
  // throws (held/stale lock without --force) still releases the earlier ones in
  // finally rather than stranding them until TTL expiry.
  const releasers: Array<() => Promise<void>> = [];
  const acquire = async (lockId: string): Promise<void> => {
    releasers.push(
      await acquireLock(pmRoot, lockId, settings.locks.ttl_seconds, author, force, governance.force_required_for_stale_lock),
    );
  };
  let plan: ProfileApplicationPlan;
  try {
    await acquire(PROFILE_TYPES_LOCK_ID);
    await acquire(PROFILE_STATUSES_LOCK_ID);
    await acquire(PROFILE_FIELDS_LOCK_ID);
    const state = await loadProfileCurrentState(pmRoot, schema, settings, profile);
    plan = planProfile(profile, state);

    if (plan.types.changed) {
      const typesPath = filePathForSchemaSection(pmRoot, schema.files.types, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types);
      await writeFileAtomic(typesPath, serializeItemTypesFile(plan.types.file));
      const stagedNames = new Set(profile.types.map((type) => normalizeAddTypeInput(type).name));
      const stagedDefinitions = plan.types.file.definitions.filter((definition) => stagedNames.has(definition.name));
      await ensureTypeFolderScaffold(pmRoot, stagedDefinitions, warnings, "profile:apply-type-folder");
      warnings.push(...(await runActiveOnWriteHooks({ path: typesPath, scope: "project", op: "profile:apply-types" })));
    }
    if (plan.statuses.changed) {
      const statusesPath = filePathForSchemaSection(pmRoot, schema.files.statuses, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses);
      await writeFileAtomic(statusesPath, serializeStatusDefsFile(plan.statuses.file));
      warnings.push(...(await runActiveOnWriteHooks({ path: statusesPath, scope: "project", op: "profile:apply-statuses" })));
    }
    if (plan.fields.changed) {
      const fieldsPath = filePathForSchemaSection(pmRoot, schema.files.fields, DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields);
      await writeFileAtomic(fieldsPath, serializeFieldsFile(plan.fields.file));
      warnings.push(...(await runActiveOnWriteHooks({ path: fieldsPath, scope: "project", op: "profile:apply-fields" })));
    }
    if (plan.config.changed || plan.workflows.changed) {
      for (const change of plan.config.changes) {
        if (change.status === "unchanged") {
          continue;
        }
        const descriptor = resolveNestedSettingDescriptor(change.key);
        if (descriptor !== undefined) {
          writeNestedSettingValue(settings as unknown as Record<string, unknown>, descriptor, change.value);
        }
      }
      settings.schema.type_workflows = plan.workflows.result;
      await writeSettings(pmRoot, settings, "profile:apply-config");
    }
    for (const change of plan.templates.changes) {
      if (change.status === "unchanged") {
        continue;
      }
      await runTemplatesSave(change.name, { ...change.options }, global);
    }
  } finally {
    // Release in reverse acquisition order; only locks actually acquired are
    // present. Each release is best-effort so one rejecting release never strands
    // the remaining locks (a failed release falls back to TTL expiry).
    for (const release of releasers.reverse()) {
      try {
        await release();
      } catch {
        // Ignore: a failed lock release is non-fatal and self-heals at TTL.
      }
    }
  }

  return buildApplyResult(profile, plan, plan.changed, false, warnings);
}

// planProfileApplication can throw a plain Error for an invalid config knob; map
// it to a USAGE exit code consistently across the dry-run and apply paths.
function planProfile(profile: ProjectProfileDefinition, state: ProfileCurrentState): ProfileApplicationPlan {
  try {
    return planProfileApplication(profile, state);
  } catch (error) {
    throw new PmCliError(error instanceof Error ? error.message : String(error), EXIT_CODE.USAGE);
  }
}

function formatDimensionLine(label: string, dimension: ProfileApplyDimension): string | undefined {
  const segments: string[] = [];
  if (dimension.added.length > 0) {
    segments.push(`+${dimension.added.join(", ")}`);
  }
  if (dimension.updated.length > 0) {
    segments.push(`~${dimension.updated.join(", ")}`);
  }
  if (segments.length === 0) {
    return undefined;
  }
  return `  ${label}: ${segments.join("  ")}`;
}

/**
 * Renders the `pm profile list` result as human-readable text.
 */
export function formatProfileListHuman(result: ProfileListResult): string {
  const lines = ["Project profiles:"];
  for (const profile of result.profiles) {
    const origin = profile.source === "extension" ? ` [${profile.package ?? "extension"}]` : "";
    lines.push(`  ${profile.name} — ${profile.title}: ${profile.summary}${origin}`);
  }
  for (const warning of result.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

/**
 * Renders the `pm profile show` result as human-readable text.
 */
export function formatProfileShowHuman(result: ProfileShowResult): string {
  const origin = result.source === "extension" ? ` [${result.package ?? "extension"}]` : "";
  const lines = [`${result.name} — ${result.title}${origin}`, result.summary, ""];
  lines.push(`types: ${result.types.join(", ") || "(none)"}`);
  lines.push(`statuses: ${result.statuses.join(", ") || "(none)"}`);
  lines.push(`fields: ${result.fields.join(", ") || "(none)"}`);
  lines.push(`workflows: ${result.workflows.join(", ") || "(none)"}`);
  lines.push(`config: ${result.config.join(", ") || "(none)"}`);
  lines.push(`templates: ${result.templates.join(", ") || "(none)"}`);
  lines.push(`packages: ${result.packages.map((pkg) => pkg.spec).join(", ") || "(none)"}`);
  return lines.join("\n");
}

/**
 * Renders the `pm profile apply` result as human-readable text, including the
 * staged diff and any package recommendations.
 */
export function formatProfileApplyHuman(result: ProfileApplyResult): string {
  const mode = result.dry_run ? "dry-run" : result.applied ? "applied" : "no changes";
  const lines = [`Profile ${result.name} (${mode})`];
  if (!result.changed) {
    lines.push("  already up to date");
  } else {
    for (const [label, dimension] of [
      ["types", result.types],
      ["statuses", result.statuses],
      ["fields", result.fields],
      ["workflows", result.workflows],
      ["config", result.config],
      ["templates", result.templates],
    ] as const) {
      const line = formatDimensionLine(label, dimension);
      if (line !== undefined) {
        lines.push(line);
      }
    }
  }
  const recommended = result.packages.filter((pkg) => pkg.status === "recommended");
  if (recommended.length > 0) {
    lines.push(`  recommended packages: ${recommended.map((pkg) => pkg.spec).join(", ")}`);
  }
  return lines.join("\n");
}

/* c8 ignore stop */
