/**
 * @module core/profile/profile-lint
 *
 * Author-time, tracker-independent consistency linting for a
 * {@link ProjectProfileDefinition}. This is the project-profile analogue of the
 * extension surface's `lintExtensionBlueprint`: where `defineProjectProfile`
 * (and `api.registerProfile`) only assert structural shape, and
 * {@link module:core/profile/profile-plan planProfileApplication} only validates
 * config knobs fail-fast against a live tracker at apply time, this linter
 * inspects a profile definition in isolation and reports *every* problem at once
 * across all eight dimensions.
 *
 * Findings are graded:
 * - `error` — a condition that makes `pm profile apply` throw or silently lose
 *   data (an invalid type/status/field the upsert normalizer rejects, a
 *   duplicate key whose later entry overwrites the earlier one, an unknown or
 *   invalid config knob the planner rejects, an empty profile name resolution
 *   requires, or a malformed workflow transition pair the workflow resolver
 *   silently drops).
 * - `warning` — authored content that is structurally valid but very likely a
 *   bug (a workflow governing a type the profile never declares, a transition
 *   referencing a status token no profile/built-in status defines — a dead,
 *   unreachable rule — a template whose `type` references an undeclared type, a
 *   profile name resolution would fold, or an empty title/summary/package spec).
 *
 * Cross-reference checks are warnings rather than errors because the referenced
 * type or status MAY already exist in the target tracker independently of the
 * profile (profiles layer onto whatever schema is present), so erroring would
 * produce false positives against valid layered setups.
 *
 * Everything here is pure and side-effect-free so it is fully coverage-gated; the
 * CLI `pm profile lint` command and the SDK `assertProjectProfile` helper are
 * thin wrappers around {@link lintProjectProfile}.
 */
import { BUILTIN_ITEM_TYPE_VALUES } from "../../types/index.js";
import {
  parseNestedSettingValue,
  resolveNestedSettingDescriptor,
} from "../config/nested-settings.js";
import { normalizeAddFieldInput } from "../schema/fields-file.js";
import { normalizeAddStatusInput } from "../schema/status-defs-file.js";
import { normalizeAddTypeInput } from "../schema/item-types-file.js";
import { normalizeStatusToken } from "../schema/type-workflows.js";
import { DEFAULT_RUNTIME_STATUS_DEFINITIONS } from "../schema/runtime-schema.js";
import { toErrorMessage } from "../shared/primitives.js";
import {
  normalizeProfileLookupKey,
  type ProjectProfileDefinition,
} from "./profile-presets.js";

/** Severity grade of a profile lint finding. */
export type ProfileLintSeverity = "error" | "warning";

/** Profile dimension a lint finding is attributed to. */
export const PROFILE_LINT_DIMENSIONS = [
  "profile",
  "types",
  "statuses",
  "fields",
  "workflows",
  "config",
  "templates",
  "packages",
] as const;
/** Restricts profile lint dimension values accepted by command, SDK, and storage contracts. */
export type ProfileLintDimension = (typeof PROFILE_LINT_DIMENSIONS)[number];

/** Stable machine-readable codes every {@link ProjectProfileLintFinding} carries. */
export const PROFILE_LINT_CODES = [
  "profile_name_empty",
  "profile_name_not_normalized",
  "profile_title_empty",
  "profile_summary_empty",
  "type_invalid",
  "type_duplicate",
  "status_invalid",
  "status_duplicate",
  "field_invalid",
  "field_duplicate",
  "workflow_type_empty",
  "workflow_type_unknown",
  "workflow_duplicate_type",
  "workflow_transition_malformed",
  "workflow_status_unknown",
  "config_key_unknown",
  "config_value_invalid",
  "config_duplicate",
  "template_type_unknown",
  "package_spec_empty",
] as const;
/** Restricts profile lint code values accepted by command, SDK, and storage contracts. */
export type ProfileLintCode = (typeof PROFILE_LINT_CODES)[number];

/** A single graded consistency finding produced by {@link lintProjectProfile}. */
export interface ProjectProfileLintFinding {
  /** Whether the finding blocks a clean apply (`error`) or merely flags risk (`warning`). */
  severity: ProfileLintSeverity;
  /** Stable machine-readable classification. */
  code: ProfileLintCode;
  /** Profile dimension the finding belongs to. */
  dimension: ProfileLintDimension;
  /** Identifier of the offending entry within the dimension, when applicable. */
  target?: string;
  /** Human-facing description of the problem. */
  message: string;
}

