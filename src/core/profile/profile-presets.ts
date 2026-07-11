/**
 * @module core/profile/profile-presets
 *
 * Defines the project-profile model and the first-party archetype presets that
 * compose the existing schema, config, template, and package primitives into a
 * single declarative bundle. A profile is a higher-level customization unit than
 * a {@link TYPE_PRESET_DEFINITIONS type preset}: where a type preset only stages
 * item types, a profile stages item types, custom statuses, custom fields,
 * per-type workflows, configuration knobs, create templates, and recommended
 * packages so a fresh tracker can be tailored to an archetype (agile delivery,
 * operations, or research) in one idempotent `pm profile apply` invocation.
 *
 * The raw type definitions are shared verbatim with {@link TYPE_PRESET_DEFINITIONS}
 * so `pm profile apply agile` registers byte-identical item types to
 * `pm init --type-preset agile` and `pm schema apply-preset agile`. Everything in
 * this module is pure data plus name normalization; the planning and apply logic
 * lives in {@link module:core/profile/profile-plan} and `cli/commands/profile`.
 */
import type { RawAddTypeInput } from "../schema/item-types-file.js";
import type { RawAddStatusInput } from "../schema/status-defs-file.js";
import type { RawAddFieldInput } from "../schema/fields-file.js";
import type { TypeWorkflowDefinition } from "../../types.js";
import { TYPE_PRESET_DEFINITIONS } from "../schema/type-presets.js";

/** Repeatable create-flag values used to stage a profile template. Mirrors the stored-template option shape (`Record<flag, string | string[]>`) accepted by `pm templates save` without importing the CLI module into core. */
export type ProfileTemplateOptions = Readonly<
  Record<string, string | readonly string[]>
>;

/**
 * A single nested-settings knob a profile stages during apply. The `key` is a
 * {@link module:core/config/nested-settings} descriptor key (snake_case) and the
 * `value` is the raw string the descriptor parser coerces into a typed leaf, so
 * profile config reuses exactly the same validation as `pm config set`.
 */
export interface ProfileConfigEntry {
  /** Nested-settings descriptor key, e.g. `search_provider`. */
  key: string;
  /** Raw value parsed by the descriptor (e.g. `"bm25"`, `"20"`). */
  value: string;
  /** Short human-facing rationale surfaced in profile descriptions. */
  summary: string;
}

/** A named create template a profile stages into `<pmRoot>/templates/<name>.json` so operators can immediately `pm create --template <name>`. */
export interface ProfileTemplateEntry {
  /** Template name (matches the `pm templates` naming rules). */
  name: string;
  /** Create-flag option payload stored for the template. */
  options: ProfileTemplateOptions;
}

/** A package the profile recommends but never auto-installs. Apply surfaces these as advisory `pm package install` hints, keeping profile application offline and side-effect-free with respect to the package registry. */
export interface ProfilePackageRecommendation {
  /** Catalog alias or install spec, e.g. `templates` or `npm:@unbrained/pm-templates`. */
  spec: string;
  /** Why this archetype benefits from the package. */
  reason: string;
}

/** The complete declarative definition of a project profile. Every dimension is optional-by-emptiness: an empty array simply stages nothing for that surface. */
export interface ProjectProfileDefinition {
  /** Stable lowercase profile identifier, e.g. `agile`. */
  name: string;
  /** Human-facing display title. */
  title: string;
  /** One-line description of the archetype the profile tailors the tracker for. */
  summary: string;
  /** Item types to upsert (shared with the matching type preset). */
  types: readonly RawAddTypeInput[];
  /** Custom statuses to upsert. */
  statuses: readonly RawAddStatusInput[];
  /** Custom fields to upsert. */
  fields: readonly RawAddFieldInput[];
  /** Per-type workflow transition allow-lists to stage into settings. */
  workflows: readonly TypeWorkflowDefinition[];
  /** Nested-settings knobs to stage. */
  config: readonly ProfileConfigEntry[];
  /** Create templates to stage. */
  templates: readonly ProfileTemplateEntry[];
  /** Advisory package recommendations (never auto-installed). */
  packages: readonly ProfilePackageRecommendation[];
}

