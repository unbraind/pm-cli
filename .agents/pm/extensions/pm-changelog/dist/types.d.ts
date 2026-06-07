export type PmItemStatus = "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft" | string;
export interface PmItem {
    id?: string;
    title: string;
    body?: string;
    /** Long-form prose. In pm workspaces the item body is stored in
     * `description`; `body` is frequently empty. The opt-in `--body-preview`
     * feature falls back to this when `body` is empty. Never affects default
     * output. */
    description?: string;
    status?: PmItemStatus;
    priority?: number;
    type?: string;
    tags?: string[];
    release?: string;
    milestone?: string;
    /** Optional explicit breaking-change flag. Consulted only by the opt-in
     * `--breaking-changes` / `--suggest-semver` features; never affects default
     * output. */
    breaking?: unknown;
    metadata?: Record<string, unknown>;
    url?: string;
    /** Person an item is assigned to. Surfaced in the optional Contributors
     * section (`--contributors`); never affects default output. */
    assignee?: string;
    /** Person who authored an item. Used as a Contributors fallback when no
     * assignee is set. Never affects default output. */
    author?: string;
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
    due_date?: string;
}
export type ChangelogGroupBy = "version" | "release" | "milestone";
/** Within-release grouping selector for the opt-in `--section-by` flag.
 * `"category"` is the default and reproduces the historical
 * keep-a-changelog grouping (Added/Changed/Fixed/...) byte-for-byte. */
export type ChangelogSectionBy = "category" | "type" | "status" | "label";
export interface ChangelogReleaseWindow {
    heading: string;
    /** Git tag name (e.g. "v1.2.0") for this window. When set, items whose
     * `release` field matches this tag are bucketed here regardless of their
     * timestamps, eliminating duplicates from `pm update --release` bumping
     * `updated_at` after the tag was created. */
    releaseTag?: string;
    since?: string;
    sinceExclusive?: boolean;
    until?: string;
}
export interface GenerateChangelogOptions {
    items: PmItem[];
    title?: string;
    version?: string;
    date?: string;
    since?: string;
    until?: string;
    includeStatuses?: string[];
    groupBy?: ChangelogGroupBy;
    releaseWindows?: ChangelogReleaseWindow[];
    includeEmpty?: boolean;
    includeLinks?: boolean;
    /** Base URL used to construct clickable links for pm item IDs.
     * When set, each item ID in the changelog becomes a hyperlink:
     * `[pmc-abc]({itemUrlBase}/pmc-abc.toon)` */
    itemUrlBase?: string;
    /** OPT-IN: within-release grouping. Absent or `"category"` reproduces the
     * historical keep-a-changelog grouping byte-for-byte. */
    sectionBy?: ChangelogSectionBy;
    /** OPT-IN: when true, map category-style headings to Conventional-Commits
     * headings (Features/Bug Fixes/Documentation/...). Only takes effect with
     * the default `sectionBy: "category"` grouping. Absent → headings unchanged. */
    conventional?: boolean;
    /** OPT-IN: append a "Contributors" list per release, derived from item
     * assignee (falling back to author). Absent → no Contributors section. */
    contributors?: boolean;
    /** OPT-IN: keep only the most recent N release sections. Applies only when
     * `releaseWindows` produced the sections. Absent/0 → all releases. */
    limit?: number;
    /** OPT-IN: keep only release sections at or newer than this version.
     * Applies only when `releaseWindows` produced the sections (the `Unreleased`
     * section is always kept). Absent → all releases. */
    sinceVersion?: string;
    /** OPT-IN: when true, emit an extra `### Breaking Changes` group per release
     * listing items detected as breaking (type/tag/title contains "breaking", or
     * a truthy `breaking` flag). Absent → no Breaking Changes section. */
    breakingChanges?: boolean;
    /** OPT-IN: append the first N characters of each item's body/description to
     * its changelog entry (single-lined, escaped). Absent/0 → bodies omitted. */
    bodyPreview?: number;
    /** OPT-IN: prefix category headings with a conventional emoji
     * (Added 🎉, Fixed 🐛, ...). Absent → headings unprefixed. */
    emojiPrefix?: boolean;
    /** OPT-IN: append compact item metadata (`type`, `status`, `priority`,
     * `release`, `milestone`) to each bullet. Absent → metadata omitted. */
    includeMetadata?: boolean;
    /** OPT-IN: include a suggested semver bump in the `--changelog-json`
     * document. Never alters default markdown. Absent → no suggestion emitted. */
    suggestSemver?: boolean;
}
/** A truthy `breaking` flag may live directly on a pm item or in its metadata.
 * Used only by the opt-in `--breaking-changes` / `--suggest-semver` features. */
export interface PmItemBreakingFlag {
    breaking?: unknown;
}
export type SemverBump = "major" | "minor" | "patch" | "none";
/** Result of the opt-in `--suggest-semver` analysis. Emitted as JSON / footer
 * note only; never alters default markdown. */
export interface SemverSuggestion {
    bump: SemverBump;
    reason: string;
    counts: {
        breaking: number;
        feature: number;
        fix: number;
        other: number;
    };
}
export interface GeneratedChangelog {
    markdown: string;
    sections: ChangelogSection[];
    itemCount: number;
}
export type ChangelogOutputMode = "replace" | "prepend";
export type ChangelogMergeAction = "created" | "inserted" | "replaced" | "unchanged";
export interface MergeChangelogOptions {
    title?: string;
}
export interface MergeChangelogResult {
    markdown: string;
    action: ChangelogMergeAction;
    changed: boolean;
}
export interface ReadPmItemsOptions {
    pmRoot?: string;
    pmBin?: string;
    pmArgs?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    /**
     * Pass `--include-body` to `pm list-all --json` so each row carries its body.
     * Required for `--body-preview` to render real body content (GH #27); the
     * field is otherwise omitted from list output.
     */
    includeBody?: boolean;
}
export interface WriteChangelogOptions extends GenerateChangelogOptions {
    output?: string;
    mode?: ChangelogOutputMode;
    check?: boolean;
}
export interface WriteChangelogResult {
    output: string;
    markdown: string;
    action: ChangelogMergeAction;
    changed: boolean;
    itemCount: number;
    bytes: number;
}
export interface ChangelogSection {
    heading: string;
    items: PmItem[];
}
/** A single item as it appears in the structured `--changelog-json` document. */
export interface ChangelogDocumentItem {
    id?: string;
    title: string;
    type?: string;
    status?: string;
    priority?: number;
    tags?: string[];
    release?: string;
    milestone?: string;
    url?: string;
}
/** A heading group (category/type/status/label) within a release. */
export interface ChangelogDocumentSection {
    heading: string;
    items: ChangelogDocumentItem[];
}
/** One release in the structured changelog document. */
export interface ChangelogDocumentRelease {
    heading: string;
    /** Normalized version key (e.g. "1.2.0"), or undefined for Unreleased. */
    version?: string;
    item_count: number;
    sections: ChangelogDocumentSection[];
    /** Present only when `--contributors` is set. */
    contributors?: string[];
    /** Present only when `--breaking-changes` is set: items detected as breaking. */
    breaking_changes?: ChangelogDocumentItem[];
}
/** Structured changelog produced by the opt-in `--changelog-json` flag. */
export interface ChangelogDocument {
    title: string;
    group_by: ChangelogGroupBy;
    section_by: ChangelogSectionBy;
    item_count: number;
    releases: ChangelogDocumentRelease[];
    /** Present only when `--suggest-semver` is set: recommended version bump. */
    suggested_semver?: SemverSuggestion;
}
//# sourceMappingURL=types.d.ts.map