/** Result of linting a single {@link ProjectProfileDefinition}. */
export interface ProjectProfileLintReport {
  /** The profile name as authored (preserved verbatim, even when blank). */
  profile: string;
  /** True when no `error`-severity findings were produced. */
  ok: boolean;
  /** All findings in deterministic dimension order. */
  findings: ProjectProfileLintFinding[];
  /** Count of `error`-severity findings. */
  errorCount: number;
  /** Count of `warning`-severity findings. */
  warningCount: number;
}

/** Built-in status tokens (canonical ids and their aliases, normalized) every tracker recognizes regardless of profile. A workflow transition referencing one of these is always resolvable, so it never triggers a `workflow_status_unknown` warning. Computed once from the canonical defaults so it never drifts. */
const BUILTIN_STATUS_TOKENS: ReadonlySet<string> = new Set(
  DEFAULT_RUNTIME_STATUS_DEFINITIONS.flatMap((definition) => [
    normalizeStatusToken(definition.id),
    ...(definition.aliases ?? []).map((alias) => normalizeStatusToken(alias)),
  ]).filter((token) => token.length > 0),
);

/** Built-in item type names, lower-cased for case-insensitive workflow/template matching. */
const BUILTIN_TYPE_KEYS: ReadonlySet<string> = new Set(
  BUILTIN_ITEM_TYPE_VALUES.map((name) => name.toLowerCase()),
);

/** Lint the profile-level identity fields (name, title, summary). */
function lintProfileIdentity(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): void {
  if (profile.name.trim().length === 0) {
    findings.push({
      severity: "error",
      code: "profile_name_empty",
      dimension: "profile",
      message:
        "Profile name must not be empty; profile resolution requires a non-blank name.",
    });
  } else if (profile.name !== normalizeProfileLookupKey(profile.name)) {
    findings.push({
      severity: "warning",
      code: "profile_name_not_normalized",
      dimension: "profile",
      target: profile.name,
      message: `Profile name "${profile.name}" is not in canonical form; resolution folds it to "${normalizeProfileLookupKey(profile.name)}" (lowercase, hyphens as underscores).`,
    });
  }
  if (profile.title.trim().length === 0) {
    findings.push({
      severity: "warning",
      code: "profile_title_empty",
      dimension: "profile",
      message:
        "Profile title is empty; list and show surfaces will render a blank title.",
    });
  }
  if (profile.summary.trim().length === 0) {
    findings.push({
      severity: "warning",
      code: "profile_summary_empty",
      dimension: "profile",
      message:
        "Profile summary is empty; list and show surfaces will render a blank archetype description.",
    });
  }
}

/** Lint the item types, returning the set of declared type keys (lower-cased) collected from entries that normalize cleanly so workflow and template checks can resolve cross-references against them. */
function lintTypes(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): Set<string> {
  const declared = new Set<string>();
  const seen = new Set<string>();
  for (const [index, type] of profile.types.entries()) {
    let name: string;
    try {
      name = normalizeAddTypeInput(type).name;
    } catch (error) {
      findings.push({
        severity: "error",
        code: "type_invalid",
        dimension: "types",
        target: typeof type.name === "string" ? type.name : `#${index}`,
        message: toErrorMessage(error),
      });
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      findings.push({
        severity: "error",
        code: "type_duplicate",
        dimension: "types",
        target: name,
        message: `Item type "${name}" is declared more than once; the later definition silently overwrites the earlier upsert.`,
      });
      continue;
    }
    seen.add(key);
    declared.add(key);
  }
  return declared;
}