/**
 * The shape an extension passes to `api.registerProfile(profile)`.
 *
 * Only `name` and `title` are required; every other dimension is optional and
 * defaults to an empty array (and `summary` to an empty string) during
 * registration, matching the "optional-by-emptiness" model of
 * {@link ProjectProfileDefinition}. The loader normalizes a registration input
 * into a full {@link ProjectProfileDefinition} before storing it, so a sparse
 * `{ name, title }` archetype is a first-class, fully-typed call — no casts —
 * while a complete definition (a built-in or `defineProjectProfile`-typed value)
 * also satisfies it.
 */
export type ProjectProfileRegistrationInput = Pick<
  ProjectProfileDefinition,
  "name" | "title"
> &
  Partial<Omit<ProjectProfileDefinition, "name" | "title">>;

/** Ordered list of first-party profile names. Drives CLI help, completion, contracts, and the `pm profile list` ordering. */
export const PROFILE_NAMES = ["agile", "ops", "research"] as const;
/** Restricts profile name values accepted by command, SDK, and storage contracts. */
export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * First-party archetype profiles. Each composes its matching
 * {@link TYPE_PRESET_DEFINITIONS} entry (so item types stay identical to the
 * standalone type preset) with archetype-appropriate statuses, fields, a primary
 * workflow, offline-friendly search config, a starter template, and package
 * recommendations.
 */
