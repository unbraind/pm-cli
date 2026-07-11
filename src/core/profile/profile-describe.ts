/**
 * @module core/profile/profile-describe
 *
 * Author-time *describe* primitive for a {@link ProjectProfileDefinition}: the
 * project-profile analogue of the extension surface's `describeExtensionBlueprint`.
 * It distills a profile into a deterministic, side-effect-free summary — the
 * per-dimension counts plus the resolved entry identifiers — so the CLI
 * `pm profile show`/`list` formatters and SDK consumers share one source of truth
 * for "what does this profile stage?" rather than each recomputing it inline.
 *
 * Identifier derivation deliberately mirrors what {@link module:core/profile/profile-plan}
 * upserts: item type names, status ids, and field keys all flow through the same
 * `normalizeAddTypeInput` / `normalizeAddStatusInput` / `normalizeAddFieldInput`
 * canonicalization the planner uses, so describe reports the exact ids/keys
 * `pm profile apply` stages (not the author's raw casing/spelling). Workflows,
 * config, templates, and packages surface their authored identity verbatim.
 *
 * Describe is intentionally lenient: it feeds read-only `pm profile show`/`list`,
 * so a semantically-invalid entry from an untrusted extension-contributed profile
 * (a built-in-named or empty type/status/field the normalizer rejects) falls back
 * to its raw identifier rather than throwing — surfacing the actual defect is the
 * job of {@link module:core/profile/profile-lint lintProjectProfile}, not describe.
 */
import { normalizeAddFieldInput } from "../schema/fields-file.js";
import { normalizeAddStatusInput } from "../schema/status-defs-file.js";
import { normalizeAddTypeInput } from "../schema/item-types-file.js";
import type { ProjectProfileDefinition } from "./profile-presets.js";

/** Per-dimension counts summarizing how much a profile stages. */
export interface ProjectProfileComposition {
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

/** A package recommendation distilled to its spec and rationale. */
export interface ProjectProfilePackageSummary {
  /** Catalog alias or install spec. */
  spec: string;
  /** Why the archetype benefits from the package. */
  reason: string;
}

/** Deterministic summary of a profile's composition produced by {@link describeProjectProfile}. */
export interface ProjectProfileDescription {
  /** Profile name. */
  name: string;
  /** Display title. */
  title: string;
  /** One-line archetype summary. */
  summary: string;
  /** Per-dimension counts. */
  composition: ProjectProfileComposition;
  /** Canonical item type names the profile registers. */
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
  packages: ProjectProfilePackageSummary[];
}

/** Computes the per-dimension counts for a profile. */
export function describeProfileComposition(
  profile: ProjectProfileDefinition,
): ProjectProfileComposition {
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
 * Distills a profile definition into a deterministic composition summary. Pure
 * and tracker-independent; the resolved identifiers match exactly what
 * `pm profile apply` stages for each dimension.
 *
 * @param profile The profile definition to describe.
 * @returns The profile's metadata, per-dimension counts, and resolved entry
 *   identifiers.
 */
export function describeProjectProfile(
  profile: ProjectProfileDefinition,
): ProjectProfileDescription {
  return {
    name: profile.name,
    title: profile.title,
    summary: profile.summary,
    composition: describeProfileComposition(profile),
    types: profile.types.map((type) =>
      lenientIdentifier(
        () => normalizeAddTypeInput(type).name,
        () => String(type.name ?? ""),
      ),
    ),
    statuses: profile.statuses.map((status) =>
      lenientIdentifier(
        () => normalizeAddStatusInput(status).id,
        () => String(status.id ?? ""),
      ),
    ),
    fields: profile.fields.map((field) =>
      lenientIdentifier(
        () => normalizeAddFieldInput(field).key,
        () => String(field.key ?? ""),
      ),
    ),
    workflows: profile.workflows.map((workflow) => workflow.type),
    config: profile.config.map((entry) => `${entry.key}=${entry.value}`),
    templates: profile.templates.map((template) => template.name),
    packages: profile.packages.map((recommendation) => ({
      spec: recommendation.spec,
      reason: recommendation.reason,
    })),
  };
}

/**
 * Resolves a dimension entry's identifier through the planner's canonicalizing
 * normalizer so describe reports exactly what `pm profile apply` stages, falling
 * back to the entry's raw identifier when the normalizer rejects a semantically
 * invalid value (a built-in-named or empty type/status/field) — surfacing the
 * defect is the job of {@link module:core/profile/profile-lint}, not describe.
 */
function lenientIdentifier(normalize: () => string, raw: () => string): string {
  try {
    return normalize();
  } catch {
    return raw();
  }
}
