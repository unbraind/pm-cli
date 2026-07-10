import type { ChangelogDocument, ChangelogSelectionReport, ChangelogSummaryEntry, GeneratedChangelog, GenerateChangelogOptions, MergeChangelogOptions, MergeChangelogResult, PmItem, ReadPmItemsOptions, SemverSuggestion, WriteChangelogOptions, WriteChangelogResult } from "./types.js";
export declare function generateChangelog(options: GenerateChangelogOptions): string;
export declare function createChangelog(options: GenerateChangelogOptions): GeneratedChangelog;
/**
 * OPT-IN (`--changelog-json`): build a structured representation of the
 * changelog (releases -> sections -> items) for downstream tooling. This is
 * deliberately distinct from the `--json` CLI summary (action/bytes/changed)
 * and from the `changelog export --format json` payload (which wraps markdown).
 * It applies the same filtering, limiting and grouping as the markdown path so
 * the two stay in sync, but emits structured data instead of rendered text.
 */
export declare function buildChangelogDocument(options: GenerateChangelogOptions): ChangelogDocument;
/**
 * OPT-IN (`--summary`): build a compact one-line-per-change list for quick
 * agent scanning. Reuses the same filtering, section building, visibility
 * narrowing and grouping as the markdown / structured-document paths so the
 * three stay in sync, but emits flat entries instead of rendered text.
 *
 * Each entry carries the release heading, the category or field-group the item
 * was bucketed under, and the item's id/title/type/status. With the default
 * `sectionBy: "category"` the `category` field is the keep-a-changelog category
 * (Added/Changed/Fixed/...); with `sectionBy: "type"` it is the title-cased item
 * type (Feature/Issue/Task/...); with `sectionBy: "label"` an item may appear
 * once per tag.
 */
export declare function createChangelogSummary(options: GenerateChangelogOptions): ChangelogSummaryEntry[];
/**
 * Format a single `--summary` entry as a bracketed text line for quick agent
 * scanning: `[version] category: title (id)`. The version bracket uses the
 * normalized version key when available, otherwise the release heading with
 * its date suffix stripped. Shared by the standalone CLI and the `pm`
 * extension so both render identical summary lines.
 */
export declare function formatSummaryLine(entry: ChangelogSummaryEntry): string;
export declare function mergeChangelog(existingMarkdown: string | undefined, generatedMarkdown: string, options?: MergeChangelogOptions): MergeChangelogResult;
export declare function readPmItems(options?: ReadPmItemsOptions): PmItem[];
export declare function writeChangelog(options: WriteChangelogOptions): WriteChangelogResult;
export declare function parsePmItemsJson(raw: string): PmItem[];
/**
 * OPT-IN (`--suggest-semver`): classify the in-scope items into breaking /
 * feature / fix / other and recommend a semver bump. Emitted as JSON or a
 * footer note; never alters default markdown.
 */
export declare function suggestSemver(options: GenerateChangelogOptions): SemverSuggestion;
/**
 * The items that actually render for the given options: the union of all
 * visible release-section items after filtering, empty-section pruning and
 * `--limit`/`--since-version` narrowing. Exposed so semver suggestions and the
 * structured `--changelog-json` document classify the same set the markdown
 * emits (GH #28).
 */
export declare function visibleChangelogItems(options: GenerateChangelogOptions): PmItem[];
/**
 * OPT-IN (`--explain`): return machine-readable diagnostics showing how input
 * items moved through title/status/time/release-window filters and visibility
 * narrowing (`--limit`/`--since-version`). Designed for agent/operator UX when
 * output is unexpectedly empty or smaller than expected.
 */
export declare function explainChangelogSelection(options: GenerateChangelogOptions): ChangelogSelectionReport;
/** Classify an explicit item set into a semver bump (no option-driven filtering). */
export declare function suggestSemverForItems(items: PmItem[]): SemverSuggestion;
//# sourceMappingURL=generator.d.ts.map