export const BUILTIN_PROFILES: Record<ProfileName, ProjectProfileDefinition> = {
  agile: {
    name: "agile",
    title: "Agile delivery",
    summary:
      "Story/Spike delivery with a review stage, story points, and acceptance ownership.",
    types: TYPE_PRESET_DEFINITIONS.agile,
    statuses: [
      {
        id: "review",
        roles: ["active"],
        aliases: ["in-review"],
        description:
          "Work is implementation-complete and awaiting peer review.",
      },
    ],
    fields: [
      {
        key: "story_points",
        type: "number",
        commands: ["create", "update", "list"],
        description: "Relative estimation size for a story or spike.",
        aliases: ["points"],
      },
      {
        key: "acceptance_owner",
        type: "string",
        commands: ["create", "update", "list"],
        description:
          "Stakeholder accountable for accepting the delivered story.",
        aliases: ["acceptor"],
      },
    ],
    workflows: [
      {
        type: "Story",
        allowed_transitions: [
          ["open", "in_progress"],
          ["in_progress", "review"],
          ["review", "in_progress"],
          ["review", "closed"],
          ["in_progress", "blocked"],
          ["blocked", "in_progress"],
        ],
      },
    ],
    config: [
      {
        key: "search_provider",
        value: "bm25",
        summary:
          "Offline BM25 lexical search works without an embedding service.",
      },
      {
        key: "search_max_results",
        value: "20",
        summary: "Sprint-sized result cap for quick triage.",
      },
    ],
    templates: [
      {
        name: "story",
        options: {
          type: "Story",
          priority: "2",
          tags: "story",
          acceptanceCriteria:
            "Story delivers the stated user outcome with tests and docs updated.",
          body: "## As a\n\n## I want\n\n## So that\n\n## Acceptance\n- [ ] \n",
        },
      },
    ],
    packages: [
      {
        spec: "templates",
        reason: "Reusable create templates for recurring story shapes.",
      },
      { spec: "calendar", reason: "Sprint and iteration scheduling views." },
      {
        spec: "search-advanced",
        reason: "Richer retrieval as the backlog grows.",
      },
    ],
  },
  ops: {
    name: "ops",
    title: "Operations",
    summary:
      "Incident/Runbook response with mitigation and monitoring stages, severity, and service fields.",
    types: TYPE_PRESET_DEFINITIONS.ops,
    statuses: [
      {
        id: "mitigating",
        roles: ["active"],
        aliases: ["mitigation"],
        description: "Active mitigation is underway to restore service.",
      },
      {
        id: "monitoring",
        roles: ["active"],
        aliases: ["observing"],
        description:
          "Mitigation applied; monitoring for recurrence before closure.",
      },
    ],
    fields: [
      {
        key: "severity",
        type: "string",
        commands: ["create", "update", "list"],
        description:
          "Incident severity classification (e.g. sev1, sev2, sev3).",
        aliases: ["sev"],
      },
      {
        key: "service",
        type: "string",
        commands: ["create", "update", "list"],
        description: "Primary affected service or component.",
      },
    ],
    workflows: [
      {
        type: "Incident",
        allowed_transitions: [
          ["open", "mitigating"],
          ["mitigating", "monitoring"],
          ["monitoring", "mitigating"],
          ["monitoring", "closed"],
          ["mitigating", "blocked"],
          ["blocked", "mitigating"],
        ],
      },
    ],
    config: [
      {
        key: "search_provider",
        value: "bm25",
        summary: "Offline BM25 lexical search for fast incident lookup.",
      },
      {
        key: "search_max_results",
        value: "25",
        summary: "Wider result cap to surface related incidents and runbooks.",
      },
    ],
    templates: [
      {
        name: "incident",
        options: {
          type: "Incident",
          priority: "1",
          tags: "incident",
          acceptanceCriteria:
            "Service restored, root cause documented, and follow-ups filed.",
          body: "## Impact\n\n## Timeline\n\n## Root cause\n\n## Mitigation\n\n## Follow-ups\n",
        },
      },
    ],
    packages: [
      {
        spec: "lifecycle-hooks",
        reason:
          "Automate transitions and notifications on incident state changes.",
      },
      {
        spec: "governance-audit",
        reason: "Audit incident metadata completeness and closure quality.",
      },
      { spec: "calendar", reason: "On-call and follow-up scheduling." },
    ],
  },
  research: {
    name: "research",
    title: "Research",
    summary:
      "Experiment/Hypothesis investigation with an analysis stage, hypothesis, and method fields.",
    types: TYPE_PRESET_DEFINITIONS.research,
    statuses: [
      {
        id: "analyzing",
        roles: ["active"],
        aliases: ["analysis"],
        description: "Data collected; analysis and synthesis in progress.",
      },
    ],
    fields: [
      {
        key: "hypothesis",
        type: "string",
        commands: ["create", "update"],
        description: "The testable claim the experiment evaluates.",
      },
      {
        key: "method",
        type: "string",
        commands: ["create", "update", "list"],
        description:
          "Experimental method or protocol used to evaluate the hypothesis.",
        aliases: ["protocol"],
      },
    ],
    workflows: [
      {
        type: "Experiment",
        allowed_transitions: [
          ["open", "in_progress"],
          ["in_progress", "analyzing"],
          ["analyzing", "in_progress"],
          ["analyzing", "closed"],
          ["in_progress", "blocked"],
          ["blocked", "in_progress"],
        ],
      },
    ],
    config: [
      {
        key: "search_provider",
        value: "bm25",
        summary: "Offline BM25 lexical search across the research corpus.",
      },
      {
        key: "search_max_results",
        value: "50",
        summary:
          "Broader recall cap for literature and prior-experiment discovery.",
      },
    ],
    templates: [
      {
        name: "experiment",
        options: {
          type: "Experiment",
          priority: "2",
          tags: "experiment",
          acceptanceCriteria:
            "Hypothesis is supported, rejected, or refined with recorded evidence.",
          body: "## Hypothesis\n\n## Method\n\n## Results\n\n## Conclusion\n",
        },
      },
    ],
    packages: [
      {
        spec: "search-advanced",
        reason: "Semantic retrieval over experiments and findings.",
      },
      {
        spec: "templates",
        reason: "Consistent experiment and hypothesis scaffolds.",
      },
      {
        spec: "beads",
        reason: "Import structured prior work into the tracker.",
      },
    ],
  },
};