/** Lint the custom statuses, returning the set of declared status tokens (ids and aliases, normalized) collected from entries that normalize cleanly so workflow transition checks can resolve cross-references against them. */
function lintStatuses(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): Set<string> {
  const declared = new Set<string>();
  const seen = new Set<string>();
  for (const [index, status] of profile.statuses.entries()) {
    let normalized: ReturnType<typeof normalizeAddStatusInput>;
    try {
      normalized = normalizeAddStatusInput(status);
    } catch (error) {
      findings.push({
        severity: "error",
        code: "status_invalid",
        dimension: "statuses",
        target: typeof status.id === "string" ? status.id : `#${index}`,
        message: toErrorMessage(error),
      });
      continue;
    }
    if (seen.has(normalized.id)) {
      findings.push({
        severity: "error",
        code: "status_duplicate",
        dimension: "statuses",
        target: normalized.id,
        message: `Status "${normalized.id}" is declared more than once; the later definition silently overwrites the earlier upsert.`,
      });
      continue;
    }
    seen.add(normalized.id);
    declared.add(normalized.id);
    for (const alias of normalized.aliases ?? []) {
      declared.add(normalizeStatusToken(alias));
    }
  }
  return declared;
}

/** Lint the custom fields for invalid and duplicate keys. */
function lintFields(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): void {
  const seen = new Set<string>();
  for (const [index, field] of profile.fields.entries()) {
    let key: string;
    try {
      key = normalizeAddFieldInput(field).key;
    } catch (error) {
      findings.push({
        severity: "error",
        code: "field_invalid",
        dimension: "fields",
        target: typeof field.key === "string" ? field.key : `#${index}`,
        message: toErrorMessage(error),
      });
      continue;
    }
    if (seen.has(key)) {
      findings.push({
        severity: "error",
        code: "field_duplicate",
        dimension: "fields",
        target: key,
        message: `Field "${key}" is declared more than once; the later definition silently overwrites the earlier upsert.`,
      });
      continue;
    }
    seen.add(key);
  }
}

/** Lint the per-type workflows: flag workflows that govern an undeclared type, duplicate workflows for the same type, malformed transition pairs, and transitions referencing a status token no built-in or profile status defines. */
function lintWorkflows(
  profile: ProjectProfileDefinition,
  declaredTypes: ReadonlySet<string>,
  declaredStatuses: ReadonlySet<string>,
  findings: ProjectProfileLintFinding[],
): void {
  const seenTypes = new Set<string>();
  for (const [index, workflow] of profile.workflows.entries()) {
    const typeKey = workflow.type.trim().toLowerCase();
    if (typeKey.length === 0) {
      findings.push({
        severity: "error",
        code: "workflow_type_empty",
        dimension: "workflows",
        target: `#${index}`,
        message:
          "Workflow has an empty type; the workflow resolver drops entries without a type.",
      });
      continue;
    }
    const duplicate = seenTypes.has(typeKey);
    seenTypes.add(typeKey);
    if (duplicate) {
      // The unknown-type check already fired for the first occurrence, so only
      // report the duplication here to avoid a redundant second finding.
      findings.push({
        severity: "warning",
        code: "workflow_duplicate_type",
        dimension: "workflows",
        target: workflow.type,
        message: `Workflow type "${workflow.type}" is declared more than once; the later transition set wins.`,
      });
    } else if (!BUILTIN_TYPE_KEYS.has(typeKey) && !declaredTypes.has(typeKey)) {
      findings.push({
        severity: "warning",
        code: "workflow_type_unknown",
        dimension: "workflows",
        target: workflow.type,
        message: `Workflow governs type "${workflow.type}" which is neither a built-in type nor declared by this profile; it has no effect unless that type already exists.`,
      });
    }
    // Each unknown status is reported once per workflow (not globally) so a later
    // workflow referencing the same unresolved token is still surfaced in its own
    // context.
    const reportedUnknownStatuses = new Set<string>();
    for (const pair of workflow.allowed_transitions) {
      const from = normalizeStatusToken(pair[0]);
      const to = normalizeStatusToken(pair[1]);
      if (from.length === 0 || to.length === 0) {
        findings.push({
          severity: "error",
          code: "workflow_transition_malformed",
          dimension: "workflows",
          target: workflow.type,
          message: `Workflow "${workflow.type}" has a transition with an empty status; the workflow resolver silently drops it.`,
        });
        continue;
      }
      for (const token of [from, to]) {
        if (
          BUILTIN_STATUS_TOKENS.has(token) ||
          declaredStatuses.has(token) ||
          reportedUnknownStatuses.has(token)
        ) {
          continue;
        }
        reportedUnknownStatuses.add(token);
        findings.push({
          severity: "warning",
          code: "workflow_status_unknown",
          dimension: "workflows",
          target: token,
          message: `Workflow "${workflow.type}" references status "${token}" which is neither a built-in status nor declared by this profile; transitions to or from it are unreachable.`,
        });
      }
    }
  }
}