/**
 * Validates and normalizes a raw profile-name value. Returns `undefined` when the
 * value is omitted. Throws a plain Error with a stable message for an empty or
 * unknown name; CLI layers map it to a USAGE exit code. Accepts hyphen/underscore
 * and casing variations for ergonomics, mirroring {@link normalizeTypePresetName}.
 */
export function normalizeProfileName(
  rawValue: string | undefined,
): ProfileName | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = normalizeProfileLookupKey(rawValue);
  if (normalized.length === 0) {
    throw new Error("Profile name must not be empty.");
  }
  // Validate against PROFILE_NAMES so adding a profile never drifts from the
  // accepted set (single source of truth shared with BUILTIN_PROFILES).
  if ((PROFILE_NAMES as readonly string[]).includes(normalized)) {
    return normalized as ProfileName;
  }
  throw new Error(
    `Invalid profile "${rawValue}". Allowed: ${PROFILE_NAMES.join(", ")}.`,
  );
}

/**
 * Resolves a built-in profile definition by validated name. Throws (via
 * {@link normalizeProfileName}) when the name is missing or unknown.
 */
export function resolveProfile(
  rawValue: string | undefined,
): ProjectProfileDefinition {
  const name = normalizeProfileName(rawValue);
  if (name === undefined) {
    throw new Error(
      `Profile name is required. Allowed: ${PROFILE_NAMES.join(", ")}.`,
    );
  }
  return BUILTIN_PROFILES[name];
}

/**
 * Returns all built-in profile definitions in {@link PROFILE_NAMES} order. Used by
 * `pm profile list` and SDK consumers enumerating available archetypes.
 */
export function listProfiles(): ProjectProfileDefinition[] {
  return PROFILE_NAMES.map((name) => BUILTIN_PROFILES[name]);
}

/** Whether a resolved profile is core-baked or contributed by an active extension. */
export type ProfileSourceKind = "builtin" | "extension";

/** A profile definition paired with where it came from, returned by the merged `pm profile` resolution so callers can label a profile's origin. */
export interface ResolvedProfile {
  /** The profile definition. */
  definition: ProjectProfileDefinition;
  /** Whether the profile is core-baked or contributed by an active extension. */
  source: ProfileSourceKind;
  /** For an extension profile, the owning package/extension name; absent for builtins. */
  package?: string;
}

/**
 * A profile contributed by an active extension, fed into the merge resolver.
 *
 * This intentionally mirrors the loader's `RegisteredExtensionProjectProfile`
 * without importing `core/extensions` — `extension-types` depends on this module
 * for {@link ProjectProfileDefinition}, so importing back would form a cycle. The
 * CLI maps the active registration registry onto this shape.
 */
export interface ExtensionProfileContribution {
  /** Owning extension/package name, surfaced as the resolved profile's source. */
  name: string;
  /** The profile definition the extension registered. */
  profile: ProjectProfileDefinition;
}

/**
 * Result of {@link resolveProfileCatalog}: the merged profile list plus any
 * non-fatal collisions encountered while merging.
 */
export interface ResolveProfileCatalogResult {
  /** Builtins first (in {@link PROFILE_NAMES} order), then accepted extension profiles in contribution order. */
  profiles: ResolvedProfile[];
  /** Non-fatal merge warnings (built-in shadowing attempts, duplicate names). */
  warnings: string[];
}

/**
 * Result of {@link resolveProfileEntry}: the single resolved profile plus the
 * same non-fatal merge `warnings` {@link resolveProfileCatalog} produced, so
 * `pm profile show`/`apply` surface a shadowed or duplicate extension profile
 * just like `pm profile list` does rather than swallowing it.
 */
export interface ResolveProfileEntryResult {
  /** The resolved profile and its source. */
  resolved: ResolvedProfile;
  /** Non-fatal merge warnings from building the catalog the entry was resolved against. */
  warnings: string[];
}