/** Lint the config knobs: resolve each descriptor, flag duplicates that would silently overwrite an earlier knob, and parse each value. */
function lintConfig(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): void {
  const seen = new Set<string>();
  for (const entry of profile.config) {
    const descriptor = resolveNestedSettingDescriptor(entry.key);
    if (descriptor === undefined) {
      findings.push({
        severity: "error",
        code: "config_key_unknown",
        dimension: "config",
        target: entry.key,
        message: `Config knob "${entry.key}" is not a recognized setting; apply rejects it with a usage error.`,
      });
      continue;
    }
    // Dedupe on the resolved descriptor key so two entries that differ only by
    // alias/casing (e.g. `search-provider` and `search_provider`) are caught.
    if (seen.has(descriptor.key)) {
      findings.push({
        severity: "error",
        code: "config_duplicate",
        dimension: "config",
        target: descriptor.key,
        message: `Config knob "${descriptor.key}" is set more than once; the later value silently overwrites the earlier one.`,
      });
    } else {
      seen.add(descriptor.key);
    }
    const parsed = parseNestedSettingValue(descriptor, entry.value);
    if (!parsed.ok) {
      findings.push({
        severity: "error",
        code: "config_value_invalid",
        dimension: "config",
        target: entry.key,
        message: parsed.error.message,
      });
    }
  }
}

/** Lint the create templates: flag a `type` option referencing an undeclared type. */
function lintTemplates(
  profile: ProjectProfileDefinition,
  declaredTypes: ReadonlySet<string>,
  findings: ProjectProfileLintFinding[],
): void {
  for (const template of profile.templates) {
    const typeOption = template.options.type;
    if (typeof typeOption !== "string" || typeOption.trim().length === 0) {
      continue;
    }
    const typeKey = typeOption.trim().toLowerCase();
    if (!BUILTIN_TYPE_KEYS.has(typeKey) && !declaredTypes.has(typeKey)) {
      findings.push({
        severity: "warning",
        code: "template_type_unknown",
        dimension: "templates",
        target: template.name,
        message: `Template "${template.name}" creates type "${typeOption}" which is neither a built-in type nor declared by this profile.`,
      });
    }
  }
}

/** Lint the advisory package recommendations for an empty spec. */
function lintPackages(
  profile: ProjectProfileDefinition,
  findings: ProjectProfileLintFinding[],
): void {
  for (const [index, recommendation] of profile.packages.entries()) {
    if (recommendation.spec.trim().length === 0) {
      findings.push({
        severity: "warning",
        code: "package_spec_empty",
        dimension: "packages",
        target: `#${index}`,
        message:
          "Package recommendation has an empty spec; it cannot be surfaced as an install hint.",
      });
    }
  }
}

/**
 * Lints a project profile definition for internal consistency, returning every
 * graded finding across all dimensions. Pure and tracker-independent: it never
 * reads disk or settings, so authors can call it on a `defineProjectProfile`
 * value, the CLI can call it on a resolved built-in or extension-contributed
 * profile, and tests can gate against it.
 *
 * @param profile The profile definition to lint.
 * @returns A report whose `ok` flag is true exactly when no `error` findings
 *   were produced.
 */
export function lintProjectProfile(
  profile: ProjectProfileDefinition,
): ProjectProfileLintReport {
  const findings: ProjectProfileLintFinding[] = [];
  lintProfileIdentity(profile, findings);
  const declaredTypes = lintTypes(profile, findings);
  const declaredStatuses = lintStatuses(profile, findings);
  lintFields(profile, findings);
  lintWorkflows(profile, declaredTypes, declaredStatuses, findings);
  lintConfig(profile, findings);
  lintTemplates(profile, declaredTypes, findings);
  lintPackages(profile, findings);
  const errorCount = findings.filter(
    (finding) => finding.severity === "error",
  ).length;
  const warningCount = findings.length - errorCount;
  return {
    profile: profile.name,
    ok: errorCount === 0,
    findings,
    errorCount,
    warningCount,
  };
}