/**
 * Canonical lookup key for a profile name: trimmed, lowercased, with hyphens
 * folded to underscores. Shared by both sides of every catalog match (and by
 * {@link normalizeProfileName}) so a user can type `my-flow`, `My-Flow`, or
 * `my_flow ` interchangeably. Interior spaces are preserved — only the
 * hyphen/underscore distinction and surrounding whitespace/casing are folded.
 */
export function normalizeProfileLookupKey(rawValue: string): string {
  return rawValue.trim().toLowerCase().replaceAll("-", "_");
}

function formatAvailableProfileNames(
  profiles: readonly ResolvedProfile[],
): string {
  return profiles.map((entry) => entry.definition.name).join(", ");
}

/**
 * Merges the core-baked {@link BUILTIN_PROFILES} with profiles contributed by
 * active extensions into one resolvable catalog.
 *
 * Built-in names are reserved: an extension profile whose normalized name
 * collides with a built-in archetype is dropped with a warning, so a package can
 * never silently shadow a core profile. Two extension profiles that normalize to
 * the same key keep the first contribution and warn on each later duplicate.
 * Builtins always sort first, preserving the established `pm profile list`
 * ordering. Names are non-blank by construction — the loader's
 * `registerProfile` validation rejects an empty `name` before it can reach the
 * registry that feeds this resolver.
 */
export function resolveProfileCatalog(
  contributions: readonly ExtensionProfileContribution[] = [],
): ResolveProfileCatalogResult {
  const profiles: ResolvedProfile[] = PROFILE_NAMES.map((name) => ({
    definition: BUILTIN_PROFILES[name],
    source: "builtin" as const,
  }));
  const builtinKeys = new Set<string>(
    PROFILE_NAMES.map((name) => normalizeProfileLookupKey(name)),
  );
  const seen = new Set<string>(builtinKeys);
  const warnings: string[] = [];
  for (const contribution of contributions) {
    const key = normalizeProfileLookupKey(contribution.profile.name);
    if (builtinKeys.has(key)) {
      warnings.push(
        `Extension "${contribution.name}" profile "${contribution.profile.name}" uses a name reserved by a built-in archetype and was ignored.`,
      );
      continue;
    }
    if (seen.has(key)) {
      warnings.push(
        `Profile "${contribution.profile.name}" from extension "${contribution.name}" duplicates an already-registered profile and was ignored.`,
      );
      continue;
    }
    seen.add(key);
    profiles.push({
      definition: contribution.profile,
      source: "extension",
      package: contribution.name,
    });
  }
  return { profiles, warnings };
}

/**
 * Resolves a single profile by name from the merged catalog (builtins +
 * extension contributions), returning it alongside the catalog's merge warnings.
 * Throws a plain Error with a stable, name-listing message when the value is
 * missing or unknown, so CLI layers map it to a USAGE exit code — the
 * extension-aware counterpart to {@link resolveProfile}.
 */
export function resolveProfileEntry(
  rawValue: string | undefined,
  contributions: readonly ExtensionProfileContribution[] = [],
): ResolveProfileEntryResult {
  const { profiles, warnings } = resolveProfileCatalog(contributions);
  // Treat any non-string name as missing — undefined, null, or a non-string
  // primitive slipping in from an untyped JS caller or parsed payload — so the
  // `.trim()` below never throws.
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new Error(
      `Profile name is required. Allowed: ${formatAvailableProfileNames(profiles)}.`,
    );
  }
  const key = normalizeProfileLookupKey(rawValue);
  const match = profiles.find(
    (entry) => normalizeProfileLookupKey(entry.definition.name) === key,
  );
  if (match === undefined) {
    throw new Error(
      `Invalid profile "${rawValue}". Allowed: ${formatAvailableProfileNames(profiles)}.`,
    );
  }
  return { resolved: match, warnings };
}
